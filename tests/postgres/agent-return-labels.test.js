'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('../helpers/agent-return-label-fixture');
test('Growth sends an exact purchased return label, teaches only confirmed delivery and then handles matching authorized returns',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,r=await f.rma(),p=await f.prepare(r),training=require('../../src/autopilot/draft-authority'),balance=await f.balance();assert.equal(p.status,'PREPARED');
 let settings=await training.settings(db,ctx,p.proposal.id);assert.equal(settings.canTeach,false);
 await f.assistant.executeProposal(db,ctx,p.proposal.id);let saved=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id);assert.equal(saved.result.status,'QUEUED');assert.equal((await training.settings(db,ctx,p.proposal.id)).canTeach,false);
 await f.deliver(saved);await f.deliver(saved);assert.equal(f.sent.length,1);assert.match(f.sent[0].body,/Print the purchased carrier label/);assert.match(f.sent[0].body,/https:\/\/example.test\/return-/);assert.match(f.sent[0].body,/1 × Parcel item/);assert.match(f.sent[0].body,/does not confirm/);assert.equal(await f.balance(),balance);
 assert.equal((await training.settings(db,ctx,p.proposal.id)).canTeach,true);await training.save(db,ctx,p.proposal.id,{mode:'save',revision:0,maximum:'12.00'});
 const next=await f.rma(),q=await f.mission(next);await f.assistant.executeMission(db,ctx,q.proposal.id);saved=await f.assistant.getProposal(db,ctx.workspaceId,q.proposal.id);assert.equal(saved.result.automatic,true);await f.deliver(saved);assert.equal(f.sent.length,2);assert.equal((await f.returns.getCustomerReturn(db,ctx.workspaceId,next.customerReturnId)).status,'AUTHORIZED');
 const more=await f.rma(2),over=await f.mission(more);await assert.rejects(f.assistant.executeMission(db,ctx,over.proposal.id),/train|teach|approval|Growth|authority|limit/i);assert.equal(f.sent.length,2);
});
test('Pro and Custom send known-customer return labels without teaching; Starter has no agent return-label access',{timeout:240000},async t=>{
 const f=await fixture(t,'pro'),{db,ctx}=f,first=await f.rma(),p=await f.mission(first);await assert.rejects(f.assistant.executeMission(db,ctx,p.proposal.id),/first email|individually/);await f.assistant.executeProposal(db,ctx,p.proposal.id);await f.deliver(await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id));
 for(const tier of ['pro','enterprise']){await f.subscribe(tier);const r=await f.rma(),q=await f.mission(r);await f.assistant.executeMission(db,ctx,q.proposal.id);await f.deliver(await f.assistant.getProposal(db,ctx.workspaceId,q.proposal.id));}
 assert.equal(f.sent.length,3);await f.subscribe('starter');await assert.rejects(f.prepare(first),/Growth|Pro/);
});
