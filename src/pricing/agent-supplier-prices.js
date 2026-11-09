'use strict';
const {ValidationError}=require('../domain/errors'),prices=require('./postgres-service'),money=require('../domain/currency'),{hash}=require('./postgres-promotions');
async function snapshot(db,ctx,id,page=1){
 page=Number(page);if(!Number.isSafeInteger(page)||page<1||page>1000000)throw new ValidationError('Choose a valid supplier price-list page.');
 const plan=(await db.query('SELECT id,source_name,integrity_hash,status FROM import_plans WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
 if(!plan||plan.status!=='READY')throw new ValidationError('Choose a current supplier price-list preview.');
 if((await db.query("SELECT 1 FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND parsed::jsonb->>'existingSkuId' IS NOT NULL GROUP BY parsed::jsonb->>'existingSkuId' HAVING count(*)>1 LIMIT 1",[ctx.workspaceId,id])).rowCount)
  throw new ValidationError('Include each SKU once in the supplier price list.');
 const rows=(await db.query('SELECT row_number,parsed::jsonb AS parsed,status FROM import_rows WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_number LIMIT 101 OFFSET $3',[ctx.workspaceId,id,(page-1)*100])).rows;
 const more=rows.length>100;if(more)rows.pop();
 if(!rows.length)throw new ValidationError('There are no supplier prices on this page.');
 const changes=[],seen=new Set();
 for(const row of rows){
  const p=row.parsed;
  if(row.status!=='VALID'||!p.existingSkuId||!Number.isSafeInteger(p.unitCostMinor)||p.unitCostMinor<0||p.quantity>0)
   throw new ValidationError('Every price-list row needs one existing SKU, an exact purchase cost and currency, and no physical stock. Resolve the file preview first.');
  if(seen.has(p.existingSkuId))throw new ValidationError('Include each SKU once in the supplier price list.');seen.add(p.existingSkuId);
  const sku=(await db.query('SELECT s.id,s.code,i.name FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1',[ctx.workspaceId,p.existingSkuId])).rows[0];
  if(!sku)throw new ValidationError('A source product is no longer active.');
  const currency=money.code(p.currency),cost=await prices.purchaseCost(db,ctx.workspaceId,sku.id);
  if(cost&&Number(cost.amount_minor)===p.unitCostMinor&&cost.currency===currency)continue;
  const before=cost?{id:cost.id||null,amountMinor:Number(cost.amount_minor),currency:cost.currency}:null;
  const difference=before?BigInt(p.unitCostMinor)-BigInt(before.amountMinor):0n;
  const overReviewThreshold=!before||before.currency!==currency||before.amountMinor===0||
   (difference<0n?-difference:difference)*100n>BigInt(before.amountMinor)*5n;
  changes.push({skuId:sku.id,code:sku.code,name:sku.name,before,amountMinor:p.unitCostMinor,currency,overReviewThreshold});
 }
 if(!changes.length)throw new ValidationError('These source prices already match the current purchase costs.');
 return {source:{id:plan.id,name:plan.source_name,integrityHash:plan.integrity_hash},page,more,changes};
}
async function build(db,ctx,row,args){
 const data=await snapshot(db,ctx,row.id,args.sourcePage??1),currencies=[...new Set(data.changes.map(c=>c.currency))];
 const training=currencies.length===1?require('../autopilot/draft-authority').scope('supplier-prices',currencies[0],Math.max(...data.changes.map(c=>c.amountMinor)),
  {skus:data.changes.map(c=>c.skuId).sort(),reviewThreshold:5},'Supplier price-list updates for these exact SKUs. The limit is the highest unit cost in the file. A change over 5%, a new cost or a currency change always needs separate approval.'):null;
 return {payload:{recordId:row.id,...data,fingerprint:hash(data),overReviewThreshold:data.changes.some(c=>c.overReviewThreshold),...(training&&training.amountMinor>0?{training}:{})},
  summary:'Update purchase costs from '+data.source.name+', page '+data.page+': '+data.changes.map(c=>c.code+' from '+(c.before?money.format(c.before.amountMinor,c.before.currency):'no saved cost')+' to '+money.format(c.amountMinor,c.currency)+(c.overReviewThreshold?' (separate approval required)':' (within 5%)')).join('; ')+'. Existing stock value stays at its recorded receipt cost.'+(data.more?' More supplier prices remain; continue with sourcePage '+(data.page+1)+'.':'')};
}
async function execute(db,ctx,p){
 const data=await snapshot(db,ctx,p.recordId,p.page);
 if(hash(data)!==p.fingerprint||hash({source:p.source,page:p.page,more:p.more,changes:p.changes})!==p.fingerprint)throw new ValidationError('The source prices or current costs changed. Review this price list again.');
 const ids=[];
 for(const c of data.changes){const saved=await prices.setPurchaseCostInTransaction(db,ctx,{skuId:c.skuId,amountMinor:c.amountMinor,currency:c.currency,expectedCurrentId:c.before?.id||null,
  source:'agent_supplier_price_list',sourceDetail:{importId:data.source.id,sourceName:data.source.name}});ids.push(saved.id);}
 return {ids,prices:ids.length};
}
async function verify(db,ctx,r,p){
 const rows=(await db.query("SELECT sku_id,amount_minor,currency,source_detail FROM sku_purchase_costs WHERE workspace_id=$1 AND id=ANY($2::text[]) AND source='agent_supplier_price_list'",[ctx.workspaceId,r.ids])).rows;
 return rows.length===p.changes.length&&rows.every(row=>p.changes.some(c=>c.skuId===row.sku_id&&c.amountMinor===Number(row.amount_minor)&&c.currency===row.currency)&&
  (typeof row.source_detail==='string'?JSON.parse(row.source_detail):row.source_detail).importId===p.recordId);
}
module.exports={snapshot,spec:{name:'catalog.supplier_price_list',record:'import_plan',fields:['recordReference','sourcePage'],permission:require('../actions/permissions').ADMIN,ownerOnly:true,capability:'purchasing.suppliers',
 description:'Read an existing supplier price-list preview and update only purchase costs for existing SKUs, 100 source rows per sourcePage. Continue through every page shown by the source. No stock or selling prices change. Every change above 5%, missing baseline or different currency requires individual owner approval. Pro requires an owner-taught exact-SKU rule for routine changes.',build,execute,verify}};
