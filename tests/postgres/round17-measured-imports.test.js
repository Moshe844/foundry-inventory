'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('imports preserve configured fractional units, round cents once and resume exact count differences',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,location}=f;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES('measured-import-plan',$1,'pro','COMP','CUSTOM','ISOLATED_TEST')",[f.owner.accountId]);
 const catalog=require('../../src/domain/postgres-catalog-service'),imports=require('../../src/imports/postgres-service');
 const item=await catalog.createItem(db,ctx,{name:'Ground coffee',baseCode:'IMPORT-KG',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'}),skuId=item.skuIds[0];
 const position=async()=>{const row=(await db.query(`SELECT b.on_hand::text physical,c.quantity_units::text costed,c.total_cost_minor::text value
 FROM balances b JOIN accounting_inventory_cost_balances c USING(workspace_id,sku_id,location_id)
 WHERE b.workspace_id=$1 AND b.sku_id=$2 AND b.location_id=$3`,[ctx.workspaceId,skuId,location.id])).rows[0];return Object.fromEntries(Object.entries(row).map(([k,v])=>[k,Number(v)]));};
 async function preview(quantity,cost,importMode='add'){
  const plan=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity,Unit cost\nGround coffee,IMPORT-KG,${location.name},${quantity},${cost}`,filename:'measured-'+quantity+'-'+cost+'-'+importMode+'.csv',importMode,allowModel:false});
  assert.equal(plan.recordsInvalid,0,JSON.stringify(plan.rows?.map(r=>r.problems)));assert.equal(plan.recordsValid,1);return plan;
 }
 async function execute(plan){await imports.approve(db,ctx,plan.id,plan.integrityHash);const result=await imports.execute(db,ctx,plan.id);assert.equal(result.verified,true);return result;}
 await t.test('fractional receipt rounds 0.3 kg at $1.01 to $0.30 and replays without more stock',async()=>{
  const plan=await preview('0.3','1.01');await execute(plan);assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:30});const replay=await imports.execute(db,ctx,plan.id);assert.equal(replay.duplicate,true);assert.equal(replay.execution.status,'SUCCEEDED');assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:30});
 });
 await t.test('set-count reduction and increase use exact decimal differences and rounded value',async()=>{
  await execute(await preview('0.1','1.01','set'));assert.deepEqual(await position(),{physical:0.1,costed:0.1,value:10});
  await execute(await preview('0.3','1.02','set'));assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:30});
 });
 await t.test('a configured increment rejects invalid quantities before approval; whole-unit products stay whole',async()=>{
  await catalog.createItem(db,ctx,{name:'Cases',baseCode:'IMPORT-WHOLE',trackingMode:'quantity'});
  const bad=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity,Unit cost\nCases,IMPORT-WHOLE,${location.name},0.3,1`,allowModel:false,importMode:'add'});assert.equal(bad.recordsInvalid,1);await assert.rejects(()=>imports.approve(db,ctx,bad.id,bad.integrityHash));
  const tiny=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity,Unit cost\nGround coffee,IMPORT-KG,${location.name},0.0001,1`,allowModel:false,importMode:'add'});assert.equal(tiny.recordsInvalid,1);assert.deepEqual(await position(),{physical:0.3,costed:0.3,value:30});
 });
 await t.test('multiple decimal rows sum exactly; a receipt below one cent still records cost coverage',async()=>{
  const second=await catalog.createItem(db,ctx,{name:'Cocoa powder',baseCode:'IMPORT-KG-2',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'});
  const plan=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity,Unit cost\nGround coffee,IMPORT-KG,${location.name},0.1,1\nCocoa powder,IMPORT-KG-2,${location.name},0.2,1`,importMode:'add',allowModel:false});assert.equal(plan.recordsInvalid,0);assert.equal((await execute(plan)).units,0.3);assert.deepEqual(await position(),{physical:0.4,costed:0.4,value:40});
  const tiny=await imports.analyse(db,ctx,{text:`Product,SKU,Location,Quantity,Unit cost\nCocoa powder,IMPORT-KG-2,${location.name},0.001,0.01`,importMode:'add',allowModel:false});assert.equal(tiny.recordsInvalid,0);assert.equal((await execute(tiny)).units,0.001);
  const actual=(await db.query('SELECT quantity_units::text,total_cost_minor::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,second.skuIds[0],location.id])).rows[0];assert.deepEqual(actual,{quantity_units:'0.201',total_cost_minor:'20'});
 });
});
