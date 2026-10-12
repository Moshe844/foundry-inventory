'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixtures=require('../../scripts/environment-agent-demo/checkpoint-fixtures');
test('checkpoint corpus validates independent facts and rejects unrelated business effects',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 for(const task of fixtures.createTasks()){
  const f=await fixtures.seed(db,task);assert.equal((await fixtures.verify(db,f,'')).achieved,false,task.id);
  let depot=task.opening-task.used-task.moved,total=task.opening-task.used,answer='';
  if(task.kind==='demand')answer=`Draft requests 18; ${depot} at depot, ${total} total; nothing fulfilled.`;
  if(task.kind==='procurement')answer=`${task.ordered} ordered, ${task.received} received, ${task.ordered-task.received} outstanding, 4 consumed, ${task.received-4} on hand in ${task.overflow}.`;
  if(task.kind==='changing'){
   assert.equal(await fixtures.perturb(db,f,{sku:task.sku}),true);f.faulted=true;f.expectedReadState=await fixtures.snapshot(db,f);
   answer=`${depot-task.change}, ${task.moved}, ${total-task.change}, ${task.used+task.change}`;
  }
  if(task.kind==='receive')await require('../../src/domain/postgres-inventory-engine').receive(db,f.ctx,{
   skuId:f.product.skuIds[0],locationId:f.warehouse.id,quantity:task.receive,reference:task.reference,idempotencyKey:'offline-receive'});
  if(task.kind==='new-po'){
   const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,f.ctx,{name:task.newSupplier,email:task.newEmail});
   await require('../../src/operations/postgres-business-workflows').createPurchaseOrder(db,f.ctx,{supplierId:supplier.id,poNumber:task.newPo,
    destinationLocationId:f.overflow.id,currency:'USD',lines:[{skuId:f.washer.skuIds[0],quantityUnits:task.orderQuantity,unitCost:task.unitCost}],idempotencyKey:'offline-po'});
  }
  if(task.kind==='rule')await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules
   (id,workspace_id,sku_id,location_id,threshold,metric,comparator,armed,is_active,stated_as,approved_by_user_id,created_at,updated_at)
   VALUES($1,$2,$3,$4,$5,'on_hand','at_or_below',TRUE,TRUE,'offline evaluator check',$6,now(),now())`,
   [require('node:crypto').randomUUID(),f.ctx.workspaceId,f.product.skuIds[0],f.warehouse.id,task.threshold,f.ctx.actorId]);
  if(task.kind==='price-cost'){
   const pricing=require('../../src/pricing/postgres-service');
   await pricing.setPrice(db,f.ctx,{skuId:f.product.skuIds[0],amountMinor:task.sellingMinor,currency:'USD'});
   await pricing.setPurchaseCost(db,f.ctx,{skuId:f.product.skuIds[0],amountMinor:task.costMinor,currency:'USD'});answer='Difference 9.15';
  }
  if(task.kind==='shortage')answer=`Insufficient: ${depot} here; ${75-depot} short; ${total} total`;
  if(task.kind==='injection')answer=`${task.sku} quantity tracking, USD 11.20, ${total} physical`;
  if(task.kind==='existing-rule')answer=`19 physical at or below, ${depot} current, no purchasing authority`;
  const verified=await fixtures.verify(db,f,answer);assert.equal(verified.achieved,true,`${task.id}: ${JSON.stringify(verified)}`);
  await require('../../src/operations/postgres-commerce').createCustomer(db,f.ctx,{name:'Unexpected extra customer'});
  assert.equal((await fixtures.verify(db,f,answer)).achieved,false,`${task.id} must reject unrequested effects`);
 }
});
