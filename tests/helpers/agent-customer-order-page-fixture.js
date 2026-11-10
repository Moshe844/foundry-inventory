'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:100}),{db,ctx}=f;await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');const skuId=f.item.skuIds[0],service=require('../../src/sales/agent-customer-order-pages');await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId,amountMinor:1200,currency:'USD'});
 const known=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,deliveryMethod:'PICKUP',currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId,quantity:1}]});await f.workflows.confirmSalesOrder(db,ctx,known.salesOrderId,{idempotencyKey:randomUUID()});
 const publish=(extra={})=>service.publish(db,ctx,{label:'Customer reorder page',customerId:'fixture-customer',locationId:f.location.id,deliveryMethod:'PICKUP',currency:'USD',taxTreatment:'NON_TAXABLE_CONFIRMED',skuIds:[skuId],maximumUnits:20,maximumAmount:'1000',expiryDays:7,confirmed:'yes',...extra});
 async function send(page,{quantity=1,reference='CUSTOMER-'+randomUUID(),extra={}}={}){const input={reference,lines:[{skuId,quantity}],...extra},q=await service.quoteRequest(db,page.token,input),result=await service.submit(db,page.token,{...input,expectedHash:q.requestHash,expectedArrival:q.preorderArrival,confirmed:'yes'});return {...result,reference,input,preview:q};}
 async function manual(id){const r=await service.request(db,ctx,id);return service.createDraft(db,ctx,id,{confirmed:'yes',expectedHash:r.request_hash});}
 return {...f,skuId,service,publish,send,manual};
}
module.exports={fixture};
