'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('the agent uses exact stocking units and the selected supplier pack on each eligible plan',{timeout:180000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
  const catalog=require('../../src/domain/postgres-catalog-service'),commerce=require('../../src/operations/postgres-commerce');
  const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await subscribe('pro');
  await commerce.linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:sku,purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:1});
  const contract=require('../../src/assistant/postgres-capability-registry').registry.get('read.unit_conversion');
  const read=args=>contract.prepare(null,db,ctx,'Convert these units',args);
  await subscribe('starter');await assert.rejects(read({sku:code,unitQuantity:'3',fromUnit:'case'}),e=>e.code==='entitlement_required');
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);const result=await read({sku:code,unitQuantity:'3',fromUnit:'case'});
    assert.equal(result.rows[0]['Stock quantity'],'36');assert.equal(result.rows[0]['Ready to record'],'Yes');
  }
  const second=await commerce.createSupplier(db,ctx,{name:'Second pack supplier'});
  await commerce.linkSupplierItem(db,ctx,{supplierId:second.id,skuId:sku,purchaseUnit:'case',unitsPerPurchaseUnit:24,lastUnitCost:1});
  await assert.rejects(read({sku:code,unitQuantity:'3',fromUnit:'case'}),/Choose the supplier/);
  assert.equal((await read({sku:code,unitQuantity:'3',fromUnit:'case',supplier:'Second pack supplier'})).rows[0]['Stock quantity'],'72');
  const weight=await catalog.createItem(db,ctx,{name:'Measured flour',baseCode:'FLOUR-KG',trackingMode:'quantity'});
  await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,weight.itemId,{unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'}));
  const conversion=await read({sku:'FLOUR-KG',unitQuantity:'1',fromUnit:'lb'});
  assert.equal(conversion.rows[0]['Stock quantity'],'0.45359237');assert.equal(conversion.rows[0]['Ready to record'],'Review quantity');
  assert.equal((await read({sku:'FLOUR-KG',unitQuantity:'1250',fromUnit:'g'})).rows[0]['Stock quantity'],'1.25');
  await assert.rejects(read({sku:'FLOUR-KG',unitQuantity:'1e3',fromUnit:'g'}),/decimal/);
  await assert.rejects(read({sku:'FLOUR-KG',unitQuantity:'1',fromUnit:'m'}),/pack size|compatible/);
  const other=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Other units'});
  await assert.rejects(require('../../src/domain/agent-unit-conversion').read(db,{...ctx,workspaceId:other.workspaceId},{sku:code,unitQuantity:'3',fromUnit:'case'}));
  assert.equal(await f.balance(),4,'Conversion queries never post stock');
});
