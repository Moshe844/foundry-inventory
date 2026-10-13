'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const recorded=require('../fixtures/environment-agent-context-loss/recorded.json');
const base='../../scripts/environment-agent-demo/';
const observations=require(base+'observations'),memory=require(base+'memory'),context=require(base+'context'),evidence=require(base+'evidence');
const legacyMemory=require('../fixtures/environment-agent-context-loss/legacy/memory');
const legacyContext=require('../fixtures/environment-agent-context-loss/legacy/context');
const wire=require(base+'wire-context'),policy=require(base+'wire-policy');
function rebuild(records){let root={};for(const r of records){if(!r.path){root=r.value;continue;}
 const keys=r.path.slice(1).split('/').map(k=>k.replaceAll('~1','/').replaceAll('~0','~'));let obj=root;
 for(let i=0;i<keys.length-1;i++)obj=obj[keys[i]]??=(/^\d+$/.test(keys[i+1])?[]:{});
 const key=keys.at(-1);if(Object.hasOwn(r,'text')){assert.equal((obj[key]||'').length,r.start);obj[key]=(obj[key]||'')+r.text;}else obj[key]=r.value;
}return root;}
function apiHistory(history){return history.filter(i=>i.type!=='reasoning').map(i=>{
 if(i.type==='function_call')return {type:i.type,call_id:i.callId,name:i.name,arguments:i.arguments};
 if(i.type==='function_call_result')return {type:'function_call_output',call_id:i.callId,output:typeof i.output==='string'?i.output:i.output.text||JSON.stringify(i.output)};
 return {role:i.role,content:typeof i.content==='string'?i.content:JSON.stringify(i.content)};
});}
for(const sample of recorded.cases)test(`recorded failure lifecycle: ${sample.task}`,()=>{
 const original={evidence:structuredClone(sample.evidence)};
 const forms=Object.values(sample.evidence).filter(e=>e.name==='environment_browser'&&JSON.parse(e.text).text?.includes('Handling requirement:'));
 assert.equal(legacyMemory.working(original).facts.length,0,'negative control: actual old memory omitted browser facts');
 assert.equal(JSON.stringify(sample.history).includes('Handling requirement:'),false,'captured final history had already lost the form');
 const initial=JSON.parse(Object.values(sample.evidence)[0].text);
 assert.equal(legacyContext.preview(initial,'first').controls.some(c=>/worksheet/i.test(c.label)),false);
 const compact=context.preview(initial,'first');
 assert(compact.controls.some(c=>/worksheet/i.test(c.label)),'actual discovered link is no longer buried behind null DOM metadata');
 assert(context.bytes(compact)<=6500);
 let h={};const history=[{role:'user',content:sample.goal}];let step=0;
 for(const event of sample.events.filter(e=>e.kind==='agent_tool_started')){
  step++;const entry=Object.values(sample.evidence).find(e=>e.id.endsWith(':'+step));
  const result=event.name==='environment_evidence'?observations.retrieve(original,event.input):JSON.parse(entry.text);
  const id=entry?.id||'replay:'+step;
  if(event.name!=='environment_evidence')observations.store(h,{id,name:event.name,result,at:event.at});
  memory.observe(h,event.name,event.input,result,id);evidence.remember(h,event.name,event.input,result,id);
  history.push({type:'function_call',name:event.name,callId:event.sdkToolCallId,arguments:JSON.stringify(event.input)},
   {type:'function_call_result',name:event.name,callId:event.sdkToolCallId,output:JSON.stringify(context.preview(result,id)),status:'completed'});
  h=JSON.parse(JSON.stringify(h)); // process checkpoint/recreation at every turn
  const retained=context.windowInput({input:history});assert(context.bytes(retained.input)<=context.LIMIT);
  const working=memory.working(h);assert(context.bytes(working)<=8500);
  const fitted=wire.fit('openai',{model:policy.MODELS.openai,max_output_tokens:3000,input:apiHistory(retained.input)},
   {memory:working,maxInputTokens:60000});
  assert(fitted.inputTokens<=60000);
  for(const form of forms.filter(e=>Number(e.id.split(':').at(-1))<=step)){
   const screen=JSON.parse(form.text);
   const transmitted=JSON.parse(fitted.body.input.at(-1).content.slice(wire.NOTICE.length));
   assert(transmitted.browser.pages.some(p=>p.text===screen.text),'observed complete form text survives BOTH context boundaries');
   for(const c of screen.controls.filter(c=>c.form&&['input','select','textarea'].includes(c.tag)))
    assert(JSON.stringify(fitted.body).includes(c.name),'unknown field retained without hardcoded names');
  }
 }
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE','exact original actions still reproduce the loop; do not fake a successful new plan');
 const classified=require(base+'outcome').classify({answer:sample.answer,verified:false,progress:h.progress});
 assert.equal(classified.status,'BLOCKED');assert.equal(classified.failure.code,'REPEATED_UNCHANGED_EVIDENCE');
 assert.equal(require(base+'run-embedded-certification').repeatedFailureStop(Array.from({length:3},()=>({result:classified}))),true);
 const index=[];let offset=0;do{const p=observations.retrieve(h,{id:'@index',offset});index.push(...p.records);offset=p.nextOffset;}while(offset!==null);
 for(const e of Object.values(h.evidence)){
  assert(JSON.stringify(index).includes(e.id),'complete discoverable index after restart');
  let pages=[],next=0;do{const p=observations.retrieve(h,{id:e.id,offset:next});pages.push(...p.records);next=p.nextOffset;}while(next!==null);
  assert.deepEqual(rebuild(pages),evidence.project(JSON.parse(e.text)));
 }
});
test('full observed payload, immutable identity and pagination survive former 128k truncation',()=>{
 const value={observations:recorded.cases.flatMap(c=>Object.values(c.evidence).map(e=>JSON.parse(e.text)))};
 assert(JSON.stringify(value).length>128000);const h={};observations.store(h,{id:'large',name:'environment_dataset',result:value});
 assert.equal(h.evidence.large.truncated,false);assert.deepEqual(JSON.parse(h.evidence.large.text),value);
 assert.throws(()=>observations.store(h,{id:'large',name:'environment_dataset',result:{different:true}}),/CONFLICT/);
 const restored=JSON.parse(JSON.stringify(h));let offset=0,records=[];
 do{const p=observations.retrieve(restored,{id:'large',offset});records.push(...p.records);assert(!p.sourceTruncated);offset=p.nextOffset;}while(offset!==null);
 assert.equal(JSON.stringify(records).includes('Handling requirement:'),true);
 assert.deepEqual(rebuild(records),value);
});
test('only an explicit question can wait for a user; a loop without a question remains a failure',()=>{
 const classify=require(base+'outcome').classify;
 assert.equal(classify({answer:'Incomplete, please retry.',verified:false}).status,'BLOCKED');
 const answer=JSON.stringify({status:'needs_user',question:'Which location received these goods?',missingInformation:'Physical receiving location is not specified or recorded.'});
 assert.equal(classify({answer,verified:false}).status,'WAITING_USER');
 assert.equal(classify({answer,verified:false,progress:{finalReason:'REPEATED_UNCHANGED_EVIDENCE'}}).status,'WAITING_USER');
 assert.equal(classify({answer:'Repeated inspections did not resolve the task.',verified:false,progress:{finalReason:'REPEATED_UNCHANGED_EVIDENCE'}}).status,'BLOCKED');
 assert.equal(classify({answer:'Approval pending',verified:false,current:'WAITING_APPROVAL'}).status,'WAITING_APPROVAL');
 assert.equal(classify({answer:'Verified',verified:true}).status,'COMPLETED');
});
test('versions of the ACTUAL discovered form remain addressable, partial detail does not erase the full form',()=>{
 const entry=Object.values(recorded.cases[0].evidence).find(e=>e.name==='environment_browser'&&JSON.parse(e.text).text?.includes('Handling requirement:'));
 const first=JSON.parse(entry.text),second=structuredClone(first),h={};
 // A controlled mutation of the captured failure, not a new task scenario.
 const field=second.controls.find(c=>c.tag==='input');field.name+='-changed';field.required=true;field.type='text';
 second.controls.reverse();second.text+='\nThe form has changed.';
 observations.store(h,{id:'version-1',name:'environment_browser',result:first});
 observations.store(h,{id:'version-2',name:'environment_browser',result:second});
 observations.store(h,{id:'detail',name:'environment_browser',result:{url:first.url,controls:[field],partial:true}});
 const restored=JSON.parse(JSON.stringify(h)),working=memory.working(restored);
 const full=working.browser.pages.find(p=>p.evidenceId==='version-2');assert(full);assert(full.fields.some(c=>c.name===field.name));
 assert.equal(working.browser.pages.some(p=>p.evidenceId==='version-1'),false);
 assert.equal(JSON.stringify(full.fields).includes('"ref"'),false,'historical fields never confer a live browser handle');
 assert.notEqual(restored.evidence['version-1'].sha256,restored.evidence['version-2'].sha256);
 assert.deepEqual(rebuild(observations.retrieve(restored,{id:'version-1'}).records),first);
});
