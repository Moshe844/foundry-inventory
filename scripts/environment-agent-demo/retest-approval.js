'use strict';
// Host scope check only. Each permitted proposal still needs a genuine human response.
const existing=require('./checkpoint-approval');
async function permits(db,f,p){
 const x=p.payload,t=f.task;
 if(t.kind==='reservation'){
  if(p.action_type==='location.create')return x.name===t.newLocation&&x.kind==='warehouse';
  if(p.action_type==='inventory.transfer'){
   const place=(await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND name=$2',[f.ctx.workspaceId,t.newLocation])).rows[0];
   return !!place&&x.skuId===f.product.skuIds[0]&&x.sourceLocationId===f.warehouse.id&&x.destinationLocationId===place.id&&
    x.quantity===t.reserveQuantity&&x.reference===t.reference;
  }
 }
 return t.kind==='retire-rule'&&p.action_type==='policy.propose'&&Array.isArray(x)&&x.length===1&&x[0].domain==='stock_alert'&&
  x[0].operation==='remove'&&x[0].skuId===f.product.skuIds[0]&&x[0].locationId===f.warehouse.id;
}
module.exports={pending:existing.pending,execute:existing.execute,permits};
