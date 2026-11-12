'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,plan='pro'){
 const f=await require('./agent-workflow-fixture').fixture(t),{db,ctx}=f;await f.subscribe(plan);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const connectorId=randomUUID();await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'RFQ test mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'rfq-mailbox',now(),now())`,[connectorId,ctx.workspaceId,'connection_credentials:'+connectorId,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connectorId,'provider',{accessToken:'synthetic-rfq-token'}));
 const supplierIds=['fixture-supplier',randomUUID(),randomUUID()];await db.query("UPDATE suppliers SET email='rfq-one@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 for(const [index,id] of supplierIds.entries()){
  if(index)await db.query("INSERT INTO suppliers(id,workspace_id,name,email,status,currency,created_at,updated_at) VALUES($1,$2,$3,$4,'active','USD',now()::text,now()::text)",[id,ctx.workspaceId,'RFQ supplier '+(index+1),'rfq-'+(index+1)+'@example.test']);
  await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,minimum_order_quantity,order_multiple,last_unit_cost,created_at,updated_at)
   VALUES($1,$2,$3,$4,1,1,1,now()::text,now()::text) ON CONFLICT(workspace_id,supplier_id,sku_id) DO NOTHING`,[randomUUID(),ctx.workspaceId,id,f.item.skuIds[0]]);
  if(index){const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:id,destinationLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:1}]});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});}
 }
 const service=require('../../src/purchasing/agent-supplier-rfqs'),sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'rfq-accepted-'+message.id};}},clock=await require('../../src/lib/business-time').forWorkspace(db,ctx.workspaceId),replyBy=require('../../src/accounting/customer-money').addDays(clock.calendarDate,7),deliverBy=require('../../src/accounting/customer-money').addDays(clock.calendarDate,14);
 const input=()=>({requestKey:randomUUID(),reference:'RFQ-'+randomUUID().slice(0,8),connectorId,supplierIds,lines:[{skuId:f.item.skuIds[0],quantity:10}],replyBy,deliverBy,locationId:f.location.id});
 const preview=(extra={})=>service.preview(db,ctx,{...input(),...extra});
 const send=r=>service.send(db,ctx,r.id,{confirmed:'yes',sourceFingerprint:r.source_fingerprint});
 async function deliver(){const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider}),kind='agent.mail.supplier_rfq.v1',results=[];for(let i=0;i<20;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'rfq-qualified-worker'});if(!r)break;results.push(r);if(r.status!=='COMPLETED')throw Error(JSON.stringify(r.lastError));}return results;}
 return {...f,connectorId,supplierIds,service,sent,provider,input,preview,send,deliver};
}
module.exports={fixture};
