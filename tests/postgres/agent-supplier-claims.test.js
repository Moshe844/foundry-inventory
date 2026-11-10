'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-claim-fixture');
test('Pro sends an exact physical damage claim with real resized photo bytes, preserves originals, trains only after acceptance and sends future claims once',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f,holdId=await f.damaged(),p=await f.photo(holdId),saved=await f.preview(holdId,[p.id]);
 const original=await f.photoService.load(db,ctx,p.id),copy=await f.photoService.load(db,ctx,p.id,{email:true});assert.deepEqual(original.bytes,f.bytes);assert(copy.bytes.length<=614400);assert(copy.email_width<=1600);assert.equal((await require('sharp')(copy.bytes).metadata()).format,'jpeg');assert.equal((await f.photo(holdId)).id,p.id);
 const stock=await f.balance(),ledgers=(await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 await assert.rejects(service.configure(db,ctx,saved.id,f.limits()),/first individually approve/);
 await assert.rejects(service.send(db,ctx,saved.id,{confirmed:'yes',sourceFingerprint:'changed'}),/Review the exact/);
 await f.send(saved);assert.equal(await require('../../src/operations/postgres-job-queue').claim(db,{owner:'old-claim-worker',kinds:['provider.effect','agent.mail.supplier_rfq.v1']}),null);
 assert.equal((await f.deliver()).length,1);assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments.length,1);assert.deepEqual(f.sent[0].attachments[0].content,copy.bytes);assert.match(f.sent[0].body,/2 units|2 unit/);assert.match(f.sent[0].body,/\$2.00/);assert.match(f.sent[0].body,/does not accept a settlement/);
 await f.send(saved);assert.equal((await f.deliver()).length,0);assert.equal(f.sent.length,1);
 const rule=await service.configure(db,ctx,saved.id,f.limits()),nextHold=await f.damaged(),nextPhoto=await f.photo(nextHold);assert(nextPhoto.id);
 const run=await service.run(db,ctx.workspaceId);assert.equal(run.results.length,1);assert(!run.results[0].needsReview);await f.deliver();assert.equal(f.sent.length,2);
 const third=await f.preview(await f.damaged());await assert.rejects(service.configure(db,ctx,third.id,f.limits({maxUnits:3,exampleId:saved.id})),/Pro authority/);
 assert.equal(await f.balance(),stock+20);assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,ledgers+2);
 await db.transaction(async c=>{await c.query('SET TRANSACTION READ ONLY');assert.equal((await service.page(c,ctx,{id:saved.id})).saved.id,saved.id);});
 assert.equal((await service.rule(db,ctx,rule.id)).example_id,saved.id);
});
test('Each plan locks damage claims and photo preparation correctly, and unknown physical damaged counts cannot become claims',{timeout:240000},async t=>{
 const f=await fixture(t,'growth'),{db,ctx,service}=f,unknown=await f.damaged(null);await f.photo(unknown);
 await assert.rejects(f.preview(unknown),/Pro/);await f.subscribe('starter');await assert.rejects(f.photo(unknown),/Growth/);assert.deepEqual((await f.photoService.load(db,ctx,(await f.photoService.list(db,ctx,unknown))[0].id)).bytes,f.bytes);
 await f.subscribe('pro');await assert.rejects(f.preview(unknown),/actual damaged-unit count/);
 const hold=await f.damaged(),photo=await f.photo(hold);await assert.rejects(f.preview(hold,[photo.id,photo.id]),/three exact photos/);
 const r=await f.preview(hold,[photo.id]);await f.subscribe('growth');await assert.rejects(f.send(r),/Pro/);assert.equal(f.sent.length,0);
 await f.subscribe('enterprise');const saved=await service.configure(db,ctx,r.id,f.limits());assert.equal((await service.rule(db,ctx,saved.id)).example_id,null);
 await service.sendAutomatic(db,ctx,r.id,saved.id);await f.subscribe('pro');const effect=(await db.query("SELECT e.id FROM stockchief_runtime.provider_effects e JOIN stockchief_runtime.agent_supplier_claims c ON c.workspace_id=e.workspace_id AND c.communication_id=e.aggregate_id WHERE c.id=$1",[r.id])).rows[0];
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,effect.id,{provider:f.provider}),/teach|example|trained/i);assert.equal(f.sent.length,0);
});
