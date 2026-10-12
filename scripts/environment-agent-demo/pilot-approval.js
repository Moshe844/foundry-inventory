'use strict';
// Private deterministic test-operator policy. Not a model tool. Each approved
// proposal counts as one simulated human approval, never autonomous execution.
async function permits(db,f,proposal){
 const p=proposal.payload,type=proposal.action_type;
 if(f.task.id==='dependent-order'){
  if(type==='contact.create')return p.kind==='customer'&&p.name==='Juniper Workshop'&&p.email==='orders@juniper.example.test'&&!p.phone&&!p.notes;
  if(type==='sales_order.create'){
   const customer=(await db.query('SELECT name,email FROM customers WHERE workspace_id=$1 AND id=$2',[f.ctx.workspaceId,p.customerId])).rows[0];
   return customer?.name==='Juniper Workshop'&&customer.email==='orders@juniper.example.test'&&p.deliveryMethod==='PICKUP'&&p.fulfillmentLocationId===f.warehouse.id&&p.currency==='USD'&&p.reference==='JW-PILOT-38'&&
    p.lines?.length===2&&p.lines.some(l=>l.skuId===f.product.skuIds[0]&&l.quantity===3&&l.unitPriceMinor===1200)&&p.lines.some(l=>l.skuId===f.washer.skuIds[0]&&l.quantity===2&&l.unitPriceMinor===400);
  }
 }
 if(f.task.id==='catalogue-and-price'){
  if(type==='catalog.create_item')return p.name==='Drift spacer'&&p.baseCode==='DRIFT-28'&&p.trackingMode==='quantity';
  if(type==='catalog.set_price')return p.amountMinor===825&&p.currency==='USD'&&Boolean((await db.query(`SELECT 1 FROM skus s JOIN items i ON i.id=s.item_id
   WHERE s.workspace_id=$1 AND s.id=$2 AND s.code='DRIFT-28' AND i.name='Drift spacer'`,[f.ctx.workspaceId,p.skuId])).rows[0]);
 }
 return false;
}
module.exports={permits};
