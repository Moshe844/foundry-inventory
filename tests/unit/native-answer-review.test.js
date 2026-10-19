'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const review=require('../../src/assistant/native-answer-review');
function fixture(){
 // Sanitized shape of the recorded live failure: true provider-operation
 // values were used to claim that interrupted agent requests were recoverable.
 const text=JSON.stringify({dataset:'provider_effects',extent:{returnedRows:11,complete:true,totalRows:11},rows:Array.from({length:11},(_,i)=>({id:'effect-'+i,state:'SUCCEEDED'}))});
 const sourceText=JSON.stringify({version:1,name:'environment_dataset',input:{spec:{dataset:'provider_effects'}}}),entry={id:'evidence-1',name:'environment_dataset',text,sha256:createHash('sha256').update(text).digest('hex'),truncated:false,sourceText,sourceSha256:createHash('sha256').update(sourceText).digest('hex')};
 const goal={id:'goal-fixture',workspace_id:'workspace-fixture',actor_user_id:'actor-fixture',original_request:'Which open tasks await a human choice, an external provider, or recovery? Make no changes.',checkpoint:{messages:[],harness:{calls:{},evidence:{[entry.id]:entry}}}};
 const report={version:1,status:'completed',outcome:'answer',answer:'No recoverable interruption remains: all 11 provider operations succeeded.',claims:[{evidenceId:entry.id,path:'/rows/0/state',value:'SUCCEEDED'}]};
 return {goal,report,raw:JSON.stringify(report)};
}
test('true referenced values alone cannot authorize completion of the recorded scope error',()=>{
 const {goal,raw}=fixture(),bound=review.binding(goal,raw);assert.equal(bound.input.originalGoal,goal.original_request);assert.equal(bound.input.evidence[0].source.input.spec.dataset,'provider_effects');
 assert.deepEqual(review.checked(goal,raw),{required:true,verified:false,code:'ANSWER_SCOPE_NOT_REVIEWED'});
 goal.checkpoint.harness.answerScopeReview={version:review.version,hash:bound.hash,state:'SETTLED',verdict:review.verdict({grounded:true,complete:false,missingOutcomes:['State and recoverability of saved agent requests'],reason:'Provider-operation success does not establish the state or recoverability of agent requests.'})};
 assert.equal(review.checked(goal,raw).verified,false);assert.equal(review.checked(goal,raw).code,'ANSWER_SCOPE_UNVERIFIED');
});
test('review binds the whole delivered answer, clarifications, sources, tenant and actor across restart',()=>{
 const {goal,raw}=fixture(),bound=review.binding(goal,raw);goal.checkpoint.harness.answerScopeReview={version:review.version,hash:bound.hash,state:'SETTLED',verdict:{grounded:true,complete:true,missingOutcomes:[],reason:''}};
 assert.equal(review.checked(JSON.parse(JSON.stringify(goal)),raw).verified,true);
 for(const change of [g=>g.workspace_id='other',g=>g.actor_user_id='other',g=>g.checkpoint.messages.push('Also inspect stopped requests')]){const next=structuredClone(goal);change(next);assert.equal(review.checked(next,raw).verified,false);}
 assert.equal(review.checked(goal,JSON.stringify({...JSON.parse(raw),answer:'A different conclusion'})).verified,false);
 assert.equal(review.checked(goal,JSON.stringify({...JSON.parse(raw),workProducts:[{title:'More claims',content:'Different output'}]})).verified,false);
 assert.equal(review.checked(goal,JSON.stringify({...JSON.parse(raw),nextActions:[{label:'Different recommendation',instruction:'Do something else'}]})).verified,false);
 const changed=structuredClone(goal);changed.checkpoint.harness.evidence['evidence-1'].text+=' ';assert.throws(()=>review.binding(changed,raw),/EVIDENCE_UNAVAILABLE/);
});
test('canonical missions, proposals, standing-authority work and human handoffs need no additional review model',()=>{
 const {goal,raw}=fixture();
 for(const result of [{missionId:'mission-1'},{outcomes:[{result:{proposal:{id:'proposal-1'}}}]},{outcomes:[{result:{workId:'work-1'}}]}]){
  const next=structuredClone(goal);next.checkpoint.harness.calls={call:{state:'DONE',result}};assert.equal(review.binding(next,raw),null);
 }
 const navigated=structuredClone(goal);navigated.checkpoint.harness.calls={call:{state:'DONE',result:{outcomes:[{capability:'navigation.discovered',result:{status:'ANSWERED',navigation:{href:'/an-observed-page'}}}]}}};
 assert(review.binding(navigated,raw),'A prior navigation does not waive review of a later factual conclusion');
 for(const report of [{status:'needs_user',question:'Which available location?',missingInformation:['Location choice']},{status:'blocked',answer:'The requested operation is not supported.'},{...JSON.parse(raw),outcome:'navigation'}])assert.equal(review.binding(goal,JSON.stringify(report)),null);
 assert.throws(()=>review.verdict({grounded:false,reason:''}),/INVALID/);assert.throws(()=>review.verdict({grounded:true,reason:'',execute:true}),/INVALID/);
});
test('the recorded 270-character live diagnostic does not invalidate a typed decision or require another call',()=>{
 const reason='The complete attention list supports 27 approval items, 3 messages, 2 connection issues, and 2 stock alerts. All 11 provider-effect records succeeded, and the answer appropriately limits its interruption finding to those records. The evidence shows only read operations.';
 assert.equal(reason.length,270);
 const decision=review.verdict({grounded:true,complete:false,missingOutcomes:['Saved request interruptions and recoverability were not investigated.'],reason});
 assert.equal(decision.reason.length,200);assert.equal(decision.grounded,true);assert.equal(decision.complete,false);
 const {goal,raw}=fixture(),bound=review.binding(goal,raw);goal.checkpoint.harness.answerScopeReview={version:review.version,hash:bound.hash,state:'SETTLED',verdict:decision};
 assert.equal(review.checked(goal,raw).code,'ANSWER_SCOPE_UNVERIFIED');
 assert.match(review.checked(goal,raw).reason,/Saved request interruptions/);
 assert.equal(review.verdict({grounded:true,complete:true,missingOutcomes:[],reason}).complete,true);
});
test('legacy verdicts, missing decisions and nonempty missing outcomes cannot authorize completion',()=>{
 const {goal,raw}=fixture(),bound=review.binding(goal,raw);
 goal.checkpoint.harness.answerScopeReview={version:1,hash:bound.hash,state:'SETTLED',verdict:{grounded:true,reason:''}};
 assert.equal(review.checked(goal,raw).code,'ANSWER_SCOPE_NOT_REVIEWED');
 for(const value of [{grounded:true,reason:''},{grounded:true,complete:true,missingOutcomes:null,reason:''},
  {grounded:true,complete:true,missingOutcomes:[''],reason:''},{grounded:true,complete:'true',missingOutcomes:[],reason:''}])assert.throws(()=>review.verdict(value),/INVALID/);
 const value={grounded:true,complete:true,missingOutcomes:Array.from({length:10},(_,i)=>'Missing outcome '+i+' '+'.'.repeat(240)),reason:''};
 goal.checkpoint.harness.answerScopeReview={version:review.version,hash:bound.hash,state:'SETTLED',verdict:review.verdict(value)};
 assert.equal(review.checked(goal,raw).verified,false);assert.equal(goal.checkpoint.harness.answerScopeReview.verdict.missingOutcomes.length,8);
 assert.equal(goal.checkpoint.harness.answerScopeReview.verdict.missingOutcomes[0].length,200);
});
