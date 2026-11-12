'use strict';

// Job 65: shares scarce stock between open orders by the owner's own rules.
// A product is scarce at a warehouse when its open orders wait for more than
// is free there. The owner ranks orders by customer tier, promised date, order
// date or order priority, and chooses to complete whole orders first or to
// share stock across orders. A split can move stock from a lower-ranked order
// to a higher-ranked one, but never from an order that is being picked, packed
// or has shipped. Pro proposes each split until the owner approves one under
// the current rules and teaches it; Custom applies splits on its own. Every
// applied split is logged and can be undone.
const {ValidationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const planning=require('./backorder-plan');
const native=require('./postgres-order-allocations');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const {hash}=require('../pricing/postgres-promotions');
const JOB=65,ACTION='sales_order.share_scarce_stock',href='/autopilot/stock-sharing';
const rulesTable='stockchief_runtime.agent_stock_sharing_rules',tiers='stockchief_runtime.agent_customer_tiers',runs='stockchief_runtime.agent_backorder_runs';
const CRITERIA={tier:'coalesce(tier.tier,99)',promised:'o.needed_by NULLS LAST',ordered:'o.order_date,o.created_at',priority:'o.allocation_priority'};
const LABELS={tier:'Customer tier',promised:'Promised date',ordered:'Order date',priority:'Order priority'};
const TIER_JOIN='LEFT JOIN stockchief_runtime.agent_customer_tiers tier ON tier.workspace_id=o.workspace_id AND tier.customer_id=o.customer_id';
// Orders that hold plain reserved stock at the warehouse are part of the share.
const HOLDS=` OR EXISTS(SELECT 1 FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id
  AND a.location_id=$2 AND to_jsonb(a)->>'rotation_selection' IS NULL)`;
const backorders=()=>require('./agent-backorders');
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const rank=criteria=>[...criteria.map(c=>CRITERIA[c]),'o.created_at','o.id'].join(',');

async function read(c,workspaceId,{lock=false}={}){
  return (await c.query(`SELECT * FROM ${rulesTable} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
function included(state){return policy.usesAgentTerms(state)&&policy.permits(state.plan,JOB,'draft');}

// Work out the owner's split for every scarce product at one warehouse.
async function split(c,ctx,locationId,rules){
  const place=await planning.location(c,ctx,locationId);
  const skus=await planning.waitingSkus(c,ctx,place.id),free=await planning.free(c,ctx,place.id,skus);
  const list=await planning.orders(c,ctx,place.id,skus,{rank:rank(rules.criteria),join:TIER_JOIN,extra:HOLDS});
  for(const o of list){
    // Stock is only ever taken back from an order nobody has started to pick or ship.
    o.donor=!o.hold&&!o.boxed&&o.status!=='PARTIALLY_FULFILLED'&&o.lines.every(l=>l.fulfilled===0);
    for(const l of o.lines){l.movable=o.donor&&l.supported?l.plain:0;l.need=Math.max(0,l.remaining-(l.allocated-l.movable));}
  }
  const ready=list.filter(o=>!o.hold),pool=new Map(skus.map(id=>[id,free.get(id)||0])),demand=new Map(skus.map(id=>[id,0]));
  for(const o of ready)for(const l of o.lines){
    if(!l.supported||!pool.has(l.skuId))continue;
    pool.set(l.skuId,pool.get(l.skuId)+l.movable);demand.set(l.skuId,demand.get(l.skuId)+l.need);
  }
  const scarce=new Set(skus.filter(id=>demand.get(id)>pool.get(id)));
  const left=new Map([...scarce].map(id=>[id,pool.get(id)])),target=new Map();
  const scarceLines=o=>o.lines.filter(l=>l.supported&&scarce.has(l.skuId)&&l.need>0);
  if(rules.fill==='complete')for(const o of ready){
    const lines=scarceLines(o);
    if(!lines.length||!lines.every(l=>l.need<=left.get(l.skuId)))continue;
    for(const l of lines){target.set(l.lineId,l.need);left.set(l.skuId,left.get(l.skuId)-l.need);}
  }
  for(const o of ready)for(const l of scarceLines(o)){
    const have=target.get(l.lineId)||0,give=Math.min(l.need-have,left.get(l.skuId));
    if(give>0){target.set(l.lineId,have+give);left.set(l.skuId,left.get(l.skuId)-give);}
  }
  const changes=[];
  for(const o of ready){
    const lines=[];let complete=true;
    for(const l of o.lines){
      const kept=l.allocated-l.movable,after=l.supported&&scarce.has(l.skuId)?kept+(target.get(l.lineId)||0):l.allocated;
      if(after<l.remaining)complete=false;
      if(after!==l.allocated)lines.push({lineId:l.lineId,skuId:l.skuId,code:l.code,unit:l.unit,from:l.allocated,to:after,delta:after-l.allocated,remaining:l.remaining});
    }
    if(lines.length)changes.push({orderId:o.id,orderNumber:o.order_number,customer:o.customer,tier:o.tier??null,version:o.version,
      neededBy:o.needed_by||null,orderDate:o.order_date,priority:Number(o.allocation_priority),lines,complete,
      gives:lines.reduce((n,l)=>n+Math.max(0,l.delta),0),takes:lines.reduce((n,l)=>n+Math.max(0,-l.delta),0)});
  }
  const codes=new Map(list.flatMap(o=>o.lines.map(l=>[l.skuId,l.code])));
  const held=list.filter(o=>o.hold&&o.lines.some(l=>scarce.has(l.skuId)&&l.waiting>0)).map(o=>({orderId:o.id,orderNumber:o.order_number,customer:o.customer,reason:o.hold}));
  const result={location:place,criteria:rules.criteria,fill:rules.fill,revision:rules.revision,scarce,
    skus:[...scarce].map(id=>({skuId:id,code:codes.get(id),free:free.get(id),pool:pool.get(id),demand:demand.get(id)})),
    changes,held,units:changes.reduce((n,ch)=>n+ch.gives,0),taken:changes.reduce((n,ch)=>n+ch.takes,0),
    ranked:ready.filter(o=>o.lines.some(l=>scarce.has(l.skuId))).map(o=>o.id)};
  result.fingerprint=hash({location:place.id,rules:[rules.criteria,rules.fill,rules.revision],changes:changes.map(ch=>[ch.orderId,ch.version,ch.lines.map(l=>[l.lineId,l.delta])]),
    free:result.skus.map(s=>[s.skuId,s.free]),held:held.map(h=>[h.orderId,h.reason])});
  return result;
}
// What is stored with a run: the scarce set is recomputed when needed.
const stored=({scarce,...p})=>p;

// Products whose scarce stock these rules decide; job 64 leaves them alone.
async function deferred(c,ctx,state,locationId){
  if(!included(state))return new Set();
  const rules=await read(c,ctx.workspaceId);
  if(!rules?.enabled)return new Set();
  return (await split(c,ctx,locationId,rules)).scarce;
}

async function apply(c,ctx,p,runId){
  const versions=new Map();
  for(const ch of p.changes){
    const take=ch.lines.filter(l=>l.delta<0);if(!take.length)continue;
    const done=await native.giveBack(c,ctx,ch.orderId,{expectedVersion:ch.version,idempotencyKey:'share:'+runId+':take:'+ch.orderId,
      lines:take.map(l=>({lineId:l.lineId,locationId:p.location.id,quantity:-l.delta})),detail:{job:JOB,runId,rules:p.revision}});
    versions.set(ch.orderId,done.version);
  }
  for(const ch of p.changes){
    const give=ch.lines.filter(l=>l.delta>0);if(!give.length)continue;
    await native.setAside(c,ctx,ch.orderId,{expectedVersion:versions.get(ch.orderId)??ch.version,idempotencyKey:'share:'+runId+':give:'+ch.orderId,
      lines:give.map(l=>({lineId:l.lineId,locationId:p.location.id,quantity:l.delta})),detail:{job:JOB,runId,rules:p.revision}});
  }
}

async function taughtExample(c,ctx,rules){
  if(!rules.taught_run_id||rules.taught_revision!==rules.revision)return null;
  return (await c.query(`SELECT id FROM ${runs} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 AND status='APPLIED'
    AND authorization_kind='INDIVIDUAL' AND applied_by=$4 AND rule_revision=$5`,[ctx.workspaceId,rules.taught_run_id,JOB,ctx.actorId,rules.revision])).rows[0]||null;
}
async function automaticStop(c,ctx,state,rules,p){
  const trained=policy.allowance(state.plan,JOB)==='trained';
  if(!rules.automatic)return trained?'Approve one split under these rules, then teach StockChief to share stock like that on its own.':'Turn on sharing on its own to let StockChief apply these splits.';
  if(rules.authorized_by!==ctx.actorId)return 'The current owner must confirm these sharing rules.';
  if(trained&&!await taughtExample(c,ctx,rules))return 'Approve one split under these rules, then teach StockChief to share stock like that on its own.';
  if(!policy.permits(state.plan,JOB,'automatic',{trained:true}))return 'Your plan proposes each split for approval.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'Automatic work is off for this inventory. Approve this split yourself.';
  if(p.units>rules.max_units)return 'This split sets aside '+p.units+' units, more than your limit of '+rules.max_units+'.';
  return null;
}

// Called by the backorder routine for one warehouse, under its warehouse lock.
async function handle(c,ctx,state,locationId){
  if(!included(state))return {};
  const rules=await read(c,ctx.workspaceId);
  if(!rules?.enabled)return {};
  if(await policy.stopped(c,ctx.workspaceId,state,ACTION,false))return {watching:true};
  const p=await split(c,ctx,locationId,rules);
  if(!p.changes.length)return {};
  const why=await automaticStop(c,ctx,state,rules,p);
  if(why)return {drafted:(await backorders().draft(c,ctx,stored(p),why,{jobId:JOB,ruleRevision:rules.revision})).created};
  const row=await backorders().insert(c,ctx,{status:'APPLIED',kind:'AUTOMATIC',p:stored(p),requestKey:'share:'+p.location.id+':'+p.fingerprint,ruleRevision:rules.revision,jobId:JOB});
  if(!row)return {replayed:true};
  await c.query(`UPDATE ${runs} SET status='STALE' WHERE workspace_id=$1 AND job_id=$2 AND location_id=$3 AND status='DRAFT'`,[ctx.workspaceId,JOB,p.location.id]);
  await apply(c,ctx,p,row.id);
  await audit.record(c,ctx,{action:'StockChief shared scarce stock by your rules',reference:row.id,
    after:{location:p.location.id,rules:rules.revision,changes:p.changes.map(ch=>[ch.orderNumber,ch.gives-ch.takes]),limit:rules.max_units}});
  return {applied:true};
}

async function prepare(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    const rules=await read(c,ctx.workspaceId);
    if(!rules?.enabled)throw new ValidationError('Save your sharing rules first.');
    const place=await planning.location(c,ctx,input.locationId);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['backorders:'+ctx.workspaceId+':'+place.id]);
    const p=await split(c,ctx,place.id,rules);
    if(!p.changes.length)throw new ValidationError('Stock at '+place.name+' is already shared by your rules.');
    return backorders().draft(c,ctx,stored(p),'Prepared on request.',{jobId:JOB,ruleRevision:rules.revision});
  });
}

async function approveLocked(c,ctx,r,input){
  const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
  if(stop)throw new ValidationError(stop);
  if(r.status==='APPLIED')return {id:r.id,replayed:true};
  if(r.status!=='DRAFT')throw new ValidationError('This split is no longer waiting for approval. Review the current stock.');
  if(input.confirmed!=='yes'||input.fingerprint!==r.fingerprint)throw new ValidationError('Review and approve this exact split.');
  const rules=await read(c,ctx.workspaceId);
  if(!rules?.enabled)throw new ValidationError('Your sharing rules are off. Turn them on before sharing stock.');
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['backorders:'+ctx.workspaceId+':'+r.location_id]);
  const p=await split(c,ctx,r.location_id,rules);
  if(p.fingerprint!==r.fingerprint){
    await c.query(`UPDATE ${runs} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    const next=p.changes.length?await backorders().draft(c,ctx,stored(p),'Stock, orders or rules changed after the earlier split.',{jobId:JOB,ruleRevision:rules.revision}):null;
    return {id:r.id,stale:true,next:next?.id||null};
  }
  await apply(c,ctx,p,r.id);
  await c.query(`UPDATE ${runs} SET status='APPLIED',authorization_kind='INDIVIDUAL',applied_by=$3,applied_at=now(),rule_revision=$4 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,r.id,ctx.actorId,rules.revision]);
  await audit.record(c,ctx,{action:'Approved a scarce stock split',reference:r.id,after:{location:p.location.id,rules:rules.revision,changes:p.changes.map(ch=>[ch.orderNumber,ch.gives-ch.takes])}});
  return {id:r.id,applied:true};
}

// Undo gives the stock back to the orders it came from.
async function undoLocked(c,ctx,r){
  const p=r.plan;
  for(const ch of p.changes){
    const give=ch.lines.filter(l=>l.delta>0);if(!give.length)continue;
    await native.giveBack(c,ctx,ch.orderId,{idempotencyKey:'share-undo:'+r.id+':give:'+ch.orderId,
      lines:give.map(l=>({lineId:l.lineId,locationId:r.location_id,quantity:l.delta})),detail:{job:JOB,runId:r.id,undo:true}});
  }
  for(const ch of p.changes){
    const take=ch.lines.filter(l=>l.delta<0);if(!take.length)continue;
    await native.setAside(c,ctx,ch.orderId,{idempotencyKey:'share-undo:'+r.id+':take:'+ch.orderId,
      lines:take.map(l=>({lineId:l.lineId,locationId:r.location_id,quantity:-l.delta})),detail:{job:JOB,runId:r.id,undo:true}});
  }
}

function criteriaFrom(input){
  const picked=[input.first,input.second,input.third,input.fourth].map(v=>String(v||'').trim()).filter(Boolean);
  if(!picked.length||picked.some(v=>!Object.hasOwn(CRITERIA,v))||new Set(picked).size!==picked.length)
    throw new ValidationError('Choose who comes first, using each rule once.');
  return picked;
}
async function configure(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const prior=await read(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the sharing rules before changing them.');
    if(input.stop==='yes'||input.manual==='yes'){
      if(prior&&(prior.enabled||prior.automatic)){
        const off=input.stop==='yes';
        await c.query(`UPDATE ${rulesTable} SET enabled=CASE WHEN $2 THEN false ELSE enabled END,automatic=false,taught_run_id=NULL,taught_revision=NULL,
          revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId,off]);
        await audit.record(c,ctx,{action:off?'Turned off scarce stock sharing rules':'Stopped sharing scarce stock on its own',before:{revision:prior.revision}});
      }
      return {stopped:true};
    }
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm these sharing rules.');
    const criteria=criteriaFrom(input),fill=String(input.fill||'');
    if(!['complete','share'].includes(fill))throw new ValidationError('Choose whether to complete whole orders first or to share stock across orders.');
    const max=Number(input.maxUnits);
    if(!Number.isSafeInteger(max)||max<1||max>1000000)throw new ValidationError('Choose a whole number of units from 1 to 1,000,000.');
    const trained=policy.allowance(state.plan,JOB)==='trained',automatic=!trained&&input.automatic==='yes';
    if(prior?.enabled&&JSON.stringify(prior.criteria)===JSON.stringify(criteria)&&prior.fill===fill&&prior.max_units===max&&(trained||prior.automatic===automatic))return {unchanged:true};
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'stock-sharing-rule:'+((prior?.revision||0)+1),2048,{finished:true});
    await c.query(`INSERT INTO ${rulesTable}(workspace_id,authorized_by,criteria,fill,max_units,automatic) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,criteria=EXCLUDED.criteria,fill=EXCLUDED.fill,max_units=EXCLUDED.max_units,
      automatic=EXCLUDED.automatic,enabled=true,taught_run_id=NULL,taught_revision=NULL,revision=agent_stock_sharing_rules.revision+1,updated_at=now()`,
      [ctx.workspaceId,ctx.actorId,criteria,fill,max,automatic]);
    await audit.record(c,ctx,{action:'Saved scarce stock sharing rules',before:prior?{criteria:prior.criteria,fill:prior.fill,maxUnits:prior.max_units,automatic:prior.automatic}:{},
      after:{criteria,fill,maxUnits:max,automatic}});
    return {saved:true};
  });
}

// Pro: an owner-approved split under the current rules teaches them.
async function teach(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    if(policy.allowance(state.plan,JOB)!=='trained')throw new ValidationError('Your plan applies splits on its own without teaching. Turn it on with your rules.');
    const rules=await read(c,ctx.workspaceId,{lock:true});
    if(!rules?.enabled||Number(input.revision)!==rules.revision)throw new ValidationError('Reload the sharing rules before teaching them.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that StockChief may share stock like this on its own.');
    const example=(await c.query(`SELECT id FROM ${runs} WHERE workspace_id=$1 AND id=$2 AND job_id=$3 AND status='APPLIED' AND authorization_kind='INDIVIDUAL'
      AND applied_by=$4 AND rule_revision=$5`,[ctx.workspaceId,String(input.runId||''),JOB,ctx.actorId,rules.revision])).rows[0];
    if(!example)throw new ValidationError('Approve one split under these exact rules before teaching them.');
    await c.query(`UPDATE ${rulesTable} SET automatic=true,taught_run_id=$2,taught_revision=revision,authorized_by=$3,updated_at=now() WHERE workspace_id=$1`,
      [ctx.workspaceId,example.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Taught StockChief to share scarce stock on its own',reference:example.id,after:{revision:rules.revision,maxUnits:rules.max_units}});
    return {taught:true};
  });
}

async function setTier(database,ctx,input){
  return tx(database,async c=>{
    await backorders().owner(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const customer=(await c.query(`SELECT id,name FROM customers WHERE workspace_id=$1 AND id=$2 AND record_state='ACTIVE'`,[ctx.workspaceId,String(input.customerId||'')])).rows[0];
    if(!customer)throw new NotFoundError('Choose an active customer.');
    const before=(await c.query(`SELECT tier FROM ${tiers} WHERE workspace_id=$1 AND customer_id=$2 FOR UPDATE`,[ctx.workspaceId,customer.id])).rows[0]?.tier??null;
    const raw=String(input.tier??'').trim(),tier=raw===''?null:Number(raw);
    if(tier!==null&&![1,2,3].includes(tier))throw new ValidationError('Choose tier 1, 2 or 3, or no tier.');
    if(tier===null)await c.query(`DELETE FROM ${tiers} WHERE workspace_id=$1 AND customer_id=$2`,[ctx.workspaceId,customer.id]);
    else{
      await storage.reserve(c,ctx.workspaceId,'customer-tier:'+customer.id,1024,{finished:true});
      await c.query(`INSERT INTO ${tiers}(workspace_id,customer_id,tier,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,customer_id) DO UPDATE SET tier=EXCLUDED.tier,updated_by=EXCLUDED.updated_by,updated_at=now()`,[ctx.workspaceId,customer.id,tier,ctx.actorId]);
    }
    await audit.record(c,ctx,{action:'Changed a customer tier',reference:customer.id,before:{tier:before},after:{tier}});
    return {customer:customer.name,tier};
  });
}

async function page(db,ctx,{locationId=null}={}){
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=included(state)?policy.allowance(state.plan,JOB):'excluded';
  const rules=await read(db,ctx.workspaceId);
  const locations=await backorders().waitingLocations(db,ctx);
  const selected=locations.find(l=>l.id===locationId)||locations[0]||null;
  const preview=rules?.enabled&&selected?await split(db,ctx,selected.id,rules):null;
  const tiered=(await db.query(`SELECT c.id,c.name,t.tier FROM ${tiers} t JOIN customers c ON c.workspace_id=t.workspace_id AND c.id=t.customer_id
    WHERE t.workspace_id=$1 ORDER BY t.tier,c.name,c.id LIMIT 200`,[ctx.workspaceId])).rows;
  const customers=(await db.query(`SELECT c.id,c.name FROM customers c WHERE c.workspace_id=$1 AND c.record_state='ACTIVE'
    AND EXISTS(SELECT 1 FROM sales_orders o WHERE o.workspace_id=c.workspace_id AND o.customer_id=c.id AND o.status=ANY($2::text[]))
    ORDER BY c.name,c.id LIMIT 200`,[ctx.workspaceId,planning.OPEN])).rows;
  const listed=status=>db.query(`SELECT r.*,l.name location_name FROM ${runs} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
    WHERE r.workspace_id=$1 AND r.job_id=$2 AND r.status=ANY($3::text[]) ORDER BY coalesce(r.applied_at,r.created_at) DESC,r.id LIMIT 20`,[ctx.workspaceId,JOB,status]);
  const drafts=(await listed(['DRAFT'])).rows,recent=(await listed(['APPLIED','UNDONE'])).rows;
  const example=mode==='trained'&&rules?.enabled&&!rules.automatic?recent.find(r=>r.status==='APPLIED'&&r.authorization_kind==='INDIVIDUAL'&&r.applied_by===ctx.actorId&&r.rule_revision===rules.revision)||null:null;
  const blocked=mode==='excluded'?null:await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  let automatic=null;
  if(rules?.enabled&&rules.automatic){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)automatic='Automatic work is off for this inventory, so each split waits for your approval.';
  }
  const ranked=preview?new Map(preview.ranked.map((id,i)=>[id,i+1])):new Map();
  return {mode,shadow:Boolean(state.shadow),rules,labels:LABELS,locations,selected,preview,ranked,tiered,customers,drafts,recent,example,blocked,automatic,href};
}

module.exports={JOB,ACTION,href,CRITERIA,LABELS,read,split,deferred,handle,apply,prepare,approveLocked,undoLocked,configure,teach,setTier,page};
