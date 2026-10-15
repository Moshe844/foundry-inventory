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
