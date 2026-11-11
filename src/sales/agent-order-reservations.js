'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),{hash}=require('../pricing/postgres-promotions'),exact=require('../domain/exact-quantity');
async function facts(db,ctx,id,{allowPartial=false}={}){
 const o=(await db.query(`SELECT o.*,c.name customer_name,c.record_state,c.email customer_email,c.phone customer_phone,loc.name location_name FROM sales_orders o
 JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN locations loc ON loc.workspace_id=o.workspace_id AND loc.id=o.fulfillment_location_id WHERE o.workspace_id=$1 AND o.id=$2`,[ctx.workspaceId,id])).rows[0];
 if(!o||!['DRAFT','CONFIRMED','BACKORDERED',...(allowPartial?['PARTIALLY_FULFILLED']:[])].includes(o.status)||o.record_state!=='ACTIVE')throw new ValidationError('Choose an open order for an active customer.');
 const lines=(await db.query(`SELECT l.id,l.sku_id,l.quantity_ordered::text,l.quantity_fulfilled::text,coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)::text direct_committed_quantity,l.unit_price_minor::text,s.code,i.name,i.unit_label,s.is_active sku_active,i.is_active item_active,i.tracking_mode,i.quantity_precision,i.secondary_unit_label,
 coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)::text allocated,
 EXISTS(SELECT 1 FROM sales_order_kit_components k WHERE k.workspace_id=l.workspace_id AND k.sales_order_line_id=l.id) kit
 FROM sales_order_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE l.workspace_id=$1 AND l.sales_order_id=$2 ORDER BY l.sku_id,l.id LIMIT 101`,[ctx.workspaceId,id])).rows;
 if(!lines.length||lines.length>100)throw new ValidationError('Review orders with one to 100 lines in this reservation workflow.');
 const supported=Boolean(o.fulfillment_location_id)&&lines.every(l=>l.tracking_mode==='quantity'&&Number(l.quantity_precision)===0&&!l.secondary_unit_label&&!l.kit&&Number(l.sku_active)===1&&Number(l.item_active)===1),products=lines.map(l=>({skuId:l.sku_id,code:l.code,unitPriceMinor:l.unit_price_minor}));
 let amountMinor=0;for(const l of lines)amountMinor+=exact.costMinor(exact.subtract(exact.subtract(l.quantity_ordered,l.quantity_fulfilled),l.direct_committed_quantity||0),Number(l.unit_price_minor));
 require('../domain/currency').integer(amountMinor,'Open order goods value');
 const profile={customerId:o.customer_id,customerName:o.customer_name,email:o.customer_email,phone:o.customer_phone,currency:o.currency,locationId:o.fulfillment_location_id,location:o.location_name,deliveryMethod:o.delivery_method,address:o.ship_to_address||null,products};
 const fingerprint=hash({version:Number(o.version),status:o.status,profile,priority:o.allocation_priority,neededBy:o.needed_by,customerDecision:o.customer_decision_required,deliveryDecision:o.delivery_decision_required,lines});
 return {order:o,lines,profile,fingerprint,supported,amountMinor};
}
function training(f,action,priority,neededBy){
 const extra=action==='sales_order.allocation_priority'?{priority,neededBy:neededBy||null}:{};
 return f.supported&&f.amountMinor>0?require('../autopilot/draft-authority').scope(f.order.customer_id,f.order.currency,f.amountMinor,[action,f.profile,extra],f.order.customer_name+' · '+f.profile.products.map(p=>p.code).join(', ')+' · '+f.order.delivery_method+' · '+(action==='sales_order.allocation_priority'?'priority '+priority:'full reservation')):null;
}
function summary(f){return {order:f.order.order_number,customer:f.order.customer_name,location:f.order.location_name||'Choose separately',delivery:f.order.delivery_method==='PICKUP'?'Customer pickup':f.order.ship_to_address,goodsValueMinor:f.amountMinor,currency:f.order.currency,lines:f.lines.map(l=>({sku:l.code,name:l.name,unit:l.unit_label,toReserve:Math.max(0,exact.safeNumber(exact.subtract(exact.subtract(exact.subtract(l.quantity_ordered,l.quantity_fulfilled),l.direct_committed_quantity||0),l.allocated),{signed:true})),alreadyReserved:Number(l.allocated)}))};}
async function buildReservation(db,ctx,row){
 const count=(await db.query('SELECT count(*)::int n FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,row.id])).rows[0].n;
 if(count>100)return {payload:{recordId:row.id},summary:'Individually confirm every remaining unit for '+row.order_number+' only if the whole order can be reserved now. Large orders need individual review.'};
 const f=await facts(db,ctx,row.id);return {payload:{recordId:row.id,expectedVersion:Number(f.order.version),reservationSummary:summary(f),reservationFingerprint:f.fingerprint,training:training(f,'sales_order.reserve_all')},summary:'Reserve every remaining unit for '+f.order.order_number+' only if current stock covers the whole order. Keep prices and delivery details unchanged. No goods are picked, shipped or invoiced.'};
}
async function addPriorityScope(db,ctx,row,args,p){
 if((await db.query('SELECT count(*)::int n FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,row.id])).rows[0].n>100)return p;
 const f=await facts(db,ctx,row.id);return {...p,reservationSummary:summary(f),beforePriority:Number(f.order.allocation_priority),beforeNeededBy:f.order.needed_by||null,reservationFingerprint:f.fingerprint,training:training(f,'sales_order.allocation_priority',p.priority,p.neededBy)};
}
async function current(db,ctx,p){
 const f=await facts(db,ctx,p.recordId);if(!p.reservationFingerprint||p.reservationFingerprint!==f.fingerprint)throw new ValidationError('This order, customer, price, delivery, priority or reservation changed after review. Prepare a fresh request.');return f;
}
async function automaticAuthority(db,ctx,p,action){
 if(!p.reservationFingerprint)throw new ValidationError('Prepare a current, bounded customer reservation before automatic handling. Large or older requests need individual review.');
 if(!(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the inventory owner can authorize customer stock reservation routines.');
 const f=await current(db,ctx,p);if(!f.supported)throw new ValidationError('Review kits, measured or tracked goods, and orders without an exact dispatch location individually.');
 await require('../operations/postgres-warehouse-access').assertLocations(db,ctx,[f.order.fulfillment_location_id]);
 const loc=(await db.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,f.order.fulfillment_location_id])).rowCount;if(!loc)throw new ValidationError('Choose an active, owned dispatch location.');
 if(Number(f.order.customer_decision_required)||Number(f.order.delivery_decision_required)||!(await db.query(`SELECT 1 FROM sales_orders o WHERE o.workspace_id=$1 AND o.customer_id=$2 AND o.id<>$3
 AND o.status IN('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED','FULFILLED') AND coalesce(o.customer_decision_required,0)=0 AND coalesce(o.delivery_decision_required,0)=0
 AND o.delivery_method=$4 AND o.fulfillment_location_id=$6 AND ($4='PICKUP' OR lower(trim(o.ship_to_address))=lower(trim($5))) LIMIT 1`,[ctx.workspaceId,f.order.customer_id,f.order.id,f.order.delivery_method,f.order.ship_to_address||'',f.order.fulfillment_location_id])).rowCount)throw new ValidationError('The first order for a new customer or delivery address needs its own individual confirmation.');
 const bound=training(f,action,p.priority,p.neededBy);if(!bound||hash(bound)!==hash(p.training))throw new ValidationError('Review a current customer, product, price, location, delivery and value scope.');
 if(action==='sales_order.reserve_all'){
  const earlier=(await db.query(`SELECT prior.order_number FROM sales_orders prior JOIN sales_order_lines l ON l.workspace_id=prior.workspace_id AND l.sales_order_id=prior.id
   WHERE prior.workspace_id=$1 AND prior.id<>$2 AND prior.status IN('BACKORDERED','CONFIRMED','PARTIALLY_FULFILLED') AND prior.confirmed_at IS NOT NULL
    AND (prior.fulfillment_location_id=$3 OR prior.fulfillment_location_id IS NULL) AND l.sku_id=ANY($4::text[])
    AND l.quantity_ordered-l.quantity_fulfilled-coalesce((to_jsonb(l)->>'direct_committed_quantity')::numeric,0)>coalesce((SELECT sum(a.quantity) FROM sales_order_allocations a WHERE a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id),0)
    AND (prior.allocation_priority,coalesce(prior.needed_by,'9999-12-31'),prior.created_at,prior.id)<($5,$6,$7,$2)
   ORDER BY prior.allocation_priority,prior.needed_by NULLS LAST,prior.created_at,prior.id LIMIT 1`,[ctx.workspaceId,f.order.id,f.order.fulfillment_location_id,f.lines.map(l=>l.sku_id),f.order.allocation_priority,f.order.needed_by||'9999-12-31',f.order.created_at])).rows[0];
  if(earlier)throw new ValidationError('Order '+earlier.order_number+' has priority for this scarce stock. Review that order first. Existing commitments are never taken away.');
 }
 return f;
}
async function review(db,ctx){const rows=(await db.query(`SELECT o.order_number "Order",c.name "Customer",l.name "Dispatch from",o.allocation_priority "Priority",o.needed_by "Needed by",o.status "Status",'/orders/'||o.id link FROM sales_orders o JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id LEFT JOIN locations l ON l.workspace_id=o.workspace_id AND l.id=o.fulfillment_location_id WHERE o.workspace_id=$1 AND o.status IN('DRAFT','CONFIRMED','BACKORDERED') ORDER BY o.allocation_priority,o.needed_by NULLS LAST,o.created_at,o.id LIMIT 101`,[ctx.workspaceId])).rows;return {rows:rows.slice(0,100),more:rows.length>100,summary:'Ask StockChief to reserve an exact existing order in full, or set its exact allocation priority and needed-by date. Pro learns the customer, product, price, warehouse, delivery and goods-value scope from a completed individual approval. Custom can carry out an exact authorized request without training. Scarce stock stays with earlier confirmed priority orders; existing commitments and physical goods stay in place.'};}
const definitions=[{id:12,key:'customer-full-reservations',label:'Reserve a customer order in full',readPage:review},{id:65,key:'customer-stock-priorities',label:'Apply customer stock priorities',readPage:review}];
async function completedExample(db,ctx,p){
 if(p.status!=='EXECUTED'||p.result?.automatic!==false||p.result?.replayed===true||!p.payload?.reservationFingerprint)return false;
 if(p.action_type==='sales_order.allocation_priority')return Number(p.result.version)===Number(p.payload.expectedVersion)+1;
 return Boolean(p.result?.allocations?.length&&(await db.query(`SELECT 1 FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND idempotency_key=$2 AND kind='sales_order.confirm' AND status='COMPLETED' AND result->>'salesOrderId'=$3 AND result->'allocations'=$4::jsonb`,[ctx.workspaceId,p.idempotency_key,p.payload.recordId,JSON.stringify(p.result.allocations)])).rowCount);
}
module.exports={facts,buildReservation,addPriorityScope,current,automaticAuthority,definitions,completedExample};
