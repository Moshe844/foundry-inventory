'use strict';

// Job 64: manages backorders. When stock arrives at a warehouse or frees up
// there, waiting orders get it in saved order priority. Starter sees who is
// waiting and what ships first; Growth gets each allocation as a draft to
// approve; Pro and Custom set it aside on their own inside the owner's limit
// and send orders that are now complete to picking. Every applied allocation
// is logged and can be undone while nobody has started picking it.
const {newId}=require('../lib/util');
const {ValidationError,AuthorizationError,NotFoundError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const planning=require('./backorder-plan');
const native=require('./postgres-order-allocations');
const audit=require('../operations/postgres-security-audit');
const storage=require('../commercial/storage-capacity');
const JOB=64,ACTION='sales_order.allocate_backorders',KIND='agent.backorders.allocate.v1',href='/autopilot/backorders';
const runs='stockchief_runtime.agent_backorder_runs',rules='stockchief_runtime.agent_backorder_rules';
const tx=(db,fn)=>db.transaction(fn,{isolation:'SERIALIZABLE',retrySafe:true});
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});
const expected=error=>['validation_error','entitlement_required','forbidden','not_found'].includes(error.code);

async function owner(c,ctx){
  const row=(await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    FOR SHARE OF w,u`,[ctx.workspaceId,ctx.actorId])).rows[0];
  if(!row)throw new AuthorizationError('Only the current inventory owner can decide who gets waiting stock.');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
}
async function currentOwner(c,workspaceId){
  return (await c.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    WHERE w.id=$1 AND u.role='owner' AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=w.owner_account_id AND x.disabled_at IS NOT NULL)
    ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0]?.id||null;
}
async function rule(c,workspaceId,{lock=false}={}){
  return (await c.query(`SELECT * FROM ${rules} WHERE workspace_id=$1${lock?' FOR UPDATE':''}`,[workspaceId])).rows[0]||null;
}
// Products whose scarce stock is shared by the owner's own rules instead.
async function deferred(){
  return new Set();
}
async function lockPlace(c,ctx,locationId){
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['backorders:'+ctx.workspaceId+':'+locationId]);
}
async function freshPlan(c,ctx,state,locationId){
  await lockPlace(c,ctx,locationId);
  return planning.plan(c,ctx,locationId,{skip:await deferred(c,ctx,state,locationId)});
}

async function insert(c,ctx,{status,kind=null,p,reason=null,requestKey,ruleRevision=null,jobId=JOB}){
  const id=newId('backorder-run');
  await storage.reserve(c,ctx.workspaceId,'backorder-run:'+id,Buffer.byteLength(JSON.stringify(p))*2+4096,{finished:true});
  const applied=status==='APPLIED';
  const row=(await c.query(`INSERT INTO ${runs}(id,workspace_id,job_id,location_id,status,authorization_kind,plan,fingerprint,rule_revision,request_key,reason,
      prepared_by,applied_by,applied_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,CASE WHEN $14 THEN now() END)
    ON CONFLICT(workspace_id,request_key) DO NOTHING RETURNING *`,
    [id,ctx.workspaceId,jobId,p.location.id,status,kind,JSON.stringify(p),p.fingerprint,ruleRevision,requestKey,reason,ctx.actorId,applied?ctx.actorId:null,applied])).rows[0];
  return row||null;
}

// One open draft per warehouse and job. A changed situation replaces it.
async function draft(c,ctx,p,reason,{jobId=JOB,ruleRevision=null}={}){
  const open=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND job_id=$2 AND location_id=$3 AND status='DRAFT' FOR UPDATE`,
    [ctx.workspaceId,jobId,p.location.id])).rows[0];
  if(open&&open.fingerprint===p.fingerprint){
    if(open.reason!==reason&&reason!=='Prepared on request.')await c.query(`UPDATE ${runs} SET reason=$3 WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id,reason]);
    return {id:open.id,created:false};
  }
  if(open)await c.query(`UPDATE ${runs} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,open.id]);
  const row=await insert(c,ctx,{status:'DRAFT',p,reason,requestKey:'draft:'+newId('key'),jobId,ruleRevision});
  return {id:row.id,created:true};
}

async function setAside(c,ctx,p,runId){
  for(const g of p.gives)await native.setAside(c,ctx,g.orderId,{expectedVersion:g.version,idempotencyKey:'backorders:'+runId+':'+g.orderId,
    lines:g.lines.map(l=>({lineId:l.lineId,locationId:p.location.id,quantity:l.quantity})),detail:{job:JOB,runId}});
}

async function releaseStop(c,ctx,state){
  if(!policy.permits(state.plan,56,'automatic')||!policy.permits(state.plan,57,'automatic'))return 'Send complete orders to picking from Release ready orders.';
  for(const job of [56,57]){
    const reason=await require('../autopilot/job-modes').restriction(c,ctx.workspaceId,job,true);
    if(reason)return 'Complete orders were not sent to picking. '+reason;
  }
  return policy.stopped(c,ctx.workspaceId,state,'warehouse.release_orders',true);
}

// Orders this allocation completed go to picking through the native release
// checks of job 56: fully reserved at this warehouse, nothing else holding them.
async function release(c,ctx,state,p,runId){
  const ready=p.gives.filter(g=>g.complete&&g.delivery==='SHIP').map(g=>g.orderId);
  if(!ready.length)return {released:null,note:null};
  const stop=await releaseStop(c,ctx,state);
  if(stop)return {released:null,note:stop};
  const pick=require('../warehouse/agent-pick-release'),valid=[],skipped=[];
  await c.query('SAVEPOINT backorder_release');
  try{
    for(const id of ready){
      try{await pick.inspect(c,ctx,id,{single:true,limit:1,strategy:'BATCH',lock:true});valid.push(id);}
      catch(error){if(!(error instanceof ValidationError))throw error;skipped.push(p.gives.find(g=>g.orderId===id).orderNumber);}
    }
    if(!valid.length){await c.query('RELEASE SAVEPOINT backorder_release');return {released:null,note:'Release '+skipped.join(', ')+' yourself after checking it.'};}
    const wave=await require('../operations/postgres-fulfillment-waves').create(scoped(c),ctx,{orderIds:valid,strategy:'BATCH',
      title:'Backorders ready at '+p.location.name,idempotencyKey:'backorders-release:'+runId});
    const orders=(await c.query(`SELECT x.sales_order_id "orderId",o.order_number "orderNumber",x.shipment_id "shipmentId"
      FROM fulfillment_wave_shipments x JOIN sales_orders o ON o.workspace_id=x.workspace_id AND o.id=x.sales_order_id
      WHERE x.workspace_id=$1 AND x.wave_id=$2 ORDER BY o.order_number`,[ctx.workspaceId,wave.waveId])).rows;
    await c.query('RELEASE SAVEPOINT backorder_release');
    return {released:{waveId:wave.waveId,waveNumber:wave.waveNumber,orders},note:skipped.length?'Release '+skipped.join(', ')+' yourself after checking it.':null};
  }catch(error){
    if(!expected(error))throw error;
    await c.query('ROLLBACK TO SAVEPOINT backorder_release');await c.query('RELEASE SAVEPOINT backorder_release');
    return {released:null,note:'Complete orders were not sent to picking. '+error.message};
  }
}

async function automaticStop(c,ctx,state,saved,p){
  if(!policy.permits(state.plan,JOB,'automatic'))return 'Growth prepares backorder stock for your approval.';
  if(!saved?.enabled)return 'Turn on automatic backorder handling to let StockChief set this stock aside on its own.';
  if(saved.authorized_by!==ctx.actorId)return 'The current owner must confirm the backorder limit.';
  const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,true);
  if(stop)return stop;
  if(!(await require('../autopilot/postgres-service').getState(c,ctx.workspaceId)).canAutomate)return 'Automatic work is off for this inventory. Approve this stock yourself.';
  const over=p.gives.find(g=>g.units>saved.max_units);
  if(over)return over.orderNumber+' would get '+over.units+' units, more than your limit of '+saved.max_units+' for one order.';
  return null;
}

async function handle(c,ctx,locationId,{watch=false}={}){
  const state=await policy.accountState(c,ctx.workspaceId);
  await lockPlace(c,ctx,locationId);
  return watch?{}:allocate(c,ctx,state,locationId);
}
async function allocate(c,ctx,state,locationId){
  const p=await freshPlan(c,ctx,state,locationId);
  if(!p.gives.length)return {};
  const saved=await rule(c,ctx.workspaceId);
  const why=await automaticStop(c,ctx,state,saved,p);
  if(why)return {drafted:(await draft(c,ctx,p,why)).created};
  const row=await insert(c,ctx,{status:'APPLIED',kind:'AUTOMATIC',p,requestKey:'auto:'+p.location.id+':'+p.fingerprint,ruleRevision:saved.revision});
  if(!row)return {replayed:true};
  await c.query(`UPDATE ${runs} SET status='STALE' WHERE workspace_id=$1 AND job_id=$2 AND location_id=$3 AND status='DRAFT'`,[ctx.workspaceId,JOB,p.location.id]);
  await setAside(c,ctx,p,row.id);
  const sent=saved.release_ready?await release(c,ctx,state,p,row.id):{released:null,note:null};
  await c.query(`UPDATE ${runs} SET released=$3::jsonb,release_note=$4 WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,row.id,sent.released?JSON.stringify(sent.released):null,sent.note]);
  await audit.record(c,ctx,{action:'StockChief set stock aside for waiting orders',reference:row.id,
    after:{location:p.location.id,orders:p.gives.map(g=>[g.orderNumber,g.units]),limit:saved.max_units,released:sent.released?.waveNumber||null}});
  return {applied:true,released:sent.released?.orders.length||0};
}

async function run(db,workspaceId,{locationIds=null}={}){
  const result={applied:0,drafted:0,released:0,held:0,watching:false};
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return result;
  const actorId=await currentOwner(db,workspaceId);
  if(!actorId)return result;
  // Shadow mode, Watch only and each job's own Watch setting only watch.
  const watch=Boolean(await policy.stopped(db,workspaceId,state,ACTION,false));
  if(watch){result.watching=true;return result;}
  const ctx={workspaceId,actorId};
  for(const place of await planning.candidates(db,workspaceId,{locationIds})){
    const outcome=await tx(db,async c=>{
      await c.query('SAVEPOINT backorders');
      try{const done=await handle(c,ctx,place.id,{watch});await c.query('RELEASE SAVEPOINT backorders');return done;}
      catch(error){
        if(!expected(error))throw error;
        await c.query('ROLLBACK TO SAVEPOINT backorders');await c.query('RELEASE SAVEPOINT backorders');
        return {held:true};
      }
    });
    if(outcome.applied)result.applied++;
    if(outcome.drafted)result.drafted++;
    if(outcome.held)result.held++;
    result.released+=outcome.released||0;
  }
  return result;
}

// Called inside the transaction that frees or receives stock.
async function queue(c,ctx,locationIds,cause){
  const ids=[...new Set((locationIds||[]).filter(Boolean))].sort();
  if(!ids.length)return;
  const state=await policy.accountState(c,ctx.workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,JOB,'draft'))return;
  if(!(await c.query(`SELECT 1 FROM sales_orders WHERE workspace_id=$1 AND fulfillment_location_id=ANY($2::text[]) AND status IN ('BACKORDERED','PARTIALLY_FULFILLED') LIMIT 1`,
    [ctx.workspaceId,ids])).rowCount)return;
  await require('../operations/postgres-job-queue').enqueue(scoped(c),{workspaceId:ctx.workspaceId,kind:KIND,priority:70,maxAttempts:5,
    idempotencyKey:'backorders:'+require('../pricing/postgres-promotions').hash([ids,cause]),payload:{locationIds:ids}});
}
async function onQueued(db,job){
  const ids=job.payload?.locationIds;
  if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'))throw new ValidationError('A backorder check needs its warehouses.');
  return run(db,job.workspaceId,{locationIds:ids});
}

async function prepare(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    const p=await freshPlan(c,ctx,state,input.locationId);
    if(!p.gives.length)throw new ValidationError('No waiting order can get stock at '+p.location.name+' right now.');
    return draft(c,ctx,p,'Prepared on request.');
  });
}

async function locked(c,ctx,id){
  const row=(await c.query(`SELECT * FROM ${runs} WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,String(id||'')])).rows[0];
  if(!row)throw new NotFoundError('That backorder plan is not in this inventory.');
  return row;
}

async function approve(database,ctx,id,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.job_id!==JOB)throw new ValidationError('Review this plan from its own page.');
    const state=await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'draft');
    const stop=await policy.stopped(c,ctx.workspaceId,state,ACTION,false);
    if(stop)throw new ValidationError(stop);
    if(r.status==='APPLIED')return {id:r.id,replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('This plan is no longer waiting for approval. Review the current waiting orders.');
    if(input.confirmed!=='yes'||input.fingerprint!==r.fingerprint)throw new ValidationError('Review and approve this exact plan.');
    const p=await freshPlan(c,ctx,state,r.location_id);
    if(p.fingerprint!==r.fingerprint){
      await c.query(`UPDATE ${runs} SET status='STALE' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
      const next=p.gives.length?await draft(c,ctx,p,'Stock or orders changed after the earlier plan.'):null;
      return {id:r.id,stale:true,next:next?.id||null};
    }
    await setAside(c,ctx,p,r.id);
    await c.query(`UPDATE ${runs} SET status='APPLIED',authorization_kind='INDIVIDUAL',applied_by=$3,applied_at=now() WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,r.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Approved stock for waiting orders',reference:r.id,after:{location:p.location.id,orders:p.gives.map(g=>[g.orderNumber,g.units])}});
    return {id:r.id,applied:true};
  });
}

async function discard(database,ctx,id){
  return tx(database,async c=>{
    await owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='DISCARDED')return {id:r.id,replayed:true};
    if(r.status!=='DRAFT')throw new ValidationError('Only a plan waiting for approval can be dismissed.');
    await c.query(`UPDATE ${runs} SET status='DISCARDED' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id]);
    await audit.record(c,ctx,{action:'Dismissed a backorder plan',reference:r.id});
    return {id:r.id};
  });
}

// Give back what an applied plan set aside. Nobody may have started picking.
async function cancelRelease(c,ctx,r){
  for(const s of r.released?.orders||[]){
    const box=(await c.query(`SELECT h.status,EXISTS(SELECT 1 FROM fulfillment_wave_lines w WHERE w.workspace_id=h.workspace_id AND w.shipment_id=h.id AND w.picked_quantity>0) picked
      FROM sales_shipments h WHERE h.workspace_id=$1 AND h.id=$2`,[ctx.workspaceId,s.shipmentId])).rows[0];
    if(!box||box.status==='CANCELLED')continue;
    if(box.status!=='PICKING'||box.picked)throw new ValidationError('Picking has started for '+s.orderNumber+'. Undo is no longer possible.');
    await require('../shipping/postgres-service').cancel(scoped(c),ctx,s.shipmentId,{reason:'StockChief backorder work undone'});
  }
}
async function undo(database,ctx,id,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const r=await locked(c,ctx,id);
    if(r.status==='UNDONE')return {id:r.id,replayed:true};
    if(r.status!=='APPLIED')throw new ValidationError('Only applied work can be undone.');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm that this work should be undone.');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['backorders:'+ctx.workspaceId+':'+r.location_id]);
    if(r.job_id!==JOB)throw new ValidationError('Undo this work from its own page.');
    await cancelRelease(c,ctx,r);
    for(const g of [...r.plan.gives].reverse())await native.giveBack(c,ctx,g.orderId,{idempotencyKey:'backorders-undo:'+r.id+':'+g.orderId,
      lines:g.lines.map(l=>({lineId:l.lineId,locationId:r.location_id,quantity:l.quantity})),detail:{job:JOB,runId:r.id,undo:true}});
    await c.query(`UPDATE ${runs} SET status='UNDONE',undone_by=$3,undone_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,r.id,ctx.actorId]);
    await audit.record(c,ctx,{action:'Undid stock set aside for waiting orders',reference:r.id});
    return {id:r.id};
  });
}

async function configure(database,ctx,input){
  return tx(database,async c=>{
    await owner(c,ctx);
    const prior=await rule(c,ctx.workspaceId,{lock:true});
    if(Number(input.revision)!==(prior?.revision||0))throw new ValidationError('Reload the backorder settings before changing them.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await c.query(`UPDATE ${rules} SET enabled=false,revision=revision+1,updated_at=now() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(c,ctx,{action:'Stopped automatic backorder handling',before:{maxUnits:prior.max_units}});
      }
      return {stopped:true};
    }
    await policy.requireWorkspaceJob(c,ctx.workspaceId,JOB,'automatic');
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the most units StockChief may set aside for one order.');
    const max=Number(input.maxUnits);
    if(!Number.isSafeInteger(max)||max<1||max>1000000)throw new ValidationError('Choose a whole number of units from 1 to 1,000,000.');
    const releaseReady=input.releaseReady==='yes';
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c,ctx,[],prior?.enabled?0:1);
    await storage.reserve(c,ctx.workspaceId,'backorder-rule:'+((prior?.revision||0)+1),2048,{finished:true});
    await c.query(`INSERT INTO ${rules}(workspace_id,authorized_by,max_units,release_ready) VALUES($1,$2,$3,$4)
      ON CONFLICT(workspace_id) DO UPDATE SET authorized_by=EXCLUDED.authorized_by,max_units=EXCLUDED.max_units,release_ready=EXCLUDED.release_ready,
      enabled=true,revision=agent_backorder_rules.revision+1,updated_at=now()`,[ctx.workspaceId,ctx.actorId,max,releaseReady]);
    await audit.record(c,ctx,{action:'Authorized automatic backorder handling',before:prior?{maxUnits:prior.max_units,releaseReady:prior.release_ready,enabled:prior.enabled}:{},
      after:{maxUnits:max,releaseReady}});
    return {maxUnits:max};
  });
}

async function waitingLocations(db,ctx){
  return (await db.query(`SELECT loc.id,loc.name,count(DISTINCT o.id)::int orders FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    JOIN locations loc ON loc.workspace_id=o.workspace_id AND loc.id=o.fulfillment_location_id AND loc.is_active=1 AND loc.custody_agreement_id IS NULL
    WHERE o.workspace_id=$1 AND o.status=ANY($2::text[]) AND o.confirmed_at IS NOT NULL AND ${planning.waiting('l')}>0
    GROUP BY loc.id,loc.name ORDER BY loc.name,loc.id LIMIT 100`,[ctx.workspaceId,planning.OPEN])).rows;
}

async function page(db,ctx,{locationId=null}={}){
  const state=await policy.accountState(db,ctx.workspaceId);
  const mode=policy.usesAgentTerms(state)?policy.allowance(state.plan,JOB):'excluded';
  const locations=await waitingLocations(db,ctx);
  const selected=locations.find(l=>l.id===locationId)||locations[0]||null;
  let rows=[],preview=null,more=false,deferredSkus=[];
  if(selected){
    const skip=await deferred(db,ctx,state,selected.id);deferredSkus=[...skip];
    preview=await planning.plan(db,ctx,selected.id,{skip});
    const skus=(await db.query(`SELECT DISTINCT l.sku_id FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND o.fulfillment_location_id=$2 AND o.status=ANY($3::text[]) AND o.confirmed_at IS NOT NULL AND ${planning.waiting('l')}>0
      ORDER BY l.sku_id LIMIT 500`,[ctx.workspaceId,selected.id,planning.OPEN])).rows.map(r=>r.sku_id);
    const list=await planning.orders(db,ctx,selected.id,skus,{limit:101});
    more=list.length>100;
    const gives=new Map(preview.gives.map(g=>[g.orderId,g]));
    rows=list.slice(0,100).filter(o=>o.lines.some(l=>l.waiting>0)).map(o=>{
      const g=gives.get(o.id),waits=o.lines.filter(l=>l.waiting>0);
      return {id:o.id,order:o.order_number,customer:o.customer,neededBy:o.needed_by||null,priority:Number(o.allocation_priority),
        waiting:waits.map(l=>l.waiting+' × '+l.code).join(', '),
        next:o.hold?o.hold:g?(g.complete?'Gets '+g.lines.map(l=>l.quantity+' × '+l.code).join(', ')+' now. Complete.':'Gets '+g.lines.map(l=>l.quantity+' × '+l.code).join(', ')+' now.')
          :waits.some(l=>skip.has(l.skuId))?'Shared by your priority rules.':'Waits for stock.',
        held:Boolean(o.hold),ships:Boolean(g)};
    });
  }
  const unrouted=(await db.query(`SELECT o.id,o.order_number,c.name customer FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE o.workspace_id=$1 AND o.status IN ('BACKORDERED','PARTIALLY_FULFILLED') AND o.fulfillment_location_id IS NULL ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 11`,
    [ctx.workspaceId])).rows;
  const drafts=mode==='suggest'||mode==='excluded'?[]:(await db.query(`SELECT r.*,l.name location_name FROM ${runs} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
    WHERE r.workspace_id=$1 AND r.job_id=$2 AND r.status='DRAFT' ORDER BY r.created_at DESC,r.id LIMIT 20`,[ctx.workspaceId,JOB])).rows;
  const recent=(await db.query(`SELECT r.*,l.name location_name FROM ${runs} r JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.location_id
    WHERE r.workspace_id=$1 AND r.job_id=$2 AND r.status IN ('APPLIED','UNDONE') ORDER BY coalesce(r.applied_at,r.created_at) DESC,r.id LIMIT 20`,[ctx.workspaceId,JOB])).rows;
  const saved=await rule(db,ctx.workspaceId);
  const blocked=mode==='excluded'||mode==='suggest'?null:await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
  let automatic=null;
  if(mode==='alone'){
    automatic=await policy.stopped(db,ctx.workspaceId,state,ACTION,true);
    if(!automatic&&!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)automatic='Automatic work is off for this inventory, so StockChief prepares each allocation for your approval.';
  }
  return {mode,shadow:Boolean(state.shadow),locations,selected,rows,more,preview,deferredSkus,unrouted:unrouted.slice(0,10),moreUnrouted:unrouted.length>10,
    drafts,recent,rule:saved,blocked,automatic,href};
}

module.exports={JOB,ACTION,KIND,href,run,handle,queue,onQueued,prepare,approve,discard,undo,configure,page,rule,waitingLocations,
  owner,currentOwner,insert,draft,freshPlan,locked,release,cancelRelease,expected,tx};
