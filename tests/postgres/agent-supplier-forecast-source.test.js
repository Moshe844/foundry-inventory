'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// Job 36: what a key supplier is shown. Only that supplier's own active
// products, owned stock (supplier-owned consignment stays out), and twelve
// weeks from the same demand forecasting job 144 uses.
test('a supplier forecast holds only that supplier’s products, our owned stock and twelve weeks of the demand forecast',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,source=require('../../src/purchasing/supplier-forecast-source'),forecast=require('../../src/forecasting/agent-demand-forecast');
 const {addDays}=require('../../src/accounting/customer-money'),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),sku=f.item.skuIds[0],at=new Date().toISOString();
 await db.query("UPDATE suppliers SET email='planner@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const catalog=require('../../src/domain/postgres-catalog-service'),fresh=await catalog.createItem(db,ctx,{name:'New product with no history',baseCode:'NEW-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 const other=await catalog.createItem(db,ctx,{name:'Bought elsewhere',baseCode:'ELSE-'+randomUUID().slice(0,6),trackingMode:'quantity'}),dropped=await catalog.createItem(db,ctx,{name:'No longer bought',baseCode:'OLD-'+randomUUID().slice(0,6),trackingMode:'quantity'});
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('other-supplier',$1,'Other supplier','active','USD',$2,$2)",[ctx.workspaceId,at]);
 const link=(supplier,skuId,active=1)=>db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,is_active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)
  ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET is_active=EXCLUDED.is_active`,[randomUUID(),ctx.workspaceId,supplier,skuId,active,at]);
 await link('fixture-supplier',sku);await link('fixture-supplier',fresh.skuIds[0]);await link('fixture-supplier',dropped.skuIds[0],0);await link('other-supplier',other.skuIds[0]);
 // Supplier-owned consignment stock is not ours.
 const custody=require('../../src/custody/postgres-service'),agreement=await custody.create(db,ctx,{kind:'CONSIGN_IN',supplierId:'fixture-supplier',inspectionParentLocationId:f.location.id,startDate:today,dueDate:today,requestKey:randomUUID(),lines:[{skuId:sku,quantity:2,unitCostMinor:150,unitPriceMinor:200}]});
 await custody.operate(db,ctx,agreement.id,'receive_consigned',{confirmed:'yes',requestKey:randomUUID(),lineId:agreement.lines[0].id,quantity:2});
 // Eight weeks of confirmed orders, two a week; a draft and a cancelled order do not count.
 const order=async(date,quantity=2,{confirm=true}={})=>{const o=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',orderDate:date,currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:1200}]});if(confirm)await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});return o;};
 for(let day=56;day>=2;day-=3)await order(addDays(today,-day));
 await order(addDays(today,-10),999,{confirm:false});const cancelled=await order(addDays(today,-7),66);await f.workflows.cancelSalesOrder(db,ctx,cancelled.salesOrderId,{idempotencyKey:randomUUID()});
 const stock=await f.balance(),list=await source.products(db,ctx.workspaceId,'fixture-supplier');
 assert.deepEqual(list.map(p=>p.id).sort(),[sku,fresh.skuIds[0]].sort(),'Only this supplier’s active products');
 // The same fit job 144 makes from the same recorded sales.
 const from=await forecast.historyStart(db,ctx.workspaceId,today),sales=await forecast.demand(db,ctx.workspaceId,[sku],{from,today}),fitted=forecast.fit(forecast.daysOf(sales.get(sku),today));
 assert(fitted.shape,'Eight weeks of orders are enough to forecast');
 await assert.rejects(source.access(db,ctx),e=>e.code==='agent_plan_required'||e.code==='entitlement_required');
 for(const tier of ['starter','growth','pro','enterprise']){
  await f.subscribe(tier);
  if(tier==='starter'){await assert.rejects(source.access(db,ctx),e=>e.code==='entitlement_required');continue;}
  await source.access(db,ctx);
  const supplier=(await db.query("SELECT id,name,email FROM suppliers WHERE id='fixture-supplier'")).rows[0],p=await source.snapshot(db,ctx,supplier,list);
  const row=p.rows.find(r=>r.skuId===sku),unknown=p.rows.find(r=>r.skuId===fresh.skuIds[0]);
  assert.equal(p.rows.length,2);assert(!p.rows.some(r=>[other.skuIds[0],dropped.skuIds[0]].includes(r.skuId)));
  assert.equal(row.onHand,'4','Consignment stock is not presented as ours');
  assert.equal(row.weeks.length,12);assert.equal(row.weeks[0].from,today);assert.equal(row.weeks[11].to,addDays(today,83));
  assert.deepEqual(row.weeks.map(w=>w.quantity),Array.from({length:12},(_,i)=>forecast.units(fitted.shape,addDays(today,i*7),7)));
  assert.equal(row.total,Math.round(row.weeks.reduce((n,w)=>n+w.quantity,0)*100)/100);assert.equal(row.method,fitted.label);
  assert.equal(unknown.total,null);assert(unknown.weeks.every(w=>w.quantity===null));assert.equal(unknown.method,null);
  assert.equal(p.recipient,'planner@example.test');assert.equal(p.weekStart,source.monday(today));assert.equal(p.historyThrough,addDays(today,-1));
  assert.equal(JSON.stringify(p).includes('1200'),false,'No prices');assert.equal(JSON.stringify(p).includes('Receiver'),false,'No customers');
 }
 await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(source.access(db,ctx),/Only the inventory owner/);
 assert.equal(await f.balance(),stock,'Reading the forecast changes no stock');
});
