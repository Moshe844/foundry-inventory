'use strict';
const {randomUUID}=require('node:crypto'),service=require('../../src/catalog/agent-product-retirements'),{hash}=require('../../src/pricing/postgres-promotions');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const supplier=(await db.query("SELECT id,name,email,status FROM suppliers WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId])).rows[0];
 async function pair(){
  const values=[];for(const label of ['Old','Replacement']){
   const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:label+' '+randomUUID(),baseCode:label+'-'+randomUUID().slice(0,8),trackingMode:'quantity'}),skuId=item.skuIds[0];
   await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:supplier.id,skuId,purchaseUnit:'each',unitsPerPurchaseUnit:1,lastUnitCost:1,isPreferred:true});
   const sku=(await db.query('SELECT id,code,item_id FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,skuId])).rows[0];values.push(sku);
  }return {old:values[0],replacement:values[1]};
 }
 const input=pairs=>({supplierId:supplier.id,reference:'NOTICE-'+randomUUID(),products:'Discontinued SKU,Replacement SKU\n'+pairs.map(p=>p.old.code+','+p.replacement.code).join('\n')});
 async function record(pairs){const raw=input(pairs),p=await service.preview(db,ctx,raw),n=await service.record(db,ctx,{...raw,sourceChecked:'yes',sourceFingerprint:p.sourceFingerprint});return {id:n.id,raw,p};}
 const authority=(revision,extra={})=>service.configure(db,ctx,supplier.id,{revision,maximumProducts:'2',confirmed:'yes',supplierFingerprint:hash(supplier),...extra});
 return {...f,supplier,pair,input,record,authority};
}
module.exports={fixture};
