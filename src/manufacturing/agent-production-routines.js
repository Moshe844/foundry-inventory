'use strict';
const prices=require('../pricing/postgres-service'),money=require('../domain/currency');
async function training(db,ctx,input){
 const bom=(await db.query("SELECT * FROM manufacturing_boms WHERE workspace_id=$1 AND id=$2 AND status='ACTIVE'",[ctx.workspaceId,input.bomId])).rows[0];
 const settings=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
 if(!bom||!settings)return null;
 const costs=[];
 for(const part of bom.definition.components){
  const cost=await prices.purchaseCost(db,ctx.workspaceId,part.skuId);
  if(!cost||cost.currency!==settings.base_currency)return null;
  costs.push({skuId:part.skuId,amountMinor:Number(cost.amount_minor),quantity:part.quantity});
 }
 const batches=Number(input.quantity)/bom.definition.outputQuantity;
 const amount=money.sum(costs.map(c=>require('../domain/exact-quantity').costMinor(c.quantity*batches,c.amountMinor)));
 if(amount<=0)return null;
 const product=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,bom.output_sku_id])).rows[0];
 return require('../autopilot/draft-authority').scope(bom.id,settings.base_currency,amount,{bomHash:bom.integrity_hash,costs},
  'Production drafts for '+product.code+' using this BOM revision and recorded component costs. The limit is estimated component cost; physical use and finished output need separate confirmation.');
}
module.exports={training};
