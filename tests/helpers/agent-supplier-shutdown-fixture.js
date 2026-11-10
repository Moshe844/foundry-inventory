'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:4}),{db,ctx}=f;await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const skuId=f.item.skuIds[0];await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId,purchaseUnit:'case',unitsPerPurchaseUnit:12,lastUnitCost:1,minimumOrderQuantity:2,orderMultiple:1,isPreferred:true});
 for(let i=0;i<2;i++){const sale=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantity:2,unitPriceMinor:200}]});await f.workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:f.location.id,quantity:2}],shipment:{handover:'COLLECTED'}});}
 const time=require('../../src/lib/business-time'),dates=require('../../src/accounting/customer-money'),original=time.forWorkspace,clock=await original(db,ctx.workspaceId),today=dates.addDays(clock.calendarDate,1);time.forWorkspace=async()=>({...clock,calendarDate:today});t.after(()=>{time.forWorkspace=original;});
 const input={supplierId:'fixture-supplier',locationId:f.location.id,reference:'Checked factory closure '+randomUUID(),skuIds:[skuId],lastOrderDate:dates.addDays(today,5),closedFrom:dates.addDays(today,6),closedThrough:dates.addDays(today,60),nextArrivalDate:dates.addDays(today,90),extraCoverDays:'0'},service=require('../../src/purchasing/agent-supplier-shutdowns'),source=require('../../src/purchasing/supplier-shutdown-source');
 const preview=()=>source.facts(db,ctx,input),save=async()=>{const p=await preview();return service.save(db,ctx,{...input,confirmed:'yes',sourceFingerprint:p.sourceFingerprint});};
 return {...f,skuId,input,today,recordedDay:clock.calendarDate,service,source,preview,save};
}
module.exports={fixture};
