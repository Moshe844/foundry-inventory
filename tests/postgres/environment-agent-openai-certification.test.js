'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixtures=require('../../scripts/environment-agent-demo/openai-certification-fixtures');
const inventory=require('../../src/domain/postgres-inventory-engine');
const workflows=require('../../src/operations/postgres-business-workflows');
// These are evaluator positive/negative controls, NOT agent performance or
// scripted navigation. Paid workers never see this test or its answer controls.
test('all 100 private PostgreSQL scenario predicates reject unchanged writes and unrelated effects',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 for(const task of fixtures.createTasks()){
  const f=await fixtures.seed(db,task);
  const initial=await fixtures.verify(db,f,'');
  assert.equal(initial.achieved,false,`${task.id}: empty answer`);
  assert.ok(Object.values(initial.checks).every(Boolean),`${task.id}: doing nothing must remain safe, though incomplete: ${JSON.stringify(initial.checks)}`);
  if(['changing','handover'].includes(task.kind)){
   assert.equal(await fixtures.perturb(db,f,{sku:task.sku}),true);f.faulted=true;f.expectedReadState=await fixtures.snapshot(db,f);
  }
  if(task.kind==='receive')await inventory.receive(db,f.ctx,{skuId:f.product.skuIds[0],locationId:f.warehouse.id,
   quantity:task.receive,reference:task.reference,idempotencyKey:'offline-control'});
  if(task.kind==='new-po'){
   const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,f.ctx,{name:task.newSupplier,email:task.newEmail});
   await workflows.createPurchaseOrder(db,f.ctx,{supplierId:supplier.id,poNumber:task.newPo,destinationLocationId:f.overflow.id,currency:'USD',
    lines:[{skuId:f.washer.skuIds[0],quantityUnits:task.orderQuantity,unitCost:task.unitCost}],idempotencyKey:'offline-control'});
  }
  if(task.kind==='price-cost'){
   const pricing=require('../../src/pricing/postgres-service');
   await pricing.setPrice(db,f.ctx,{skuId:f.product.skuIds[0],amountMinor:task.sellingMinor,currency:'USD'});
   await pricing.setPurchaseCost(db,f.ctx,{skuId:f.product.skuIds[0],amountMinor:task.costMinor,currency:'USD'});
  }
  if(task.kind==='supplier-payment')await workflows.recordSupplierPayment(db,f.ctx,{supplierId:f.supplierId,supplierBillId:f.bill.billId,
   amountMinor:task.paymentMinor,paymentDate:'2026-10-08',method:'bank_transfer',reference:task.paymentReference,idempotencyKey:'offline-remittance'});
  if(task.kind==='parcel-measurement')await require('../../src/shipping/postgres-service').setPackages(db,f.ctx,f.shipment.shipmentId,[{
   weightGrams:task.weightGrams,lengthMm:240,widthMm:160,heightMm:100}]);
  if(task.kind==='reservation'){
   const place=await require('../../src/domain/postgres-location-service').createLocation(db,f.ctx,{name:task.newLocation,kind:'warehouse'});
   const service=require('../../src/transfers/postgres-transfer-service');
   const transfer=await service.request(db,f.ctx,{fromLocationId:f.warehouse.id,toLocationId:place.id,reference:task.reference,
    lines:[{skuId:f.product.skuIds[0],quantity:task.reserveQuantity}],idempotencyKey:'offline-control'});
   await service.approve(db,f.ctx,transfer.id);
  }
  if(task.kind==='rule')await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules
   (id,workspace_id,sku_id,location_id,threshold,metric,comparator,armed,is_active,stated_as,approved_by_user_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'on_hand','at_or_below',TRUE,TRUE,'offline evaluator control',$6,now(),now())`,
   [require('node:crypto').randomUUID(),f.ctx.workspaceId,f.product.skuIds[0],f.warehouse.id,task.threshold,f.ctx.actorId]);
  if(task.kind==='retire-rule')await db.query('UPDATE stockchief_runtime.stock_threshold_rules SET is_active=FALSE WHERE workspace_id=$1 AND location_id=$2',[f.ctx.workspaceId,f.warehouse.id]);
  const actual=fixtures.facts(await fixtures.snapshot(db,f),f);
  const answer=Object.values(actual).join('; ')+`; ${task.newLocation}; ${task.overflow}; ${task.reserveQuantity}; ${task.storeThreshold}; ${task.moved}; 9.15; quantity tracking, draft, nothing fulfilled, physical at or below, no purchasing authority, reserved, not moved, shipped, in transit, zero received, retired and other active warning remains and triggers.`;
  const good=await fixtures.verify(db,f,answer);assert.equal(good.achieved,true,`${task.id}: ${JSON.stringify({checks:good.checks,business:good.businessOutcomeVerified,facts:good.expectedFacts})}`);
  await db.query("UPDATE customers SET email='unrequested-change@example.test' WHERE workspace_id=$1",[f.ctx.workspaceId]);
  assert.equal((await fixtures.verify(db,f,answer)).achieved,false,`${task.id}: unrequested edit must fail`);
 }
});
