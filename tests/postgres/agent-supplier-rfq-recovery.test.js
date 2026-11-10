'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-rfq-fixture');
async function firstEffect(f,id){return (await f.db.query(`SELECT e.id FROM stockchief_runtime.agent_rfq_deliveries d JOIN stockchief_runtime.provider_effects e ON e.workspace_id=d.workspace_id AND e.aggregate_id=d.communication_id
 WHERE d.workspace_id=$1 AND d.request_id=$2 ORDER BY d.created_at,d.id LIMIT 1`,[f.ctx.workspaceId,id])).rows[0].id;}
test('an exact individual review can finish definitively unsent RFQs after routine authority was stopped, without duplicating messages', {timeout:240000},async t=>{
 const f=await fixture(t,'enterprise'),{db,ctx,service}=f,p=await f.preview(),rule=await service.configure(db,ctx,p.id,{confirmed:'yes',maxRequestsPerWeek:2});await service.sendAutomatic(db,ctx,p.id,rule.id);
 const modes=require('../../src/autopilot/job-modes');await modes.save(db,ctx,93,{mode:'watch',revision:0});let calls=0;
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,await firstEffect(f,p.id),{provider:{send:async()=>{calls++;return {externalMessageId:'unexpected'};}}}),/Watch/);assert.equal(calls,0);
 await modes.save(db,ctx,93,{mode:'ask',revision:1});await f.send(p);await f.deliver();assert.equal(f.sent.length,3);assert.equal(new Set(f.sent.map(m=>m.recipient)).size,3);
 await f.send(p);await f.deliver();assert.equal(f.sent.length,3);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_rfq_deliveries WHERE workspace_id=$1 AND request_id=$2 AND NOT automatic',[ctx.workspaceId,p.id])).rows[0].n,3);
});
test('an uncertain mailbox acceptance is never replaced or resent by another RFQ approval', {timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,p=await f.preview();await f.send(p);let calls=0;
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,await firstEffect(f,p.id),{provider:{send:async()=>{calls++;throw Error('Connection lost after a possible mailbox acceptance');}}}),e=>e.code==='email_send_ambiguous');assert.equal(calls,1);
 await db.transaction(async c=>{await c.query('SET TRANSACTION READ ONLY');const notices=await f.service.inbox(c,ctx.workspaceId,ctx.actorId);assert.equal(notices.length,1);assert.match(notices[0].why,/uncertain/);assert.equal((await f.service.page(c,ctx,{id:p.id})).saved.id,p.id);});
 const before=(await db.query('SELECT count(*)::int n FROM supplier_communications WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 await assert.rejects(f.send(p),/Sent folder|uncertain|outcome/i);assert.equal((await db.query('SELECT count(*)::int n FROM supplier_communications WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before);assert.equal(calls,1);
});
