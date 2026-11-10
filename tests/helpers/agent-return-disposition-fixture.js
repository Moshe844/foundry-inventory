'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:100}),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const quarantine=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Physical returns quarantine',kind:'warehouse'}),repair=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Repair bench',kind:'warehouse'}),skuId=f.item.skuIds[0],service=require('../../src/operations/agent-return-disposition'),returns=require('../../src/operations/postgres-returns');
 async function received({quantity=1,quarantineId=quarantine.id}={}){
  const so=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId,quantity,unitPriceMinor:1000}]});
  await f.workflows.confirmSalesOrder(db,ctx,so.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,so.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:so.lineIds[0],quantity,locationId:f.location.id}],shipment:{handover:'COLLECTED'}});
  const r=await returns.requestCustomerReturn(db,ctx,{salesOrderId:so.salesOrderId,quarantineLocationId:quarantineId,resolution:'NO_REFUND',reason:'Physically inspected test return',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:so.lineIds[0],quantity}]});
  await returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID()});let p=await returns.getCustomerReturn(db,ctx.workspaceId,r.customerReturnId);
  await returns.receiveCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID(),reference:'Actual checked arrival',lines:p.lines.map(l=>({lineId:l.id,quantity}))});return r.customerReturnId;
 }
 async function observe(id,code='UNOPENED_GOOD'){
  const f=await service.facts(db,ctx,id);return service.observe(db,ctx,{returnId:id,sourceHash:f.sourceHash,confirmed:'yes',lines:f.lines.map(l=>({lineId:l.id,conditionCode:code,note:'All units physically checked; exact observed condition.'}))});
 }
 async function manual(id,outcome='RESTOCK',destinationId=f.location.id){const a=await service.assessment(db,ctx,id);await service.prepare(db,ctx,id,{revision:a.revision,confirmed:'yes',lines:a.observations.map(o=>({lineId:o.lineId,outcome,destinationId}))});return service.assessment(db,ctx,id);}
 async function apply(id,extra={}){const a=await service.assessment(db,ctx,id);return service.apply(db,ctx,id,{revision:a.revision,proposalHash:require('../../src/pricing/postgres-promotions').hash(a.proposal),confirmed:'yes',...extra});}
 const newRule=(code='UNOPENED_GOOD',outcome='RESTOCK',destinationId=f.location.id,extra={})=>service.saveRule(db,ctx,{skuId,conditionCode:code,conditionLabel:'Human-checked '+code,outcome,destinationId,maximumUnits:1,confirmed:'yes',...extra});
 return {...f,quarantine,repair,skuId,service,returns,received,observe,manual,apply,newRule};
}
module.exports={fixture};
