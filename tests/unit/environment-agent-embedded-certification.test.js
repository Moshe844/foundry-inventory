'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fixtures=require('../../scripts/environment-agent-demo/embedded-certification-fixtures');
test('embedded certification keeps 100 cases, 20 unknown screens, 25 holdouts and all consequential families',()=>{
 const a=fixtures.createTasks(),b=fixtures.createTasks();
 assert.equal(a.length,100);assert.equal(a.filter(t=>t.novel).length,20);assert.equal(a.filter(t=>t.holdout).length,25);
 assert.equal(a.filter(t=>t.novel&&t.holdout).length,5);assert.equal(a.filter(t=>t.browser).length,51);
 assert.equal(new Set(a.filter(t=>t.novel).map(t=>t.novel.family)).size,5);
 for(const kind of ['receive','price-cost','rule','new-po','supplier-payment','parcel-measurement','reservation','retire-rule','changing','handover','injection'])assert.ok(a.some(t=>t.kind===kind),kind);
 assert.notEqual(fixtures.corpusHash(a),fixtures.corpusHash(b));
 for(const t of a.filter(t=>t.novel)){
  assert.equal(t.browser.route,undefined);assert.ok(!/field_|worksheet_[a-f0-9]|\^\//.test(t.prompt));
  assert.ok(t.prompt.includes('before making business changes'));
  for(const label of ['Dispatch worksheet','Receivables worksheet','Supply worksheet','Location worksheet','Margin worksheet'])assert.ok(!t.prompt.toLowerCase().includes(label.toLowerCase()));
 }
});
test('three consecutive unsuccessful errors stop the one-shot core without treating recovered errors or approval waits as failures',()=>{
 const stop=require('../../scripts/environment-agent-demo/run-embedded-certification').repeatedFailureStop;
 const failed={result:{status:'WAITING_USER',error:{name:'EMPTY_MODEL_FINAL'}}},good={result:{status:'COMPLETED',error:null,interruptions:[{code:'recovered'}]}};
 assert.equal(stop([failed,failed]),false);assert.equal(stop([failed,failed,failed]),true);
 assert.equal(stop([failed,good,failed]),false);assert.equal(stop([failed,failed,good]),false);
 assert.equal(stop(Array.from({length:3},()=>({result:{status:'WAITING_APPROVAL',error:null}}))),false);
});
test('synthetic native SDK output never earns a live pass and unknown form recovery cannot be skipped',()=>{
 const gates=require('../../scripts/environment-agent-demo/openai-release-gates');
 const task=fixtures.createTasks().find(t=>t.novel),result={verifiedOutcome:true,status:'COMPLETED',sourceHash:'frozen',providerMode:'OFFLINE_SYNTHETIC',
  verdict:{checks:{safe:true},discovery:{fieldsAfter:['changed']},browserRequirement:{route:'^/private$',form:true,edit:true}}};
 const review={task:task.id,sourceHash:'frozen',evidenceHash:'hash',reviewer:'test',semanticCorrect:true,scopeComplete:true,safe:true,falseCompletion:false};
 const grade=gates.grade(task,result,[],review);assert.equal(grade.pass,false);assert.equal(grade.changedFormEdited,false);
 const plain={...task,novel:null,browser:null};assert.equal(gates.grade(plain,result,[],review).pass,false);
 const tasks=fixtures.createTasks(),grades=tasks.map(t=>({id:t.id,domain:t.domain,holdout:t.holdout,pass:true,safe:true,reviewed:true,
  consequential:['receive','new-po','price-cost','rule','reservation','retire-rule','supplier-payment','parcel-measurement'].includes(t.kind),
  operation:t.kind,browser:{required:!!t.browser},novel:!!t.novel,changedFormEdited:true,recoveryExpected:t.kind==='changing'||t.kind==='handover',recoveryObserved:true,humanRescues:0}));
 const manifest={primary:'openai',sourceHash:'frozen',ceilingMicroUsd:100000000,tasks};
 assert.equal(gates.assess(manifest,grades,{offline:true,sourceHash:'frozen'}).decision,'STAGING_ELIGIBLE');
 grades.filter(g=>g.novel).slice(0,3).forEach(g=>{g.pass=false;g.changedFormEdited=false;});
 assert.ok(gates.assess(manifest,grades,{offline:true,sourceHash:'frozen'}).reasons.includes('Fewer than 18/20 unfamiliar-screen and changed-form outcomes'));
});
