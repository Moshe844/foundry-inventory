'use strict';

// Job 213: runs your custom playbooks (multi-step jobs), on a schedule too.
//
// A playbook is the owner's list of steps, run in order by hand or every day
// or week. A step is either a review (a read-only agent review or report) or
// a piece of work: the routine of another agent job, run now through that
// job's own service. A work step takes only the steps its own job may take on
// this plan, inside the owner's limits for that job, with that job's audit,
// undo and Needs you entries. Pro and Custom may use any step their plan
// allows; Growth playbooks run only steps a Growth owner can teach.
//
// Each step's result is checked before the next one starts. The run stops and
// asks when a step fails or leaves work for a person: anything over a limit,
// first-time suppliers, prices, write-offs and the rest of the "always needs a
// person" list stay drafts in Needs you, and the run waits there until the
// owner continues it. A scheduled run keeps to the account's first 14 days,
// pause, Watch only and Ask me first: work steps wait while StockChief only
// watches or the job is set to Watch only, and a playbook set to Ask me first
// waits for the owner to start each scheduled run. Every step is audited, and
// running the same run again continues where it stopped instead of repeating
// finished steps.

const {newId}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError,DomainError}=require('../domain/errors');
const agent=require('../commercial/agent-plan');
const reports=require('../reports/business-reports');
const jobs=require('../operations/postgres-job-queue');
const audit=require('../operations/postgres-security-audit');

const JOB=213,path='/autopilot/playbooks';
const runs='stockchief_runtime.agent_playbook_runs',books='stockchief_runtime.agent_playbooks';
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
// Work steps. Each names its job's own routine and how to read its result:
// what it finished on its own and what it left for a person.
const work=[
 ['take-slow-stock-steps',{job:9,label:'Take slow stock steps: moves, returns and clearance plans',module:'../forecasting/agent-slow-stock-steps',
   done:r=>r.done,waiting:r=>r.draft+r.held}],
 ['fix-product-data',{job:126,label:'Fix product data: duplicates, missing costs and weights',module:'../catalog/agent-catalog-fixes',
   done:r=>r.done,waiting:r=>r.draft+r.held}],
 ['sort-new-products',{job:131,label:'Put new products into categories and tags',module:'../catalog/agent-product-classification',
   done:r=>r.done,waiting:r=>r.suggested+r.waiting}],
 ['retire-discontinued-products',{job:132,label:'Retire discontinued products',module:'../catalog/agent-retirement-work',
   done:r=>r.retired+r.sellingDown+r.finished,waiting:r=>r.drafted}],
 ['warn-before-expiry',{job:191,label:'Warn about stock close to its expiry date',module:'../operations/agent-expiry-warnings',operation:'suggest',
   done:r=>r.raised,waiting:()=>0}],
 ['add-landed-costs',{job:49,label:'Add freight, duty and fees to stock cost',module:'../accounting/agent-landed-cost-bills',
   done:r=>r.posted,waiting:r=>r.review+r.held}],
];
for(const [key,s] of work)steps.set(key,{...s,work:true});
const limits={growth:10,pro:100,enterprise:Infinity};
const count=value=>Number.isFinite(Number(value))?Number(value):0;

// Growth playbooks run only steps the owner can teach on Growth. On Pro and
// Custom a work step needs its own job on the plan; its routine then decides
// what it may finish alone.
function stepOperation(plan,s){
  if(!s.work)return ['automatic',{trained:s.review===true}];
  return plan==='growth'?['automatic',{trained:true}]:[s.operation||'draft',{}];
}
const canRunStep=(plan,s)=>Boolean(s)&&agent.permits(plan,s.job,...stepOperation(plan,s));
const choices=plan=>[...steps].filter(([,s])=>canRunStep(plan,s)).map(([key,s])=>({key,label:s.label,work:s.work===true}));

async function owner(db,ctx){
  const actor=(await db.query(`SELECT u.* FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE u.id=$1 AND u.workspace_id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL`,[ctx.actorId,ctx.workspaceId])).rows[0];
  if(!actor) throw new AuthorizationError('Only the business owner can manage agent playbooks.');
  return actor;
}
async function authorize(db,ctx,keys){
  const actor=await owner(db,ctx),state=await agent.requireWorkspaceJob(db,ctx.workspaceId,JOB,'automatic',{trained:true});
  for(const key of keys){
    if(!steps.has(key)) throw new ValidationError('Choose a supported playbook step.');
    const step=steps.get(key),plan=agent.usesAgentTerms(state)?state.plan:null;
    agent.requireJob(plan,step.job,...stepOperation(plan,step));
  }
  return {actor,state};
}
async function create(db,ctx,input){
  const name=String(input.name||'').trim(),keys=[].concat(input.steps||[]),cadence=input.cadence;
  if(!name || name.length>100 || keys.length<2 || keys.length>steps.size ||
     new Set(keys).size!==keys.length || !['manual','daily','weekly'].includes(cadence))
    throw new ValidationError('Enter a name, choose at least two different steps, and select a schedule.');
  return db.transaction(async client=>{
    const {state}=await authorize(client,ctx,keys);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('playbooks:'||$1,0))",[state.accountId]);
    const count=await client.query(`SELECT count(*) AS n FROM ${books} b JOIN workspaces w ON w.id=b.workspace_id
      WHERE w.owner_account_id=$1 AND w.deletion_requested_at IS NULL`,[state.accountId]);
    if(Number(count.rows[0].n)>=limits[state.plan]) throw new ValidationError(`Your plan includes ${limits[state.plan]} playbooks across your inventories.`);
    const id=newId('playbook');
    await client.query(`INSERT INTO ${books}(id,workspace_id,created_by,name,steps,cadence,next_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,CASE $6 WHEN 'daily' THEN now()+interval '1 day' WHEN 'weekly' THEN now()+interval '7 days' END)`,
      [id,ctx.workspaceId,ctx.actorId,name,JSON.stringify(keys),cadence]);
    await audit.record(client,ctx,{action:'Playbook saved',reference:name,after:{id,steps:keys,cadence}});
    return id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// A work step runs its job's routine now and reports what it finished and
// what it left for a person.
async function runWork(db,ctx,key,def){
  const routine=require(def.module);
  const raw=await routine.run({workspaceId:ctx.workspaceId,kind:routine.kind,payload:{requestedBy:ctx.actorId,playbook:true}},db);
  if(!raw||raw.skipped)return {label:def.label,step:key,outcome:'failed',link:routine.path,
    summary:'This step did not run. Its job is not available to this inventory right now.'};
  const done=count(def.done(Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,count(v)])))),
    waiting=count(def.waiting(Object.fromEntries(Object.entries(raw).map(([k,v])=>[k,count(v)]))));
  return {label:def.label,step:key,outcome:waiting?'waiting':'done',done,waiting,link:routine.path,
    summary:(done?done+' done on its own':'Nothing to do on its own')+(waiting?', '+waiting+' waiting for a person in Needs you.':'.')};
}
async function runStep(db,ctx,actor,key){
  const def=steps.get(key);
  if(def.work)return runWork(db,ctx,key,def);
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

async function jobMode(db,workspaceId,job){
  return (await db.query('SELECT mode FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[workspaceId,job])).rows[0]?.mode||'inherit';
}
// Why a work step may not run now. Reviews only read, so they always run.
async function stepHold(db,workspaceId,state,def){
  if(state.shadow)return agent.SHADOW_REASON;
  const config=(await db.query('SELECT mode FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(config?.mode==='OBSERVE')return 'StockChief is in watch-only mode, so it changes nothing.';
  if(await jobMode(db,workspaceId,JOB)==='watch')return 'Playbooks are set to Watch only, so their work steps do not run.';
  return require('./job-modes').restriction(db,workspaceId,def.job,false);
}
const today=(db,workspaceId)=>require('../lib/business-time').today(db,workspaceId);
async function notice(db,workspaceId,runId,open){
  if(open){
    const day=await today(db,workspaceId);
    await db.query(`INSERT INTO stockchief_runtime.agent_operational_notices(workspace_id,job_id,kind,reference,link,due,last_reminded)
      VALUES($1,213,'Playbook',$2,$3,$4::date,$4::date) ON CONFLICT(workspace_id,job_id,kind,reference,link) DO UPDATE SET resolved=false`,
    [workspaceId,runId,path,day]);
  }else await db.query(`UPDATE stockchief_runtime.agent_operational_notices SET resolved=true WHERE workspace_id=$1 AND job_id=213 AND reference=$2 AND NOT resolved`,
    [workspaceId,runId]);
}

// The run stops at a step with its reason and asks in Needs you. A failed or
// held step runs again on Continue; work left for a person is done there, so
// Continue goes on with the next step.
async function stop(db,ctx,book,run,results,nextStep,reason){
  await db.transaction(async c=>{
    await c.query(`UPDATE ${runs} SET status='STOPPED',next_step=$3,reason=$4,result=$5::jsonb,claimed_until=NULL,updated_at=now()
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.id,nextStep,String(reason).slice(0,1000),JSON.stringify(results)]);
    await notice(c,ctx.workspaceId,run.id,true);
    await audit.record(c,ctx,{action:'Playbook stopped',reference:book.name,after:{run:run.id,step:nextStep+1,reason}});
  },{isolation:'READ COMMITTED'});
  return results;
}
async function advance(db,ctx,book,run,actor,state){
  const results=[...(run.result||[])];
  try{
    for(let index=Number(run.next_step)||0;index<book.steps.length;index++){
      const key=book.steps[index],def=steps.get(key);
      if(def.work){
        const hold=await stepHold(db,ctx.workspaceId,state,def);
        if(hold)return await stop(db,ctx,book,run,results,index,'Step '+(index+1)+' waits: '+hold);
      }
      let result;
      try{result=await runStep(db,ctx,actor,key);}
      catch(error){
        if(!(error instanceof DomainError)||error.status>=500)throw error;
        await audit.record(db,ctx,{action:'Playbook step failed',reference:book.name,after:{run:run.id,step:index+1,key,problem:error.message}});
        return await stop(db,ctx,book,run,results,index,'Step '+(index+1)+' ('+def.label+') stopped: '+error.message);
      }
      if(result.outcome!=='failed')results.push(result);
      await db.transaction(async c=>{
        if(result.outcome!=='failed')await c.query(`UPDATE ${runs} SET next_step=$3,result=$4::jsonb,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
          [ctx.workspaceId,run.id,index+1,JSON.stringify(results)]);
        await audit.record(c,ctx,{action:'Playbook step run',reference:book.name,after:{run:run.id,step:index+1,key,
          outcome:result.outcome||'done',...(def.work?{done:result.done||0,waiting:result.waiting||0}:{rows:result.rows?.length??null})}});
      },{isolation:'READ COMMITTED'});
      if(result.outcome==='failed')return await stop(db,ctx,book,run,results,index,'Step '+(index+1)+' ('+def.label+'): '+result.summary);
      if(result.outcome==='waiting')return await stop(db,ctx,book,run,results,index+1,
        'Step '+(index+1)+' ('+def.label+') left '+result.waiting+(result.waiting===1?' item':' items')+' for a person. Deal with '+(result.waiting===1?'it':'them')+' in Needs you, then continue.');
    }
    await db.transaction(async c=>{
      await c.query(`UPDATE ${runs} SET status='DONE',reason=NULL,claimed_until=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,run.id]);
      await notice(c,ctx.workspaceId,run.id,false);
    },{isolation:'READ COMMITTED'});
    return results;
  }catch(error){
    await db.query(`UPDATE ${runs} SET claimed_until=NULL WHERE workspace_id=$1 AND id=$2 AND status='RUNNING'`,[ctx.workspaceId,run.id]);
    throw error;
  }
}

async function loadBook(db,ctx,id){
  const b=(await db.query(`SELECT * FROM ${books} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!b) throw new NotFoundError('This playbook is no longer available.');
  return b;
}
async function assertRunning(db,workspaceId){
  const current=await require('./postgres-service').getState(db,workspaceId);
  if(current.paused||current.suspended) throw new ValidationError('StockChief is paused.');
}

async function run(db,ctx,id,requestKey,{scheduled=false}={}){
  if(typeof requestKey!=='string'||!requestKey||requestKey.length>160) throw new ValidationError('A playbook run needs its request reference.');
  const b=await loadBook(db,ctx,id);
  const {actor,state}=await authorize(db,ctx,b.steps);
  await assertRunning(db,ctx.workspaceId);
  // One run per request: it is created once, claimed by one worker at a time,
  // and a finished or stopped run answers with what it already did.
  const claimed=await db.transaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['playbook-run:'+ctx.workspaceId+':'+b.id+':'+requestKey]);
    const prior=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND playbook_id=$2 AND request_key=$3 FOR UPDATE`,[ctx.workspaceId,b.id,requestKey])).rows[0];
    if(prior){
      if(prior.status!=='RUNNING'||prior.claimed_until&&prior.claimed_until>new Date())return {run:prior,claimed:false};
      return {run:(await c.query(`UPDATE ${runs} SET claimed_until=now()+interval '15 minutes' WHERE id=$1 RETURNING *`,[prior.id])).rows[0],claimed:true};
    }
    // A playbook set to Ask me first waits for the owner to start each scheduled run.
    const ask=scheduled&&await jobMode(c,ctx.workspaceId,JOB)==='ask';
    const row=(await c.query(`INSERT INTO ${runs}(id,workspace_id,playbook_id,request_key,result,status,scheduled,actor_id,reason,claimed_until)
      VALUES($1,$2,$3,$4,'[]'::jsonb,$5,$6,$7,$8,CASE WHEN $5='RUNNING' THEN now()+interval '15 minutes' END) RETURNING *`,
    [newId('playrun'),ctx.workspaceId,b.id,requestKey,ask?'WAITING':'RUNNING',scheduled,ctx.actorId,
      ask?'Playbooks are set to Ask me first. Start this run when you are ready.':null])).rows[0];
    if(ask){
      await notice(c,ctx.workspaceId,row.id,true);
      await audit.record(c,ctx,{action:'Playbook waiting for the owner',reference:b.name,after:{run:row.id}});
    }
    return {run:row,claimed:!ask};
  },{isolation:'READ COMMITTED'});
  if(!claimed.claimed){
    if(claimed.run.status==='WAITING'&&!(claimed.run.result||[]).length)return {held:true,reason:claimed.run.reason};
    return claimed.run.result;
  }
  return advance(db,ctx,b,claimed.run,actor,state);
}

// The owner continues a stopped run, or starts one waiting for them.
async function resume(db,ctx,runId){
  const row=(await db.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,String(runId||'')])).rows[0];
  if(!row)throw new NotFoundError('This playbook run is no longer available.');
  const b=await loadBook(db,ctx,row.playbook_id);
  const {actor,state}=await authorize(db,ctx,b.steps);
  await assertRunning(db,ctx.workspaceId);
  const claimed=(await db.query(`UPDATE ${runs} SET status='RUNNING',reason=NULL,claimed_until=now()+interval '15 minutes',updated_at=now()
    WHERE workspace_id=$1 AND id=$2 AND status IN ('STOPPED','WAITING') RETURNING *`,[ctx.workspaceId,row.id])).rows[0];
  if(!claimed)return {results:row.result,replayed:true};
  await audit.record(db,ctx,{action:'Playbook continued',reference:b.name,after:{run:row.id,step:Number(row.next_step)+1}});
  return {results:await advance(db,ctx,b,claimed,actor,state),replayed:false};
}

async function schedule(client){
  const due=await client.query(`SELECT * FROM ${books} WHERE next_at<=now()
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
  const tier=agent.usesAgentTerms(state)?state.plan:null,enabled=agent.permits(tier,JOB,'automatic',{trained:true});
  const records=await db.query(`SELECT b.*,r.id AS run_id,r.result,r.status AS run_status,r.reason AS run_reason,r.next_step,r.scheduled AS run_scheduled,
      r.created_at AS ran_at,r.updated_at AS run_updated_at FROM ${books} b
    LEFT JOIN LATERAL (SELECT * FROM ${runs} WHERE workspace_id=b.workspace_id AND playbook_id=b.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
    WHERE b.workspace_id=$1 ORDER BY b.created_at,b.id`,[ctx.workspaceId]);
  return {choices:choices(tier),enabled,limit:limits[tier]??null,books:records.rows.map(b=>{
    const allowed=b.steps.every(key=>canRunStep(tier,steps.get(key)))&&enabled;
    return {...b,labels:b.steps.map(key=>steps.get(key)?.label||key),result:allowed?b.result:null,
      run:allowed&&b.run_id?{id:b.run_id,status:b.run_status,reason:b.run_reason,nextStep:Number(b.next_step),scheduled:b.run_scheduled,
        at:b.run_updated_at,open:['STOPPED','WAITING'].includes(b.run_status)}:null};
  })};
}
async function remove(db,ctx,id){
  await owner(db,ctx);
  await db.transaction(async c=>{
    const b=(await c.query(`DELETE FROM ${books} WHERE workspace_id=$1 AND id=$2 RETURNING name`,[ctx.workspaceId,String(id||'')])).rows[0];
    if(!b)return;
    await c.query(`UPDATE stockchief_runtime.agent_operational_notices n SET resolved=true WHERE n.workspace_id=$1 AND n.job_id=213 AND NOT n.resolved
      AND NOT EXISTS(SELECT 1 FROM ${runs} r WHERE r.workspace_id=n.workspace_id AND r.id=n.reference)`,[ctx.workspaceId]);
    await audit.record(c,ctx,{action:'Playbook deleted',reference:b.name,after:{id}});
  },{isolation:'READ COMMITTED'});
}
module.exports={JOB,path,steps,create,run,resume,schedule,list,remove};
