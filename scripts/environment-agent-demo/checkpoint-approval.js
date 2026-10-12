'use strict';
// Host-only evaluation policy. It rejects effects outside the task; it never
// approves anything itself. Matching proposals still require a human decision.
async function pending(db,ctx){
 const actions=(await db.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND actor_user_id=$2 AND status='PENDING' ORDER BY created_at,id`,[ctx.workspaceId,ctx.actorId])).rows;
 const rules=(await db.query(`SELECT * FROM operating_instruction_proposals WHERE workspace_id=$1 AND created_by_user_id=$2 AND status='PENDING' ORDER BY created_at,id`,[ctx.workspaceId,ctx.actorId])).rows;
 const parse=value=>typeof value==='string'?JSON.parse(value):value;
 return [...actions.map(r=>({...r,payload:parse(r.payload)})),...rules.map(r=>({...r,action_type:'policy.propose',payload:parse(r.resolved_changes)}))];
}
async function permits(db,f,p){
 const t=f.task,x=p.payload;
 if(t.kind==='receive')return p.action_type==='inventory.receive'&&x.skuId===f.product.skuIds[0]&&x.locationId===f.warehouse.id&&x.quantity===t.receive&&x.reference===t.reference;
 if(t.kind==='new-po'){
  if(p.action_type==='contact.create')return x.kind==='supplier'&&x.name===t.newSupplier&&x.email===t.newEmail;
  if(p.action_type==='purchase_order.create'){
   const supplier=(await db.query('SELECT name,email FROM suppliers WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,x.supplierId])).rows[0];
   return supplier?.name===t.newSupplier&&supplier.email===t.newEmail&&x.destinationLocationId===f.overflow.id&&x.currency==='USD'&&
    x.poNumber===t.newPo&&x.lines?.length===1&&x.lines[0].skuId===f.washer.skuIds[0]&&x.lines[0].quantityUnits===t.orderQuantity&&x.lines[0].unitCost===t.unitCost;
  }
 }
 if(t.kind==='price-cost')return x.skuId===f.product.skuIds[0]&&x.currency==='USD'&&
  (p.action_type==='catalog.set_price'&&x.amountMinor===t.sellingMinor||p.action_type==='catalog.set_purchase_cost'&&x.amountMinor===t.costMinor);
 if(t.kind==='rule')return p.action_type==='policy.propose'&&x.length===1&&x[0].domain==='stock_alert'&&x[0].operation==='set'&&
  x[0].skuId===f.product.skuIds[0]&&x[0].locationId===f.warehouse.id&&x[0].notificationThreshold===t.threshold&&
  x[0].notificationMetric==='on_hand'&&x[0].notificationComparator==='at_or_below';
 return false;
}
async function execute(db,ctx,p,options){return p.action_type==='policy.propose'?
 require('../../src/manager/postgres-operating-instructions').approve(db,ctx,p.id,p.integrity_hash):
 require('../../src/assistant/postgres-service').executeProposal(db,ctx,p.id,options);}
module.exports={pending,permits,execute};
