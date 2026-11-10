'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-rfq-fixture');
test('Pro reviews one exact three-supplier RFQ, native mailbox workers send it once, and only the completed example permits a taught scope', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;
 for(const plan of ['starter','growth']){await f.subscribe(plan);await assert.rejects(f.preview(),e=>e.code==='entitlement_required');}
 await f.subscribe('pro');const p=await f.preview(),counts=(await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,balance=await f.balance();
 await db.transaction(async c=>{await c.query('SET TRANSACTION READ ONLY');assert.equal((await service.page(c,ctx,{id:p.id})).saved.id,p.id);});
 await assert.rejects(service.send(db,ctx,p.id,{confirmed:'yes',sourceFingerprint:'different'}),/Review every exact/);
 await assert.rejects(service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:2}),/first individually approve/);
 const queued=await f.send(p);assert.equal(queued.deliveries.length,3);assert.equal(f.sent.length,0);
 assert.equal(await require('../../src/operations/postgres-job-queue').claim(db,{owner:'old-published-mail-worker',kinds:['provider.effect','agent.mail.supplier_forecast.v1']}),null);
 assert.equal((await f.deliver()).length,3);assert.equal(f.sent.length,3);assert.equal(new Set(f.sent.map(m=>m.recipient)).size,3);
 for(const mail of f.sent){assert.match(mail.subject,/Request for quotation/);assert.match(mail.body,/Requested: 10/);assert.match(mail.body,/not a purchase order/);assert.doesNotMatch(mail.body,/receiver@example|\$1\.00|last_unit_cost/);}
 await f.send(p);assert.equal((await f.deliver()).length,0);assert.equal(f.sent.length,3);
 const rule=await service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:2}),next=await f.preview({lines:[{skuId:f.item.skuIds[0],quantity:8}]});await service.sendAutomatic(db,ctx,next.id,rule.id);await f.deliver();assert.equal(f.sent.length,6);
 const excessive=await f.preview({lines:[{skuId:f.item.skuIds[0],quantity:11}]});await assert.rejects(service.sendAutomatic(db,ctx,excessive.id,rule.id),/quantity authority/);
 assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,counts);assert.equal(await f.balance(),balance);
});
test('Custom can authorize RFQs without a taught example, respects weekly limits and refuses a queued send after downgrade', {timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,p=await f.preview(),rule=await service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:1});
 assert.equal((await service.rule(db,ctx,rule.id)).example_id,null);
 await service.sendAutomatic(db,ctx,p.id,rule.id);await f.deliver();assert.equal(f.sent.length,3);
 const next=await f.preview();await assert.rejects(service.sendAutomatic(db,ctx,next.id,rule.id),/rolling seven-day/);
 await service.configure(db,ctx,p.id,{ruleId:rule.id,revision:1,confirmed:'yes',maxRequestsPerWeek:2});await service.sendAutomatic(db,ctx,next.id,rule.id);
 await f.subscribe('pro');let calls=0;const delivery=(await db.query('SELECT e.id FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.provider_effects e ON e.aggregate_id=d.communication_id AND e.workspace_id=d.workspace_id WHERE d.workspace_id=$1 AND d.request_id=$2 ORDER BY d.id LIMIT 1',[ctx.workspaceId,next.id])).rows[0];
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,delivery.id,{provider:{send:async()=>{calls++;return {externalMessageId:'unexpected'};}}}),/teach|example|matching/i);assert.equal(calls,0);assert.equal(f.sent.length,3);
});
