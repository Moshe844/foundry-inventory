'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,plan='growth'){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe(plan);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const connector=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
 VALUES($1,$2,$1,'Returns mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'returns-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 const returns=require('../../src/operations/postgres-returns'),postage=require('../../src/shipping/postgres-return-parcels'),service=require('../../src/shipping/agent-return-instructions'),assistant=require('../../src/assistant/postgres-service');
 const labelProvider={quote:async()=>({rates:[{rateId:'return-rate',carrier:'usps',service:'Ground',amountMinor:100,currency:'USD'}]}),buy:async(_ctx,input)=>({providerShipmentId:'label-'+input.shipmentId,trackingNumber:'RETURN-'+randomUUID(),labelUrl:'https://example.test/return-'+randomUUID()+'.pdf',amountMinor:100,currency:'USD'})};
 async function rma(quantity=1){
  const outbound=await f.parcel({quantity});await f.shipping.handoff(db,ctx,outbound.shipmentId,{trackingNumber:'OUTBOUND-'+randomUUID(),idempotencyKey:randomUUID()});
  const r=await returns.requestCustomerReturn(db,ctx,{salesOrderId:outbound.order.salesOrderId,quarantineLocationId:f.location.id,resolution:'NO_REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:outbound.order.lineIds[0],quantity}]});
  await returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:randomUUID()});const parcel=await postage.prepare(db,ctx,r.customerReturnId,{locationId:f.location.id});await f.shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:300,lengthMm:200,widthMm:150,heightMm:100}]);
  const quoted=await f.shipping.quote(db,ctx,parcel.shipmentId,{provider:labelProvider});if(!quoted.rates.length)throw Error(JSON.stringify(quoted.blocked));await f.shipping.buyLabel(db,ctx,parcel.shipmentId,quoted.rates[0].id,{idempotencyKey:randomUUID()},{provider:labelProvider});
  return {...r,...parcel,outbound};
 }
 const prepare=r=>assistant.prepareAction(db,ctx,'Send the purchased return label and instructions',{action:service.action,recordReference:r.customerReturnId,mailbox:connector});
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}},outbound=require('../../src/connections/postgres-outbound-mail');
 const deliver=p=>outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider});
 async function mission(r){const p=await prepare(r),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');if(p.status!=='PREPARED')throw Error(JSON.stringify(p));await plans.save(db,ctx,'Send these return instructions then review products',randomUUID(),[{contract:registry.get(service.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}],[{result:p},{result:{status:'CLARIFY'}}]);return p;}
 return {...f,connector,returns,postage,service,assistant,rma,prepare,mission,sent,provider,deliver,labelProvider};
}
module.exports={fixture};
