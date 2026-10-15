'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),contract=require('../../src/assistant/agent-conversation');
test('recorded shared-budget stop is a saved funding pause, not an unexplained interruption or clarification',()=>{
 const goal={id:'recorded-budget-stop',status:'BLOCKED',answer:'The investigation stopped before final verification. Previously recorded business effects retain their canonical status; review them before continuing.',
  checkpoint:{harness:{interruption:{code:'SHARED_SPENDING_CEILING'},calls:{}}}};
 const state=contract.state(goal);assert.equal(state.phase,'funding');assert.equal(state.label,'Spending limit reached');
 assert.equal(state.canReply,false);assert.equal(state.active,false);assert.equal(state.terminal,false);assert.equal(state.input,null);
 assert.match(state.message,/approved spending allowance/);assert.match(state.message,/request is saved/);assert(!state.message.includes('SHARED_SPENDING_CEILING'));
 assert(!state.message.includes('business effects'));assert.match(state.recovery,/approved/);
 contract.sync(goal);assert.equal(contract.state(JSON.parse(JSON.stringify(goal))).phase,'funding','survives persisted context and restart');
 goal.checkpoint.harness.completionSource='partial_verified_receipt';goal.answer='The approved receipt is recorded; the report is unfinished.';
 assert(contract.state(goal).message.startsWith(goal.answer),'retain verified partial business outcomes');
 goal.status='WAITING_APPROVAL';assert.equal(contract.state(goal).phase,'approval');
 goal.status='WAITING_EVENT';assert.equal(contract.state(goal).phase,'external_wait');
 goal.status='COMPLETED';assert.equal(contract.state(goal).phase,'completed');
 goal.status='BLOCKED';goal.checkpoint.harness.interruption.code='REPEATED_UNCHANGED_EVIDENCE';assert.equal(contract.state(goal).phase,'interrupted');
 goal.checkpoint.harness.interruption={code:'rate_limited',limitKind:'daily_model_attempts'};
 const daily=contract.state(goal);assert.equal(daily.phase,'capacity');assert.equal(daily.canReply,false);assert.equal(daily.active,false);assert.equal(daily.terminal,false);
 assert(daily.message.includes(goal.answer));assert.match(daily.message,/daily allowance resets/);assert(!daily.message.includes('rate_limited'));
 goal.status='WAITING_APPROVAL';assert.equal(contract.state(goal).phase,'approval');
 goal.status='WAITING_USER';goal.checkpoint.harness.userQuestion={question:'Which address?',missingInformation:['Address']};assert.equal(contract.state(goal).phase,'clarification');
});
test('native preflight unavailability is a saved service pause, never a user question or a claimed business failure',()=>{
 const goal={id:'recorded-native-count-timeout',status:'BLOCKED',answer:'The investigation stopped before final verification.',checkpoint:{harness:{interruption:{code:'CODEX_TOKEN_COUNT_UNAVAILABLE',limitKind:'native_token_preflight'}}}};
 const saved=contract.state(JSON.parse(JSON.stringify(goal)));assert.equal(saved.phase,'service_wait');assert.equal(saved.active,false);assert.equal(saved.terminal,false);assert.equal(saved.canReply,false);assert.equal(saved.input,null);assert.match(saved.message,/No further paid AI request was sent/);assert(!saved.message.includes('CODEX_TOKEN_COUNT_UNAVAILABLE'));
 goal.checkpoint.harness.completionSource='partial_verified_receipt';goal.answer='The earlier approved operation remains verified.';assert(contract.state(goal).message.startsWith(goal.answer));
 goal.status='WAITING_APPROVAL';assert.equal(contract.state(goal).phase,'approval');
 goal.status='WAITING_USER';goal.checkpoint.harness.userQuestion={question:'Which destination?',missingInformation:['Destination']};assert.equal(contract.state(goal).phase,'clarification');
});
