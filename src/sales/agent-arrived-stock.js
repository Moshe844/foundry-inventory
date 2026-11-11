'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),exact=require('../domain/exact-quantity'),{hash}=require('../pricing/postgres-promotions');
const action='sales_order.reserve_arrived',job=48;
async function inspect(db,ctx,id,{lock=false}={}){
 const order=(await db.query(`SELECT o.*,c.name customer_name,c.record_state,l.name location_name,l.is_active,l.custody_agreement_id FROM sales_orders o
  JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
  JOIN locations l ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id
  WHERE o.workspace_id=$1 AND o.id=$2${lock?' FOR UPDATE OF o':''}`,[ctx.workspaceId,id])).rows[0];
 if(!order||!['BACKORDERED','PARTIALLY_FULFILLED'].includes(order.status)||!order.confirmed_at||order.record_state!=='ACTIVE'||!order.is_active||order.custody_agreement_id)throw new ValidationError('Choose an already confirmed backorder with an active customer and dispatch location.');
 const lines=(await db.query(`SELECT l.id,l.sku_id,l.quantity_ordered::text,l.quantity_fulfilled::text,coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct_committed_quantity,l.unit_price_minor::text,s.code,i.tracking_mode,
  coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)::text allocated
  FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
  WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.id`,[ctx.workspaceId,id])).rows;
 if(!lines.length||lines.length>100||lines.some(l=>l.tracking_mode!=='quantity')||(await db.query('SELECT 1 FROM sales_order_kit_components WHERE workspace_id=$1 AND sales_order_line_id=ANY($2::text[]) LIMIT 1',[ctx.workspaceId,lines.map(l=>l.id)])).rows.length)throw new ValidationError('Review kits, lot-tracked, serial-tracked or unusually large backorders individually.');
 if(lock)await db.query('SELECT sku_id FROM balances WHERE workspace_id=$1 AND location_id=$2 AND sku_id=ANY($3::text[]) ORDER BY sku_id FOR UPDATE',[ctx.workspaceId,order.fulfillment_location_id,lines.map(l=>l.sku_id)]);
 const quantities=[],free=new Map();let amount=0;
 for(const line of lines){
  const needed=exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(line.quantity_ordered,line.quantity_fulfilled),line.direct_committed_quantity||0),line.allocated),{signed:true});
  if(!free.has(line.sku_id))free.set(line.sku_id,(await require('../transfers/postgres-transfer-service').sourceAvailable(db,ctx.workspaceId,line.sku_id,order.fulfillment_location_id)).available);
  const available=free.get(line.sku_id),quantity=Math.max(0,Math.min(needed,available));
  if(quantity){
   const earlier=(await db.query(`SELECT o.order_number FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
    WHERE o.workspace_id=$1 AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL AND l.sku_id=$2
     AND (o.fulfillment_location_id=$3 OR o.fulfillment_location_id IS NULL)
     AND (o.allocation_priority,coalesce(o.needed_by,'9999-12-31'),o.created_at,o.id)<($4,$5,$6,$7)
     AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)
    ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 1`,[ctx.workspaceId,line.sku_id,order.fulfillment_location_id,order.allocation_priority,order.needed_by||'9999-12-31',order.created_at,order.id])).rows[0];
   if(earlier)throw new ValidationError('Order '+earlier.order_number+' has priority for this stock. Review it first.');
   amount+=require('../pricing/calculator').ratio(Number(line.unit_price_minor),Math.round(quantity*1000000),1000000);
   quantities.push({lineId:line.id,skuId:line.sku_id,code:line.code,quantity});free.set(line.sku_id,exact.safeNumber(exact.subtract(available,quantity),{signed:true}));
  }
 }
 if(!quantities.length)throw new ValidationError('No uncommitted stock has arrived for this backorder.');
 const snapshot={version:Number(order.version),status:order.status,customer:order.customer_id,currency:order.currency,location:order.fulfillment_location_id,delivery:order.delivery_method,address:order.ship_to_address,priority:order.allocation_priority,neededBy:order.needed_by,lines,quantities};
 const training=require('../autopilot/draft-authority').scope(order.customer_id,order.currency,amount,['arrived-stock',order.fulfillment_location_id,order.delivery_method,order.ship_to_address,...lines.map(l=>l.sku_id).sort()],order.customer_name+' · reserve arrived stock at '+order.location_name);
 return {order,quantities,fingerprint:hash(snapshot),training};
}
async function build(db,ctx,row){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
 const p=await inspect(db,ctx,row.id);
 return {payload:{recordId:row.id,orderNumber:p.order.order_number,customerName:p.order.customer_name,locationName:p.order.location_name,fingerprint:p.fingerprint,quantities:p.quantities,training:p.training},
  summary:'Reserve arrived stock for '+p.order.order_number+' at '+p.order.location_name+': '+p.quantities.map(l=>l.quantity+' × '+l.code).join(', ')+'. The existing order prices and delivery details stay in place. Goods still need physical picking and handoff.'};
}
async function execute(db,ctx,p){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'draft');
 const now=await inspect(db,ctx,p.recordId,{lock:true});
 if(now.fingerprint!==p.fingerprint)throw new ValidationError('This backorder, stock availability or priority changed. Review a fresh reservation.');
 if(ctx.agentArrivedStockScope==='automatic'){
  const rule=(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[ctx.workspaceId,action,p.training.key,p.training.currency])).rows[0];
  if(rule&&Number(rule.maximum_minor)<now.training.amountMinor)throw new ValidationError('This reservation exceeds the saved owner limit. Review it individually.');
 }
 const result=await require('../operations/postgres-business-workflows').confirmSalesOrderInTransaction(db,ctx,p.recordId,{idempotencyKey:p.idempotencyKey,resumeRemaining:now.order.status==='PARTIALLY_FULFILLED'});
 const normalized=rows=>rows.map(r=>({lineId:r.lineId,locationId:r.locationId,quantity:r.quantity})).sort((a,b)=>a.lineId.localeCompare(b.lineId));
 const expected=p.quantities.map(q=>({lineId:q.lineId,locationId:now.order.fulfillment_location_id,quantity:q.quantity}));
 if(!require('node:util').isDeepStrictEqual(normalized(result.allocations),normalized(expected)))throw new ValidationError('The recorded reservation differs from the reviewed arrived stock. Nothing was committed.');
 return {...result,units:p.quantities.reduce((n,q)=>n+q.quantity,0)};
}
async function requireRoutineAuthority(db,ctx){
 await policy.requireWorkspaceJob(db,ctx.workspaceId,job,'automatic',{trained:true});
 const grant=(await db.query(`SELECT m.revision FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id WHERE m.workspace_id=$1 AND m.job_id=48 AND m.mode='routine' AND u.id=$2
  AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL) FOR SHARE OF m,u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!grant||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)throw new ValidationError('The owner must enable arrived-stock reservations and automatic work first.');
 return {kind:'standing_job_rule',job,ownerId:ctx.actorId,modeRevision:Number(grant.revision)};
}
async function run(db,workspaceId){
 const result={reserved:0,held:0},grant=(await db.query(`SELECT m.updated_by FROM stockchief_runtime.agent_job_modes m JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id WHERE m.workspace_id=$1 AND m.job_id=48 AND m.mode='routine' AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[workspaceId])).rows[0];
 const state=await policy.accountState(db,workspaceId);
 if(!grant||!policy.usesAgentTerms(state)||!policy.permits(state.plan,job,'automatic',{trained:true})||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return result;
 const ctx={workspaceId,actorId:grant.updated_by},candidates=(await db.query(`SELECT o.id FROM sales_orders o LEFT JOIN stockchief_runtime.agent_arrived_stock_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND o.confirmed_at IS NOT NULL
  AND EXISTS(SELECT 1 FROM sales_order_lines l JOIN balances b ON b.workspace_id=l.workspace_id AND b.sku_id=l.sku_id AND b.location_id=o.fulfillment_location_id
   WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id AND b.on_hand>0 AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)
   AND (checked.retry_after IS NULL OR checked.retry_after<=now() OR b.updated_at::timestamptz>checked.checked_at OR o.updated_at::timestamptz>checked.checked_at))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 20`,[workspaceId])).rows;
 for(const candidate of candidates){
  const reserved=await db.transaction(async c=>{
   const scoped={query:(...args)=>c.query(...args),transaction:fn=>fn(c)};
   await c.query('SAVEPOINT arrived_stock');
   try{
    const prepared=await build(c,ctx,candidate);
    const assistant=require('../assistant/postgres-service'),proposal=await assistant.createProposal(scoped,{...ctx,planStepKey:'arrived-stock:'+candidate.id+':'+prepared.payload.fingerprint},'Reserve arrived stock for this confirmed backorder',action,prepared.payload,prepared.summary);
    const done=await assistant.executeArrivedStockRoutine(scoped,ctx,proposal.proposal.id);await c.query('RELEASE SAVEPOINT arrived_stock');await checked(c,candidate.id,null);return !done.replayed;
   }catch(error){if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;await c.query('ROLLBACK TO SAVEPOINT arrived_stock');await c.query('RELEASE SAVEPOINT arrived_stock');await checked(c,candidate.id,error.message);return false;}
   async function checked(c,id,problem){await c.query(`INSERT INTO stockchief_runtime.agent_arrived_stock_checks(workspace_id,sales_order_id,checked_at,retry_after,problem) VALUES($1,$2,clock_timestamp(),clock_timestamp()+interval '15 minutes',$3)
    ON CONFLICT(workspace_id,sales_order_id) DO UPDATE SET checked_at=EXCLUDED.checked_at,retry_after=EXCLUDED.retry_after,problem=EXCLUDED.problem`,[workspaceId,id,problem]);}
  },{isolation:'SERIALIZABLE',retrySafe:true});result[reserved?'reserved':'held']++;
 }
 return result;
}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",l.name "Dispatch from",coalesce(checked.problem,'Waiting for available stock') "Last check",'/sales/orders/'||o.id link
  FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN locations l ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id
  LEFT JOIN stockchief_runtime.agent_arrived_stock_checks checked ON checked.workspace_id=o.workspace_id AND checked.sales_order_id=o.id
  WHERE o.workspace_id=$1 AND o.status IN('BACKORDERED','PARTIALLY_FULFILLED') AND ($2='' OR lower(o.order_number)=lower($2) OR lower(c.name)=lower($2))
  ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const state=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,state,action,false);
 return {summary:'Sets aside available stock for already confirmed backorders in their recorded warehouse and priority. Growth needs a taught customer, product and value scope; Pro and Custom honor saved owner limits. Kits, lot and serial reservations need individual review. Physical picking and shipping stay separate.',rows:rows.slice(0,100),more:rows.length>100,arrivedStockForm:{blocked}};
}
const spec={name:action,description:'Reserve newly available stock for an already confirmed backorder in its recorded dispatch warehouse, respecting existing order priority. Preserve prices and delivery details; never receive, ship or invoice goods.',
 record:'sales_order',fields:['recordReference'],permission:require('../actions/permissions').MANAGE_SALES,capability:'sales_orders.core',ownerOnly:true,build,execute,resultingRecords:['sales_order_allocations','sales_order_events'],
 verify:async(db,ctx,r,p)=>Boolean(r.salesOrderId===p.recordId&&r.allocations?.length&&(await db.query(`SELECT 1 FROM stockchief_runtime.business_operations op
  JOIN sales_order_events e ON e.workspace_id=op.workspace_id AND e.idempotency_key=op.idempotency_key||':event' AND e.event_type='confirmed'
  JOIN sales_orders o ON o.workspace_id=e.workspace_id AND o.id=e.sales_order_id AND o.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
  WHERE op.workspace_id=$1 AND op.idempotency_key=$2 AND op.kind='sales_order.confirm' AND op.status='COMPLETED'
   AND o.id=$3 AND op.result->>'salesOrderId'=o.id AND op.result->'allocations'=$4::jsonb AND e.detail::jsonb->'allocations'=$4::jsonb`,[ctx.workspaceId,p.idempotencyKey,p.recordId,JSON.stringify(r.allocations)])).rows.length)};
module.exports={spec,inspect,build,execute,run,requireRoutineAuthority,definition:{id:48,key:'arrived-stock',label:'Reserve arrived stock for waiting orders',filterLabel:'Order number or customer',readPage:review}};
