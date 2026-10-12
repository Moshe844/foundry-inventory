'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mergeGoalTranscript}=require('../../src/assistant/goal-transcript');
const {activities}=require('../../src/web/public/adaptive-goal');
test('agent requests keep submission order, including unanswered requests and late canonical results',()=>{
 const old={id:'goal_old',original_request:'First request',created_at:'2026-10-12T10:00:00Z'};
 const next={id:'goal_new',original_request:'Next request',created_at:'2026-10-12T10:01:00Z'};
 const step={id:'step',createdAt:'2026-10-12T10:02:00Z',message:old.original_request,understanding:{batchId:'goal_old:call'},goals:[{id:'canonical-result'}]};
 const merged=mergeGoalTranscript([step],[next,old]);
 assert.deepEqual(merged.map(turn=>turn.message),['First request','Next request']);
 assert.deepEqual(merged[0].goals,step.goals);assert.deepEqual(merged[1].goals,[]);
 assert.equal(merged.length,2);
});
test('activity reflects real tool starts without an internal reasoning log or fabricated completion',()=>{
 const events=[{sequence:1,detail:{kind:'agent_tool_started',tool:'environment_browser'}},
 {sequence:2,detail:{kind:'model_call'}},{sequence:3,detail:{kind:'browser_action',action:'inspect'}},
 {sequence:4,detail:{kind:'agent_tool_completed',tool:'environment_browser'}},
 {sequence:5,detail:{kind:'agent_tool_started',tool:'environment_browser'}},
 {sequence:6,detail:{kind:'agent_tool_failed',tool:'business_operations'}}];
 assert.deepEqual(activities(events.reverse()).map(row=>row.label),['Looking through your StockChief screens','A step needs attention']);
});
