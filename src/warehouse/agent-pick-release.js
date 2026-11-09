'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity'),{hash}=require('../pricing/postgres-promotions');
const action='warehouse.release_orders';
function strategy(value){const result=String(value||'BATCH').toUpperCase();if(!['WAVE','BATCH','CLUSTER'].includes(result))throw new ValidationError('Choose wave, batch or cluster picking.');return result;}
function limit(value){const result=Number(value??20);if(!Number.isSafeInteger(result)||result<1||result>20)throw new ValidationError('Release one to 20 ready orders at a time.');return result;}
function trainingFor(orders,lines,locationId,location,method,currency){
 let amount=0;for(const line of lines)amount=require('../domain/currency').integer(amount+exact.costMinor(line.quantity,line.price));
 const qualification=['pick-release',locationId,method,...new Set(orders.map(o=>JSON.stringify([o.customer_id,o.ship_to_address,o.contact_email])).sort()),...new Set(lines.map(l=>l.sku_id).sort())];
 const customers=[...new Set(orders.map(o=>o.customer))],codes=[...new Set(lines.map(l=>l.code))];
 const named=(values,n)=>values.slice(0,n).join(', ')+(values.length>n?' and '+(values.length-n)+' more':'');
 return require('../autopilot/draft-authority').scope(locationId,currency,amount,qualification,'Ready orders at '+location+' · '+method.toLowerCase()+' picking · '+named(customers,3)+' · '+named(codes,5)+' · same approved delivery addresses');
}

async function headers(db,ctx,{locationId=null,currency=null,singleId=null,count=100,offset=0,filter='',excludeLocations=[],skipChecked=false,lock=false}={}){
 return (await db.query(`SELECT o.id,o.order_number,o.customer_id,c.name customer,o.contact_email,o.ship_to_address,o.currency,o.version,o.needed_by,o.allocation_priority,o.created_at,location.name location
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id AND c.record_state='ACTIVE'
  JOIN locations location ON location.workspace_id=o.workspace_id AND location.id=o.fulfillment_location_id AND location.kind='warehouse' AND location.is_active=1 AND location.custody_agreement_id IS NULL
  WHERE o.workspace_id=$1 AND ($2::text IS NULL OR o.fulfillment_location_id=$2) AND ($3::text IS NULL OR o.currency=$3) AND o.status='CONFIRMED' AND o.delivery_method='SHIP'
   AND coalesce(o.customer_decision_required,0)=0 AND coalesce(o.delivery_decision_required,0)=0 AND ($4::text IS NULL OR o.id=$4)
   AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    AND (l.quantity_fulfilled<>0 OR i.tracking_mode<>'quantity' OR i.quantity_precision<>0 OR s.is_active<>1 OR i.is_active<>1
     OR l.quantity_ordered<>(SELECT coalesce(sum(a.quantity),0) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id AND a.location_id=o.fulfillment_location_id)
     OR EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id)))
   AND NOT EXISTS(SELECT 1 FROM sales_shipments shipment WHERE shipment.workspace_id=o.workspace_id AND shipment.sales_order_id=o.id AND shipment.status<>'CANCELLED')
   AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.shipbob_sandbox_orders delegated WHERE delegated.workspace_id=o.workspace_id AND delegated.sales_order_id=o.id)
   AND ($7='' OR lower(location.name)=lower($7) OR lower(o.order_number)=lower($7))
   AND NOT(o.fulfillment_location_id=ANY($8::text[]))
   AND (NOT $9::boolean OR NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_pick_release_checks checked WHERE checked.workspace_id=o.workspace_id AND checked.location_id=o.fulfillment_location_id AND checked.retry_after>now()))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT $5 OFFSET $6${lock?' FOR SHARE OF o,c,location':''}`,[ctx.workspaceId,locationId,currency,singleId,count,offset,filter,excludeLocations,skipChecked])).rows;
}
async function inspect(db,ctx,anchorId,options={}){
 const count=limit(options.limit),method=strategy(options.strategy);
 const anchor=(await db.query(`SELECT o.fulfillment_location_id,o.currency,l.name location FROM sales_orders o JOIN locations l
  ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id AND l.kind='warehouse' AND l.is_active=1 AND l.custody_agreement_id IS NULL
  WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,anchorId])).rows[0];
 if(!anchor)throw new ValidationError('Choose a ready order with an active dispatch warehouse.');
 const orders=await headers(db,ctx,{locationId:anchor.fulfillment_location_id,currency:anchor.currency,singleId:options.single?anchorId:null,count,lock:options.lock===true});
 if(!orders.some(o=>o.id===anchorId))throw new ValidationError('That order is not in the next eligible release. Review the ready-order list again.');
 const lines=(await db.query(`SELECT l.id,l.sales_order_id,l.sku_id,s.code,l.quantity_ordered::text quantity,l.unit_price_minor::text price
  FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id WHERE l.workspace_id=$1 AND l.sales_order_id=ANY($2::text[]) ORDER BY l.sales_order_id,l.id`,[ctx.workspaceId,orders.map(o=>o.id)])).rows;
 if(lines.length>200)throw new ValidationError('Review a smaller release with no more than 200 product lines.');
 const allocations=(await db.query(`SELECT a.sales_order_line_id,a.location_id,a.quantity::text,l.name location,l.pick_sequence
  FROM sales_order_allocations a JOIN locations l ON l.workspace_id=a.workspace_id AND l.id=a.location_id
  WHERE a.workspace_id=$1 AND a.sales_order_line_id=ANY($2::text[]) AND a.quantity>0 ORDER BY l.pick_sequence,l.name,a.sales_order_line_id,a.location_id`,[ctx.workspaceId,lines.map(l=>l.id)])).rows;
 if(allocations.some(a=>a.location_id!==anchor.fulfillment_location_id))throw new ValidationError('Review orders reserved in separate bins or warehouses individually before release.');
 for(const line of lines){const allocated=allocations.filter(a=>a.sales_order_line_id===line.id).reduce((n,a)=>exact.add(n,a.quantity),'0');if(exact.canonical(allocated)!==exact.canonical(line.quantity))throw new ValidationError('Every released order must be fully reserved. Review changed or incomplete reservations first.');}
 if(options.lock)await db.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND location_id=$2 AND sku_id=ANY($3::text[]) ORDER BY sku_id FOR SHARE',[ctx.workspaceId,anchor.fulfillment_location_id,lines.map(l=>l.sku_id)]);
 const positions=await require('../domain/postgres-stock-availability').readMany(db,ctx.workspaceId,lines.map(l=>({skuId:l.sku_id,locationId:anchor.fulfillment_location_id})));
 if(lines.some(l=>{const p=positions.get(JSON.stringify([l.sku_id,anchor.fulfillment_location_id]));return !p||p.onHand<p.committed+p.reserved;}))throw new ValidationError('Stock no longer covers the reservations and other holds. Review the warehouse before releasing work.');
 const training=trainingFor(orders,lines,anchor.fulfillment_location_id,anchor.location,method,anchor.currency);
 const snapshot={orders,lines,allocations,positions:[...positions].sort((a,b)=>a[0].localeCompare(b[0])),strategy:method,limit:count,location:anchor.fulfillment_location_id};
 return {orders,lines,allocations,training,fingerprint:hash(snapshot),locationId:anchor.fulfillment_location_id,location:anchor.location,strategy:method,limit:count};
}
async function build(db,ctx,row,args){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,56,'draft');await policy.requireWorkspaceJob(db,ctx.workspaceId,57,'draft');
 const p=await inspect(db,ctx,row.id,{limit:args.quantity,strategy:args.strategy});
 return {payload:{recordId:row.id,orderIds:p.orders.map(o=>o.id),orderNumbers:p.orders.map(o=>o.order_number),strategy:p.strategy,limit:p.limit,locationId:p.locationId,locationName:p.location,fingerprint:p.fingerprint,training:p.training},
  summary:'Release '+p.orders.length+' fully reserved orders at '+p.location+' in owner priority, due date and creation order: '+p.orders.map(o=>o.order_number).join(', ')+'. Create a '+p.strategy.toLowerCase()+' pick wave. No goods move, ship, or get invoiced; people must scan and hand them over.'};
}
async function authority(db,ctx,name,p){
 const state=await policy.accountState(db,ctx.workspaceId);if(!policy.usesAgentTerms(state))return;
 const automatic=ctx.agentWarehouseReleaseScope==='automatic';
 const taught=automatic&&await require('../autopilot/draft-authority').trained(db,ctx.workspaceId,name,p);
 policy.requireJob(state.plan,57,automatic?'automatic':'draft',{trained:taught});
 const stop=await policy.stopped(db,ctx.workspaceId,state,'warehouse.wave.create',automatic,p);if(stop)throw new ValidationError(stop);
 if(automatic&&p.training){const rule=(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4 FOR SHARE',[ctx.workspaceId,name,p.training.key,p.training.currency])).rows[0];if(rule&&Number(rule.maximum_minor)<p.training.amountMinor)throw new ValidationError('This pick release exceeds the saved owner limit. Review it individually.');}
}
async function execute(db,ctx,p){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,56,'draft');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
 const now=await inspect(db,ctx,p.recordId,{limit:p.limit,strategy:p.strategy,lock:true});if(now.fingerprint!==p.fingerprint)throw new ValidationError('The release order, reservation, stock, customer or warehouse changed. Review a fresh pick release.');
 await authority(db,ctx,action,{...p,training:now.training});
 return require('../operations/postgres-fulfillment-waves').create({query:db.query.bind(db),transaction:fn=>fn(db)},ctx,{orderIds:now.orders.map(o=>o.id),strategy:now.strategy,title:'Ready orders at '+now.location,idempotencyKey:p.idempotencyKey});
}
async function verify(db,ctx,r,p){
 if(!r.waveId||r.status!=='PICKING')return false;
 const rows=(await db.query('SELECT sales_order_id FROM fulfillment_wave_shipments WHERE workspace_id=$1 AND wave_id=$2 ORDER BY sales_order_id',[ctx.workspaceId,r.waveId])).rows;
 return JSON.stringify(rows.map(x=>x.sales_order_id))===JSON.stringify([...p.orderIds].sort());
}
async function single(db,ctx,id,method){
 if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)return {needsWaveConfirmation:true};
 try{const p=await inspect(db,ctx,id,{single:true,limit:1,strategy:method});return {training:p.training,releaseFingerprint:p.fingerprint,needsWaveConfirmation:false};}catch(error){if(error instanceof ValidationError)return {needsWaveConfirmation:true};throw error;}
}
async function executeSingle(db,ctx,p){
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['fulfillment-wave:'+ctx.workspaceId]);
 if(p.releaseFingerprint){const now=await inspect(db,ctx,p.orderIds[0],{single:true,limit:1,strategy:p.strategy,lock:true});if(now.fingerprint!==p.releaseFingerprint)throw new ValidationError('The ready order or its reservations changed. Review a fresh pick wave.');}
 await authority(db,ctx,'warehouse.wave.create',p);
 return require('../operations/postgres-fulfillment-waves').create({query:db.query.bind(db),transaction:fn=>fn(db)},ctx,p);
}
async function requireRoutineAuthority(db,ctx){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,56,'automatic',{trained:true});
 const grant=(await db.query(`SELECT m.revision FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN workspaces workspace ON workspace.id=u.workspace_id AND workspace.deletion_requested_at IS NULL
  JOIN accounts account ON account.id=u.account_id JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id
  WHERE m.workspace_id=$1 AND m.job_id=56 AND m.mode='routine' AND u.id=$2
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id IN(account.id,workspace.owner_account_id) AND x.disabled_at IS NOT NULL) FOR SHARE OF m,u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!grant||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable ready-order release and automatic work first.');
 const reason=await require('../autopilot/job-modes').restriction(db,ctx.workspaceId,57,true);if(reason)throw new ValidationError(reason);
 return {kind:'standing_job_rule',job:56,ownerId:ctx.actorId,modeRevision:Number(grant.revision)};
}
async function run(db,workspaceId){
 const empty={releasedOrders:0,releasedWaves:0,heldWarehouses:0};
 const grant=(await db.query("SELECT updated_by FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=56 AND mode='routine'",[workspaceId])).rows[0];if(!grant)return empty;
 const ctx={workspaceId,actorId:grant.updated_by};
 return db.transaction(async c=>{
  const result={...empty};
  if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) locked',['agent-pick-release:'+workspaceId])).rows[0].locked)return {...result,skipped:'another_run'};
  try{await requireRoutineAuthority(c,ctx);}catch(error){if(['validation_error','entitlement_required','forbidden'].includes(error.code))return result;throw error;}
  const scoped={query:c.query.bind(c),transaction:fn=>fn(c)},seen=[];
  for(let warehouse=0;warehouse<4;warehouse++){
   const [candidate]=await headers(c,ctx,{count:1,excludeLocations:seen,skipChecked:true});if(!candidate)break;
   const locationId=(await c.query('SELECT fulfillment_location_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,candidate.id])).rows[0].fulfillment_location_id;seen.push(locationId);
   await c.query('SAVEPOINT pick_release');
   try{
    const current=await inspect(c,ctx,candidate.id,{limit:20,strategy:'BATCH'}),state=await policy.accountState(c,workspaceId),rules=(await c.query(`SELECT r.scope_key,r.currency,r.maximum_minor FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
     JOIN accounts a ON a.id=u.account_id WHERE r.workspace_id=$1 AND r.action_type=$2 AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[workspaceId,action])).rows;
    let maximum=0;
    for(let count=current.orders.length;count>=1;count--){const orders=current.orders.slice(0,count),ids=new Set(orders.map(o=>o.id)),bound=trainingFor(orders,current.lines.filter(l=>ids.has(l.sales_order_id)),locationId,current.location,current.strategy,current.training.currency),rule=rules.find(r=>r.scope_key===bound.key&&r.currency===bound.currency);
     if((state.plan!=='growth'||rule)&&(!rule||Number(rule.maximum_minor)>=bound.amountMinor)){maximum=count;break;}}
    if(!maximum)throw new ValidationError('No ready batch fits a matching taught customer, product, delivery and goods-value scope. Approve an example or review the saved limit.');
    const prepared=await build(c,ctx,{id:candidate.id},{quantity:maximum,strategy:'BATCH'}),assistant=require('../assistant/postgres-service'),proposal=await assistant.createProposal(scoped,{...ctx,planStepKey:'pick-release:'+prepared.payload.fingerprint},'Release eligible ready orders under the enabled owner rule',action,prepared.payload,prepared.summary);
    const done=await assistant.executePickReleaseRoutine(scoped,ctx,proposal.proposal.id);await c.query('RELEASE SAVEPOINT pick_release');await checked(null,done.result.waveId);
    if(!done.replayed){result.releasedOrders+=prepared.payload.orderIds.length;result.releasedWaves++;}
   }catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT pick_release');await c.query('RELEASE SAVEPOINT pick_release');await checked(error.message,null);result.heldWarehouses++;}
   async function checked(problem,waveId){await c.query(`INSERT INTO stockchief_runtime.agent_pick_release_checks(workspace_id,location_id,checked_at,retry_after,problem,wave_id)
    VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '15 minutes',$3,$4) ON CONFLICT(workspace_id,location_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem,wave_id=EXCLUDED.wave_id`,[workspaceId,locationId,problem,waveId]);}
  }
  return result;
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function review(db,ctx,{page=1,filter=''}){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,56,'draft');
 const orders=await headers(db,ctx,{count:101,offset:(page-1)*100,filter});
 const state=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,state,action,false)||await policy.stopped(db,ctx.workspaceId,state,'warehouse.wave.create',false);
 const recent=(await db.query(`SELECT l.name,c.problem,c.wave_id,c.checked_at,c.retry_after FROM stockchief_runtime.agent_pick_release_checks c JOIN locations l ON l.workspace_id=c.workspace_id AND l.id=c.location_id WHERE c.workspace_id=$1 ORDER BY c.checked_at DESC,c.location_id LIMIT 100`,[ctx.workspaceId])).rows;
 const {timeZone}=await require('../lib/business-time').forWorkspace(db,ctx.workspaceId),clock=new Intl.DateTimeFormat('en-US',{timeZone,dateStyle:'medium',timeStyle:'short'});
 let routineReason=null;try{await requireRoutineAuthority(db,ctx);}catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;routineReason=error.message;}
 return {summary:'Fully reserved, unshipped quantity orders, sorted by saved owner priority (lower numbers first), due date and creation time. Prepare a release from the first listed order at its warehouse. The preview rechecks physical stock, other holds and the exact batch; people still scan and physically hand off goods.',
  rows:orders.slice(0,100).map(o=>({Order:o.order_number,Customer:o.customer,Warehouse:o.location,Priority:o.allocation_priority,'Needed by':o.needed_by||'Not recorded',link:'/sales/orders/'+o.id})),more:orders.length>100,pickReleaseForm:{orders:orders.slice(0,100),blocked,routineReason,recent:recent.map(r=>({...r,checked:clock.format(new Date(r.checked_at)),retry:clock.format(new Date(r.retry_after))}))}};
}
async function recheck(db,ctx){
 return db.transaction(async c=>{
  await require('../autopilot/job-reviews').ownerState(c,ctx);await policy.requireWorkspaceJob(c,ctx.workspaceId,56,'draft');
  await c.query('UPDATE stockchief_runtime.agent_pick_release_checks SET retry_after=clock_timestamp() WHERE workspace_id=$1',[ctx.workspaceId]);
  await require('../operations/postgres-security-audit').record(c,ctx,{action:'Requested another routine pick-release check'});
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={inspect,build,execute,verify,single,executeSingle,review,run,recheck,requireRoutineAuthority,definition:{id:56,key:'pick-release',label:'Release ready orders to picking',filterLabel:'Warehouse name or order number',readPage:review}};
