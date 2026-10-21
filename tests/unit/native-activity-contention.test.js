'use strict';const test=require('node:test'),assert=require('node:assert/strict');
const {activityDetail}=require('../../src/assistant/postgres-codex-runtime'),ui=require('../../src/web/public/adaptive-goal');
test('recorded simple-answer diagnostic bursts preserve every customer activity without empty goal-lock writes',()=>{
 // This sequence produced thirteen progress transactions during one actual
 // short answer. Timing and charging facts already exist in provider receipts.
 const kinds=['runtime_starting','model_profile_selected','runtime_starting','codex_isolation','codex_input_count',
  'model_call','model_response','agent_tool_started','canonical_operation','agent_tool_completed','codex_input_count',
  'model_call','model_response','native_completion_checkpoint','answer_scope_review_started','codex_input_count',
  'model_call','model_response','answer_scope_review_settled','host_final_verification'];
 const events=kinds.map((kind,sequence)=>({sequence,kind:'agent_activity',detail:{kind,tool:kind==='agent_tool_started'?'business_operations':null}}));
 const projected=events.flatMap(event=>{const detail=activityDetail(event.detail);return detail?[{...event,detail}]:[];});
 assert.equal(projected.length,5,'Only meaningful progress competes with durable native persistence');
 assert.deepEqual(ui.activities(projected),ui.activities(events),'All displayed stages and their order survive projection');
 assert.equal(ui.activities(projected).at(-1).label,'Verifying the result');
 assert(projected.some(e=>e.detail.kind==='answer_scope_review_started'));
 assert(!JSON.stringify(projected).includes('model_call'));
});
test('approval, refusal, interruption, failures and unknown future progress are retained',()=>{
 for(const kind of ['runtime_failed','agent_tool_failed','model_call_blocked','native_report_correction','runtime_cleanup_failed','future_progress']){
  const detail=activityDetail({kind,code:'SAFE_FAILURE',limitKind:'provider_transport'});assert(detail);assert.equal(detail.code,'SAFE_FAILURE');
 }
 assert.equal(ui.activity({kind:'approval_ready'}),'Prepared a change for your approval');
 assert.equal(ui.activity({detail:activityDetail({kind:'model_call_blocked'})}),'A step needs attention');
 for(const tool of ['environment_dataset','business_dataset'])assert.equal(ui.activity({detail:activityDetail({kind:'agent_tool_started',name:tool})}),'Checking your business records');
 assert.equal(ui.activity({detail:activityDetail({kind:'agent_tool_started',name:'business_operations'})}),'Working with your business records');
 const detail=activityDetail({kind:'host_final_verification',timings:{finalVerificationMs:24,providerBody:'PRIVATE',providerMs:-1,admissionMs:Infinity},raw:'PRIVATE',apiKey:'PRIVATE'});
 assert.deepEqual(detail.timings,{finalVerificationMs:24});assert(!JSON.stringify(detail).includes('PRIVATE'));
 assert.equal(activityDetail({kind:'codex_input_count',raw:'PRIVATE'}),null);
});
