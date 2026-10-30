'use strict';
const crypto=require('node:crypto'),{ValidationError,NotFoundError}=require('./errors'),{requireText,newId}=require('../lib/util');
async function describe(database,ctx,itemId){
 const item=(await database.query('SELECT * FROM items WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,itemId])).rows[0];if(!item)throw new NotFoundError('That product is not in this inventory.');
 const skus=(await database.query(`SELECT s.*,COALESCE((SELECT jsonb_agg(jsonb_build_object('name',o.name,'value',v.value) ORDER BY o.position,o.id) FROM sku_option_values v JOIN item_options o ON o.id=v.option_id AND o.workspace_id=s.workspace_id WHERE v.sku_id=s.id),'[]'::jsonb) AS options
   FROM skus s WHERE s.workspace_id=$1 AND s.item_id=$2 ORDER BY s.position,s.id LIMIT 1001`,[ctx.workspaceId,itemId])).rows;
 if(skus.length>1000)throw new ValidationError('This product has more than 1,000 variants. Use a reviewed file import to copy its full variant catalog.');
 const prices=(await database.query('SELECT DISTINCT ON (sku_id) sku_id,id,amount_minor,currency FROM sku_prices WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) ORDER BY sku_id,created_at DESC,id DESC',[ctx.workspaceId,skus.map(s=>s.id)])).rows;
 const hash=crypto.createHash('sha256').update(JSON.stringify({item,skus,prices})).digest('hex');return {item,skus,prices,hash};
}
async function copy(database,ctx,itemId,input){
 if((await database.query('SELECT role FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0]?.role!=='owner')throw new ValidationError('Only an owner can duplicate product prices and configuration.');
 return database.transaction(async client=>{
  const key=requireText(input.idempotencyKey,'Duplicate request',{max:200});
  const name=requireText(input.name,'New product name',{max:240}),base=requireText(input.code,'New product code',{max:200});
  const intent=crypto.createHash('sha256').update(JSON.stringify([itemId,input.sourceHash,name,base])).digest('hex');
  const operationId=newId('pgop');
  const inserted=await client.query(`INSERT INTO stockchief_runtime.business_operations(id,workspace_id,kind,idempotency_key)
    VALUES($1,$2,'catalog.copy',$3) ON CONFLICT(workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,[operationId,ctx.workspaceId,key]);
  if(!inserted.rowCount){
   const prior=(await client.query("SELECT status,result FROM stockchief_runtime.business_operations WHERE workspace_id=$1 AND kind='catalog.copy' AND idempotency_key=$2 FOR UPDATE",[ctx.workspaceId,key])).rows[0];
   if(prior?.status!=='COMPLETED')throw new ValidationError('This product copy is already being processed.');
   if(prior.result.intent!==intent)throw new ValidationError('This duplicate request was already used with different details. Open a fresh duplicate form.');
   return {...prior.result.result,replayed:true};
  }
  const source=await describe(client,ctx,itemId);if(source.hash!==input.sourceHash)throw new ValidationError('The source product or its prices changed. Review the duplicate again.');
  const result=await require('./postgres-catalog-service').createImportedItemInTransaction(client,ctx,{name,description:source.item.description,unitLabel:source.item.unit_label,quantityPrecision:Number(source.item.quantity_precision),quantityIncrement:source.item.quantity_increment,secondaryUnitLabel:source.item.secondary_unit_label,secondaryPrecision:Number(source.item.secondary_precision),secondaryIncrement:source.item.secondary_increment,trackingMode:source.item.tracking_mode,
    variants:source.skus.map((s,i)=>({key:s.id,code:base+(source.skus.length>1?'-'+(i+1):''),options:s.options}))});
  const values=[];for(const sku of result.skus){const price=source.prices.find(p=>p.sku_id===sku.key);if(price)values.push({skuId:sku.skuId,amountMinor:price.amount_minor===null?null:Number(price.amount_minor),currency:price.currency,source:'approved_instruction',sourceDetail:{copiedFromItemId:itemId,copiedFromSkuId:sku.key}});}
  await require('../pricing/postgres-service').setPricesInTransaction(client,ctx,values);
  await client.query("UPDATE stockchief_runtime.business_operations SET status='COMPLETED',result=$2::jsonb,completed_at=now() WHERE id=$1",[operationId,JSON.stringify({intent,result})]);
  return {...result,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={describe,copy};
