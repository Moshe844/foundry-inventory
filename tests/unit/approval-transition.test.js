'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const conversation=require('../../src/assistant/agent-conversation');

test('recorded approval-to-provider-wait never presents the old approval request as current work',()=>{
 // Recorded production path: both proposals EXECUTED; email effect still
 // pending. refresh previously changed status but retained this old answer.
 const goal={id:'recorded-goal',status:'WAITING_EVENT',answer:'Approval required. These changes are prepared, not executed:\n- Send the approved message.',
  checkpoint:{conversationState:{phase:'approval',revision:2,history:[]},harness:{}}};
 const state=conversation.state(goal);
 assert.equal(state.phase,'external_wait');assert(state.active);assert(!state.terminal);
 assert(!state.message.includes('Approval required'));assert(!state.message.includes('not executed'));
 assert.match(state.message,/confirmation/);assert.match(state.message,/No further approval/);
 assert.equal(state.canReply,false);
 // Rendering old rows is safe without rewriting native evidence or history.
 assert(goal.answer.includes('Approval required'));
 const navigation=structuredClone(goal);navigation.checkpoint.navigation={state:'PENDING'};navigation.answer='Opening the requested record.';
 assert.equal(conversation.state(navigation).phase,'navigation');
 assert.equal(conversation.state(navigation).message,navigation.answer);
});
