'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,{provider='shippo',units=4,timeZone}={}){
 const cluster=await require('./postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const cleanups=[];t.after(async()=>{for(const cleanup of cleanups.reverse())await cleanup();await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Fixture!'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Shipping operation fixture',email,password,timeZone}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/shipping/postgres-accounts').connect(db,ctx,{provider,apiKey:provider==='shippo'?'shippo_test_fixture':provider==='easypost'?'EZTK_fixture':'TEST_fixture'});
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Dispatch',kind:'warehouse',address:'1 Main St, Monroe, NY 10950',phone:'8455550100',shippingEmail:'dispatch@example.test'});
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Parcel item',baseCode:'PARCEL-'+randomUUID().slice(0,8),trackingMode:'quantity'}),at=new Date().toISOString(),workflows=require('../../src/operations/postgres-business-workflows');
 await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('fixture-supplier',$1,'Fixture parts','active','USD',$2,$2)`,[ctx.workspaceId,at]);
 await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('fixture-customer',$1,'Receiver','receiver@example.test','5185550100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:'fixture-po',lines:[{skuId:item.skuIds[0],quantityUnits:units,unitCost:1}]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'fixture-approve'});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'fixture-place'});
 await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'fixture-receive',reference:'FIXTURE-RECEIPT',lines:[{lineId:po.lineIds[0],quantity:units,locationId:location.id}]});
 let sequence=0;const shipping=require('../../src/shipping/postgres-service');
 async function parcel({quantity=1,boxes=[{weightGrams:350,lengthMm:200,widthMm:150,heightMm:100}]}={}){
  const key='parcel-'+(++sequence),order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:key,lines:[{skuId:item.skuIds[0],quantity,unitPriceMinor:1200}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:key+'-confirm'});
  const shipment=await shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:key+'-pack',lines:[{lineId:order.lineIds[0],locationId:location.id,quantity}]});await shipping.setPackages(db,ctx,shipment.shipmentId,boxes);return {...shipment,order};
 }
 const balance=async()=>Number((await db.query('SELECT sum(on_hand)::int n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 return {db,ctx,owner,email,password,location,item,parcel,balance,workflows,shipping,cleanup:operation=>cleanups.push(operation)};
}
module.exports={fixture};
