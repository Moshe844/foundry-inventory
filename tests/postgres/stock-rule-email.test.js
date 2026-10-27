'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('approved threshold emails use the canonical mailbox outbox once per crossing, and recheck authority before sending',{timeout:150000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:7}),{db,ctx}=f;
 await require('../helpers/postgres-model-fixture').fundWorkspace(db,ctx.workspaceId);
 await db.query("UPDATE suppliers SET email='stock@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 await require('../../src/operations/postgres-commerce').linkSupplierItem(db,ctx,{supplierId:'fixture-supplier',skuId:f.item.skuIds[0],isPreferred:true});
 const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,con='con_'+randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
 VALUES($1,$2,$1,'Operations mailbox','gmail','["business mail"]','{}','connected','["mail:read","mail:send"]',$3,1,'CONNECTED',$4,'fixture-mailbox','owner@example.test',now(),now())`,[con,ctx.workspaceId,'connection_credentials:'+con,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,con,'provider',{accessToken:'fixture-token'}));
 const rules=require('../../src/manager/postgres-operating-instructions'),alerts=require('../../src/manager/postgres-stock-threshold-alerts'),mail=require('../../src/connections/postgres-outbound-mail');
 const provider=require('../helpers/postgres-model-fixture').fixture({async complete(input){assert.equal(input.schemaName,'postgres_operating_instruction_effect_fit');const p=JSON.parse(input.prompt);assert.match(p.enforcedEffects.join(' '),/stock@example.test/);return {data:{equivalent:true,difference:''}};}});
 const rule=await rules.interpret(db,ctx,'Email the linked supplier when this product reaches 7 physical units, using the operations mailbox.',{provider,proposedChanges:[{domain:'stock_alert',operation:'set',sku:code,notificationMetric:'on_hand',notificationComparator:'at_or_below',notificationThreshold:7,notificationChannel:'email',notificationRecipient:'supplier',notificationMailbox:'Operations mailbox'}]});
 assert.equal(rule.status,'PENDING');assert.equal(rule.resolvedChanges[0].policyContract.authority.automatic,true);assert.equal((await db.query('SELECT count(*) n FROM supplier_communications WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 await rules.approve(db,ctx,rule.id,rule.integrityHash);
 const queued=()=>db.query('SELECT * FROM stockchief_runtime.stock_threshold_deliveries WHERE workspace_id=$1 ORDER BY crossing_version',[ctx.workspaceId]);
 let deliveries=(await queued()).rows;assert.equal(deliveries.length,1);assert.equal(deliveries[0].status,'QUEUED',deliveries[0].last_error);
 await Promise.all([alerts.evaluate(db,{workspaceId:ctx.workspaceId}),alerts.evaluate(db,{workspaceId:ctx.workspaceId})]);assert.equal((await queued()).rows.length,1);
 let calls=0;const sender={async send({credentials,message}){calls++;assert.equal(credentials.accessToken,'fixture-token');assert.equal(message.recipient,'stock@example.test');assert.match(message.body,/Current on hand: 7/);return {externalMessageId:'fake-provider-message-'+calls};}};
 const sent=await mail.executeSendEffect(db,ctx.workspaceId,deliveries[0].effect_id,{provider:sender});assert.equal(sent.message.status,'SENT');assert.equal(calls,1);
 await mail.executeSendEffect(db,ctx.workspaceId,deliveries[0].effect_id,{provider:sender});assert.equal(calls,1);
 const saved=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'operating_rules'});assert.equal(saved.rows[0].externalEmail,true);assert.equal(saved.rows[0].notification.lastDelivery.messageStatus,'SENT');assert.match(saved.rows[0].notification.lastDelivery.href,/^\/messages\/supplier\//);
 const inventory=require('../../src/domain/postgres-inventory-engine');await inventory.receive(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,reference:'REARM',idempotencyKey:'rearm'});await alerts.evaluate(db,{workspaceId:ctx.workspaceId});
 await db.query('UPDATE workspace_connectors SET paused_at=now() WHERE id=$1',[con]);await inventory.issue(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,reasonCode:'other',reference:'CROSS',idempotencyKey:'cross'});await alerts.evaluate(db,{workspaceId:ctx.workspaceId});deliveries=(await queued()).rows;assert.equal(deliveries.length,2);assert.equal(deliveries[1].status,'HELD');assert.match(deliveries[1].last_error,/resume|Reconnect/);await alerts.evaluate(db,{workspaceId:ctx.workspaceId});assert.equal((await queued()).rows.length,2);await db.query('UPDATE workspace_connectors SET paused_at=NULL WHERE id=$1',[con]);await alerts.evaluate(db,{workspaceId:ctx.workspaceId});deliveries=(await queued()).rows;assert.equal(deliveries[1].status,'QUEUED');
 await db.query('UPDATE stockchief_runtime.stock_threshold_rules SET is_active=false WHERE workspace_id=$1',[ctx.workspaceId]);await assert.rejects(mail.executeSendEffect(db,ctx.workspaceId,deliveries[1].effect_id,{provider:sender}),/changed or was disabled/);assert.equal(calls,1,'Revocation blocks the provider call, not just a future scan');assert.equal(await f.balance(),7);
 await assert.rejects(rules.approve(db,{...ctx,workspaceId:'another-workspace'},rule.id,rule.integrityHash));
});
