'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-return-label-fixture');
async function queued(f,r){const p=await f.prepare(r);await f.assistant.executeProposal(f.db,f.ctx,p.proposal.id);return f.assistant.getProposal(f.db,f.ctx.workspaceId,p.proposal.id);}
test('Queued return-label emails stop after downgrade, a voided label or a changed message at the last provider boundary',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;let r=await f.rma(),p=await queued(f,r);await f.subscribe('starter');await assert.rejects(f.deliver(p),/Growth|Pro/);assert.equal(f.sent.length,0);await f.subscribe('growth');
 r=await f.rma();p=await queued(f,r);await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider:f.provider,beforeSend:async()=>db.query("UPDATE sales_shipments SET label_status='VOIDED' WHERE id=$1",[r.shipmentId])}),/purchased|label/);assert.equal(f.sent.length,0);
 r=await f.rma();p=await queued(f,r);await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider:f.provider,beforeSend:async()=>db.query("UPDATE customer_communications SET body='Different instructions' WHERE id=$1",[p.result.communicationId])}),/earlier|message|delivery/i);assert.equal(f.sent.length,0);
 assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,r.customerReturnId)).status,'AUTHORIZED');assert.equal(await f.balance(),17);
});
test('Unknown return-label delivery is held and cannot create a replacement email or repeat a provider call',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,r=await f.rma(),p=await queued(f,r);let calls=0;
 const provider={send:async()=>{calls++;throw Error('Mailbox response lost after submission');}};
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider}),/lost|uncertain|Mailbox/);
 assert.equal((await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,p.result.effectId)).status,'AMBIGUOUS');
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider}),/uncertain|repeat|ambiguous/i);
 const again=await f.prepare(r);await assert.rejects(f.assistant.executeProposal(db,ctx,again.proposal.id),/earlier|existing|delivery/i);assert.equal(calls,1);assert.equal((await db.query("SELECT count(*)::int n FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2",[ctx.workspaceId,'return-label:'+r.shipmentId])).rows[0].n,1);
});
test('Return mail uses a compatible native worker and the database rejects rewriting it into an older generic provider job',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,p=await queued(f,await f.rma()),jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider});
 const saved=(await db.query("SELECT id,kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'effectId'=$2",[ctx.workspaceId,p.result.effectId])).rows[0];assert.equal(saved.kind,'agent.mail.return_label.v1');
 await assert.rejects(db.query("UPDATE stockchief_runtime.jobs SET kind='provider.effect' WHERE id=$1",[saved.id]),/compatible|worker/i);assert.equal(f.sent.length,0);
 const run=await jobs.processOne(db,handlers,{owner:'return-label-native-worker',kinds:['agent.mail.return_label.v1']});assert(run);assert.equal(f.sent.length,1);assert.equal((await db.query('SELECT status FROM customer_communications WHERE id=$1',[p.result.communicationId])).rows[0].status,'SENT');
});

test('Owner pause, job Watch, changed mailbox identity and lost owner access stop pending return mail without a provider call',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');let p=await queued(f,await f.rma());
 await autopilot.pause(db,ctx,{role:'owner'},'Check return correspondence');await assert.rejects(f.deliver(p),/pause/i);await autopilot.resume(db,ctx,{role:'owner'});
 p=await queued(f,await f.rma());await modes.save(db,ctx,112,{mode:'watch',revision:0});await assert.rejects(f.deliver(p),/watch/i);await modes.save(db,ctx,112,{mode:'inherit',revision:1});
 p=await queued(f,await f.rma());await db.query("UPDATE workspace_connectors SET provider_account_id='different-account' WHERE id=$1",[f.connector]);await assert.rejects(f.deliver(p),/changed|mailbox/i);await db.query("UPDATE workspace_connectors SET provider_account_id='returns-mailbox' WHERE id=$1",[f.connector]);
 p=await queued(f,await f.rma());await db.query("UPDATE users SET role='clerk' WHERE id=$1",[ctx.actorId]);await assert.rejects(f.deliver(p),/owner|permission|access/i);assert.equal(f.sent.length,0);assert.equal(await f.balance(),16);
});
