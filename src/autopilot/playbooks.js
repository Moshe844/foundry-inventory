'use strict';

const {newId}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const agent=require('../commercial/agent-plan');
const reports=require('../reports/business-reports');
const jobs=require('../operations/postgres-job-queue');

const steps=new Map([
 ['low-stock',{job:166,label:'Check stock below its reorder point',report:'low-stock'}],
 ['value',{job:106,label:'Calculate current stock value',report:'stock-value'}],
 ['supplier-review',{job:164,label:'Prepare quarterly supplier review figures'}],
 ['combined-stock',{job:125,label:'Summarize stock across owned inventories'}],
]);
const reviews=require('./job-reviews');
for(const d of reviews.definitions.filter(d=>!d.requiresFilter&&!d.requiresChange)){
  steps.set(d.key,{job:d.id,label:d.label,review:true});
}
const limits={growth:10,pro:100,enterprise:Infinity};
// Selecting a read-only review in a saved owner playbook supplies its schedule and scope.
const canRunStep=(plan,s)=>Boolean(s)&&agent.permits(plan,s.job,'automatic',{trained:s.review===true});
const choices=plan=>[...steps].filter(([,s])=>canRunStep(plan,s)).map(([key,s])=>({key,label:s.label}));

async function owner(db,ctx){
  const actor=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.id=$1 AND u.workspace_id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.actorId,ctx.workspaceId])).rows[0];
  if(!actor) throw new AuthorizationError('Only the business owner can manage agent playbooks.');
  return actor;
}
async function authorize(db,ctx,keys){
  const actor=await owner(db,ctx),state=await agent.requireWorkspaceJob(db,ctx.workspaceId,213,'automatic',{trained:true});
  for(const key of keys){
    if(!steps.has(key)) throw new ValidationError('Choose a supported playbook step.');
    const step=steps.get(key);
    agent.requireJob(agent.usesAgentTerms(state)?state.plan:null,step.job,'automatic',{trained:step.review===true});
  }
  return {actor,state};
}
async function create(db,ctx,input){
  const name=String(input.name||'').trim(),keys=input.steps,cadence=input.cadence;
  if(!name || name.length>100 || !Array.isArray(keys) || keys.length<2 || keys.length>steps.size ||
     new Set(keys).size!==keys.length || !['manual','daily','weekly'].includes(cadence))
    throw new ValidationError('Enter a name, choose at least two different steps, and select a schedule.');
  return db.transaction(async client=>{
    const {state}=await authorize(client,ctx,keys);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('playbooks:'||$1,0))",[state.accountId]);
    const count=await client.query(`SELECT count(*) AS n FROM stockchief_runtime.agent_playbooks b JOIN workspaces w ON w.id=b.workspace_id
      WHERE w.owner_account_id=$1 AND w.deletion_requested_at IS NULL`,[state.accountId]);
    if(Number(count.rows[0].n)>=limits[state.plan]) throw new ValidationError(`Your plan includes ${limits[state.plan]} playbooks across your inventories.`);
    const id=newId('playbook');
    await client.query(`INSERT INTO stockchief_runtime.agent_playbooks(id,workspace_id,created_by,name,steps,cadence,next_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,CASE $6 WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '7 days' END)`,
      [id,ctx.workspaceId,ctx.actorId,name,JSON.stringify(keys),cadence]);
    return id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function runStep(db,ctx,actor,key){
  const def=steps.get(key);
  if(def.review){
    const {summary,rows,more}=await reviews.run(db,ctx,key,{scheduled:true,trained:true});
    return {label:def.label,summary:summary+(more?' View the full review for additional records.':''),rows,link:'/autopilot/reviews/'+key};
  }
  if(def.report){
    const output=await reports.run(db,ctx,actor,def.report,{});
    return {label:def.label,summary:output.headline,link:'/reports/business/'+def.report};
  }
  if(key==='supplier-review'){
    const result=await db.query(`WITH quarter AS (SELECT date_trunc('quarter',CURRENT_DATE) AS finish)
      SELECT s.name AS supplier,count(DISTINCT p.id)::integer AS orders,sum(l.quantity_units) AS ordered,
        sum(l.quantity_received_units) AS received,p.currency,sum(l.unit_cost::numeric*l.quantity_units) AS goods_value,
        count(*) FILTER (WHERE l.unit_cost IS NULL) AS lines_without_cost
      FROM purchase_orders p JOIN suppliers s ON s.workspace_id=p.workspace_id AND s.id=p.supplier_id
      JOIN purchase_order_lines l ON l.workspace_id=p.workspace_id AND l.purchase_order_id=p.id CROSS JOIN quarter q
      WHERE p.workspace_id=$1 AND p.ordered_at::timestamptz>=q.finish-interval '3 months'
        AND p.ordered_at::timestamptz<q.finish AND p.status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED')
      GROUP BY s.id,s.name,p.currency ORDER BY s.name,s.id,p.currency`,[ctx.workspaceId]);
    return {label:def.label,summary:'Orders from the last completed calendar quarter, with receipts recorded to date.',rows:result.rows};
  }
  // The same figures as the combined view, kept current by its own routine.
  const rollup=require('../reports/agent-inventory-rollup');
  return {label:def.label,summary:'Stock by inventory, as last updated by the combined view.',rows:await rollup.inventoryRows(db,ctx),link:rollup.href};
}
async function run(db,ctx,id,requestKey){
  if(typeof requestKey!=='string'||!requestKey||requestKey.length>160) throw new ValidationError('A playbook run needs its request reference.');
  return db.transaction(async client=>{
    const b=(await client.query('SELECT * FROM stockchief_runtime.agent_playbooks WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
    if(!b) throw new NotFoundError('This playbook is no longer available.');
    const {actor}=await authorize(client,ctx,b.steps);
    const current=await require('./postgres-service').getState(client,ctx.workspaceId);
    if(current.paused||current.suspended) throw new ValidationError('StockChief is paused.');
    const prior=(await client.query('SELECT result FROM stockchief_runtime.agent_playbook_runs WHERE workspace_id=$1 AND playbook_id=$2 AND request_key=$3',[ctx.workspaceId,id,requestKey])).rows[0];
    if(prior) return prior.result;
    const results=[],scoped={query:client.query.bind(client),transaction:fn=>fn(client)};
    for(const key of b.steps) results.push(await runStep(scoped,ctx,actor,key));
    await client.query('INSERT INTO stockchief_runtime.agent_playbook_runs(id,workspace_id,playbook_id,request_key,result) VALUES($1,$2,$3,$4,$5::jsonb)',
      [newId('playrun'),ctx.workspaceId,id,requestKey,JSON.stringify(results)]);
    return results;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function schedule(client){
  const due=await client.query(`SELECT * FROM stockchief_runtime.agent_playbooks WHERE next_at<=now()
    ORDER BY next_at,id LIMIT 50 FOR UPDATE SKIP LOCKED`);
  const scoped={query:client.query.bind(client),transaction:fn=>fn(client)};
  for(const b of due.rows){
    const key=b.id+'/'+b.next_at.toISOString();
    await jobs.enqueue(scoped,{kind:'agent.playbook',workspaceId:b.workspace_id,idempotencyKey:key,payload:{id:b.id,actorId:b.created_by,key}});
    await client.query("UPDATE stockchief_runtime.agent_playbooks SET next_at=now()+CASE cadence WHEN 'daily' THEN interval '1 day' ELSE interval '7 days' END WHERE id=$1",[b.id]);
  }
}
async function list(db,ctx){
  await owner(db,ctx);
  const state=await agent.accountState(db,ctx.workspaceId);
  const tier=agent.usesAgentTerms(state)?state.plan:null;
  const records=await db.query(`SELECT b.*,r.result,r.created_at AS ran_at FROM stockchief_runtime.agent_playbooks b
    LEFT JOIN LATERAL (SELECT * FROM stockchief_runtime.agent_playbook_runs WHERE workspace_id=b.workspace_id AND playbook_id=b.id ORDER BY created_at DESC LIMIT 1) r ON true
    WHERE b.workspace_id=$1 ORDER BY b.created_at,b.id`,[ctx.workspaceId]);
  return {choices:choices(tier),enabled:agent.permits(tier,213,'automatic',{trained:true}),books:records.rows.map(b=>({...b,
    result:b.steps.every(key=>canRunStep(tier,steps.get(key)))&&agent.permits(tier,213,'automatic',{trained:true})?b.result:null}))};
}
async function remove(db,ctx,id){
  await owner(db,ctx);
  await db.query('DELETE FROM stockchief_runtime.agent_playbooks WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id]);
}
module.exports={create,run,schedule,list,remove};
