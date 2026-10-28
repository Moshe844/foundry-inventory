'use strict';const test=require('node:test'),assert=require('node:assert/strict'),conversation=require('../../src/assistant/agent-conversation');
test('host certification funding stops explain the actual cause without claiming an uncertain business outcome',()=>{
 for(const [code,phase,label] of [['CERTIFICATION_SPENDING_CEILING','funding','AI test allowance reached'],['CERTIFICATION_WINDOW_CLOSED','funding','AI testing paused'],['CERTIFICATION_GOAL_CEILING','goal_limit','Request allowance reached'],['CERTIFICATION_UNRESOLVED','usage_review','AI work paused for review']]){
  const g={id:'unfamiliar-stop',status:'BLOCKED',answer:'The investigation stopped before final verification.',checkpoint:{harness:{interruption:{code}}}};
  const s=conversation.state(g);assert.equal(s.phase,phase);assert.equal(s.label,label);assert.equal(s.active,false);assert.equal(s.canReply,false);assert.doesNotMatch(s.message,/outcome could be confirmed|CERTIFICATION_|Review the recorded steps/);
  g.checkpoint.harness.completionSource='partial_verified_receipt';g.answer='A previously authorized operation is recorded.';assert.match(conversation.state(g).message,/previously authorized operation is recorded/);
  g.checkpoint.harness.codexDelivery={state:'PENDING'};assert.equal(conversation.state(g).phase,'usage_review');
  g.status='WAITING_APPROVAL';assert.equal(conversation.state(g).phase,'approval');
 }
 const ordinary={id:'ordinary-interruption',status:'BLOCKED',checkpoint:{harness:{interruption:{code:'UNFAMILIAR_TRANSPORT_STOP'}}}};assert.equal(conversation.state(ordinary).phase,'interrupted','Unknown failures retain conservative recovery');
});
