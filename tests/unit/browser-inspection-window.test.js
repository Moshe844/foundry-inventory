'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const codec=require('../../scripts/environment-agent-demo/browser-presentation'),refs=require('../../scripts/environment-agent-demo/source-references');

test('an inspection window is not evidence that the actual application picker is paginated',()=>{
 // Recorded live failure shape: a native SELECT held 26 DOM options, while
 // the inspector initially returned 10. The answer confused these two layers.
 const original={url:'http://127.0.0.1:1/unfamiliar',controls:[{tag:'select',name:'choice',label:'Product',
  options:Array.from({length:10},(_,i)=>({label:'Choice '+i,value:String(i)})),optionsTotal:26,
  optionsOffset:0,optionsTruncated:true,optionsNextRef:'opaque-inspection-continuation'}],
  pagination:{controlOffset:0,controlTotal:1,controlsNextRef:null}};
 const text=JSON.stringify(original),entry={id:'observation',name:'environment_browser',text,sha256:createHash('sha256').update(text).digest('hex')};
 for(const observation of [original,{screen:original,image:{mimeType:'image/png',base64:'unchanged'}}]){
  const projected=codec.compact(observation),screen=projected.screen||projected;
  assert.equal(screen.pagination,undefined);assert.equal(screen.controls[0].optionsTruncated,undefined);
  assert.equal(screen.controls[0].optionsTotal,26,'The real DOM option count remains visible');
  assert.match(screen._stockchiefInspectionWindow.notice,/does not mean the application/);
  assert.deepEqual(codec.expand(projected),observation,'Window encoding must be lossless');
 }
 const projected=refs.present(entry,codec.compact(original)),control=projected.controls[0];
 assert(control._stockchiefValueRefs.optionsTotal,'Actual DOM facts remain citable');
 assert.equal(control._stockchiefValueRefs.optionsTruncated,undefined);
 assert.equal(control._stockchiefInspectionWindow._stockchiefValueRefs,undefined);
 for(const path of ['/pagination/controlTotal','/controls/0/optionsTruncated','/controls/0/optionsOffset',
  '/controls/0/optionsNextRef','/controls/0/_stockchiefInspectionWindow/options/optionsTruncated'])assert(refs.metadataClaim(entry,path),path);
 assert.equal(refs.metadataClaim(entry,'/controls/0/optionsTotal'),false);
 assert.equal(refs.metadataClaim(entry,'/controls/0/options/0/value'),false);
 const claim=refs.resolve([entry],{sourceRef:control._stockchiefValueRefs.optionsTotal,value:26});
 assert.equal(claim.path,'/controls/0/optionsTotal');assert.equal(claim.value,26);
});

test('saved whole-control encodings still verify fresh DOM facts, while paging claims and changed controls fail',async()=>{
 const original={url:'http://127.0.0.1:1234/discovered',applicationPage:true,httpStatus:200,controls:[{ref:'live',tag:'select',name:'actualChoice',label:'Actual choice',value:'x',options:[{label:'X',value:'x',disabled:false}],optionsTotal:1,optionsOffset:0,optionsTruncated:false}],pagination:{controlOffset:0,controlTotal:1}};
 const text=JSON.stringify(original),sourceText=JSON.stringify({version:1,name:'environment_browser',input:{action:'inspect'}}),entry={id:'observation',name:'environment_browser',text,sha256:createHash('sha256').update(text).digest('hex'),sourceText,sourceSha256:createHash('sha256').update(sourceText).digest('hex')};
 const goal={id:'goal',workspace_id:'workspace',actor_user_id:'actor',original_request:'Inspect the choices in the form.',checkpoint:{harness:{evidence:{[entry.id]:entry},calls:{},native:{}}}},ctx={workspaceId:'workspace',actorId:'actor'},database={query:async()=>{throw Error('UNEXPECTED_QUERY');}},verification=require('../../src/assistant/postgres-codex-verification');
 const report={version:1,status:'completed',outcome:'answer',answer:'The select control offers X.',claims:[{evidenceId:entry.id,path:'/controls/0',value:codec.compact(original,{inspectionWindows:false}).controls[0]}]};
 const checked=await verification.verify(database,ctx,goal,JSON.stringify(report),null,{browser:{verifyObservation:async()=>structuredClone(original)}});assert.equal(checked.verified,true,JSON.stringify(checked));
 const changed=structuredClone(original);changed.controls[0].options[0].value='different';
 assert.equal((await verification.verify(database,ctx,goal,JSON.stringify(report),null,{browser:{verifyObservation:async()=>changed}})).verified,false);
 const metadata={...report,claims:[{evidenceId:entry.id,path:'/controls/0/optionsOffset',value:0}]};
 const rejected=await verification.verify(database,ctx,goal,JSON.stringify(metadata),null,{browser:{verifyObservation:async()=>{throw Error('METADATA_IS_NOT_DOM');}}});assert.equal(rejected.verificationFailure,'TRANSPORT_METADATA_NOT_EVIDENCE');
 const review=require('../../src/assistant/native-answer-review'),bound=review.binding(goal,JSON.stringify(report));
 assert(bound.input.evidence[0].observation._stockchiefInspectionWindow);
 assert.match(review.system,/never pagination or other behavior/);
 goal.checkpoint.harness.answerScopeReview={version:review.version,hash:bound.hash,state:'SETTLED',verdict:{grounded:false,complete:true,missingOutcomes:[],reason:'The DOM is supported; a claim of application pagination is not.'}};
 assert.equal(review.checked(goal,JSON.stringify(report)).verified,false,'Legacy decoding does not override semantic rejection');
 assert.throws(()=>review.binding(goal,JSON.stringify(metadata)),/METADATA_NOT_EVIDENCE/);
});
