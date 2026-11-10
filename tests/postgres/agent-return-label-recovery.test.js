'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-return-label-fixture');
async function queue(f,r){const p=await f.prepare(r);await f.assistant.executeProposal(f.db,f.ctx,p.proposal.id);return f.assistant.getProposal(f.db,f.ctx.workspaceId,p.proposal.id);}
test('An owner can individually replace a proven-unsent paused label email, while an automatic request cannot repeat it',{timeout:240000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f,autopilot=require('../../src/autopilot/postgres-service');await f.deliver(await queue(f,await f.rma()));
 const r=await f.rma(),held=await queue(f,r);await autopilot.pause(db,ctx,{role:'owner'},'Review return mail');await assert.rejects(f.deliver(held),/pause/i);
 const old=await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,held.result.effectId);assert.equal(old.status,'FAILED');assert.equal(old.result.providerNotCalled,true);assert.equal(f.sent.length,1);
 await autopilot.resume(db,ctx,{role:'owner'});const retry=await f.mission(r);await assert.rejects(f.assistant.executeMission(db,ctx,retry.proposal.id),/retry individually|approve.*individually/i);
 await f.assistant.executeProposal(db,ctx,retry.proposal.id);const fresh=await f.assistant.getProposal(db,ctx.workspaceId,retry.proposal.id);assert.notEqual(fresh.result.effectId,held.result.effectId);
 assert.equal((await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,held.result.effectId)).status,'CANCELLED');await assert.rejects(f.deliver(held),/cancelled/i);
 await f.deliver(fresh);await f.deliver(fresh);assert.equal(f.sent.length,2);assert.equal((await require('../../src/autopilot/draft-authority').settings(db,ctx,held.id)).canTeach,false);assert.equal((await require('../../src/autopilot/draft-authority').settings(db,ctx,fresh.id)).canTeach,true);assert.equal(await f.balance(),18);
});
test('An unattempted email retained during a downgrade can be reviewed after upgrade and delivered once',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,r=await f.rma(),held=await queue(f,r);await f.subscribe('starter');await assert.rejects(f.deliver(held),/Growth|Pro/);
 const old=await require('../../src/operations/postgres-provider-effects').get(db,ctx.workspaceId,held.result.effectId);assert.equal(old.status,'PENDING');assert.equal(old.result.providerNotCalled,true);assert.equal(f.sent.length,0);
 await f.subscribe('growth');const p=await f.prepare(r);await f.assistant.executeProposal(db,ctx,p.proposal.id);const fresh=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id);assert.notEqual(fresh.result.effectId,held.result.effectId);await f.deliver(fresh);assert.equal(f.sent.length,1);assert.equal(await f.balance(),19);
});
