'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fixture=require('../fixtures/codex-claimless-refusal.json'),codec=require('../../scripts/environment-agent-demo/codex-report'),conversation=require('../../src/assistant/agent-conversation'),verify=require('../../src/assistant/postgres-codex-verification').verify;
const noReads={query(){throw Error('A policy explanation does not need business reads');}};
test('the exact recorded claimless completed refusal remains unverified instead of weakening business completion',async()=>{
 const raw=codec.decode(JSON.stringify(fixture.report)),result=await verify(noReads,{}, {checkpoint:{clientIntegration:1}},raw,null);
 assert.equal(result.verified,false);assert.equal(conversation.classify({report:raw,verified:result.verified}).status,'BLOCKED');
});
test('the native blocked contract preserves a useful refusal without evidence calls, false completion or human-input waits',async()=>{
 const raw=codec.decode(JSON.stringify({...fixture.report,status:'blocked',outcome:null})),result=await verify(noReads,{}, {checkpoint:{clientIntegration:1}},raw,null),classified=conversation.classify({report:result.report,verified:false});
 assert.equal(classified.status,'BLOCKED');assert.equal(classified.answer,fixture.report.answer);assert.equal(classified.question,undefined);
 for(const current of ['WAITING_APPROVAL','WAITING_EVENT'])assert.equal(conversation.classify({report:result.report,verified:false,current}).status,current,'A refusal cannot discard an existing durable dependency or authorize it');
});

test('typed refusal is terminal without verification or retry, while canonical and unsettled work outrank it',async()=>{
 const raw=codec.decode(JSON.stringify({...fixture.report,version:3,status:'refused',outcome:null}));
 assert(codec.schema.properties.status.enum.includes('refused'));
 const result=await verify(noReads,{}, {checkpoint:{clientIntegration:1}},raw,null);
 assert.equal(result.verified,false);assert.equal(result.report.status,'refused');
 const classified=conversation.classify({report:result.report});
 assert.equal(classified.status,'BLOCKED');assert.equal(classified.failure.code,'REQUEST_REFUSED');
 const goal={id:'refusal',status:classified.status,answer:classified.answer,checkpoint:{harness:{failure:classified.failure}}};
 const state=conversation.sync(goal);assert.equal(state.phase,'refused');assert.equal(state.label,'Request declined');
 assert(state.terminal);assert(!state.active);assert(!state.canReply);assert.equal(state.input,null);assert.equal(state.recovery,null);
 assert.equal(require('../../src/assistant/native-answer-review').checked(goal,raw).required,false,'A refusal does not create a paid business-answer review');
 for(const current of ['WAITING_APPROVAL','WAITING_EVENT','BLOCKED'])assert.equal(conversation.classify({report:result.report,current}).status,current);
 assert.notEqual(conversation.classify({report:result.report,canonicalVerified:false}).failure.code,'REQUEST_REFUSED');
 assert.equal(conversation.classify({report:result.report,progress:{finalReason:'HOST_ADMISSION_REJECTED',requiresUserInput:false}}).failure.code,'HOST_ADMISSION_REJECTED');
 goal.checkpoint.harness.codexDelivery={state:'PENDING'};assert.equal(conversation.state(goal).phase,'usage_review');
 goal.checkpoint.harness.codexDelivery=null;goal.status='WAITING_APPROVAL';assert.equal(conversation.state(goal).phase,'approval');
 assert.equal(conversation.classify({report:{status:'blocked',answer:fixture.report.answer}}).failure.code,'OUTCOME_UNVERIFIED','Historical prose is never retrospectively classified as a refusal');
});
