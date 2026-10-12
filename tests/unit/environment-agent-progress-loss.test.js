'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const base='../../scripts/environment-agent-demo/',sample=require('../fixtures/environment-agent-progress-loss/recorded.json');
const evidence=require(base+'evidence'),memory=require(base+'memory'),observations=require(base+'observations'),context=require(base+'context');
function legacy(name){const filename=path.resolve(__dirname,'../fixtures/environment-agent-progress-loss/legacy',name+'.js'),mod={exports:{}};
 vm.runInThisContext('(function(require,module){'+fs.readFileSync(filename,'utf8')+'\n})')(
  id=>id==='./context'?context:id.startsWith('./')?legacy(id.slice(2)):require(id),mod);return mod.exports;}
function replay(modules={evidence,memory,observations}){
 let h={};const states=[],history=[{role:'user',content:sample.goal}];
 const steps=sample.events.filter(e=>e.kind==='agent_tool_started');
 for(const [i,event]of steps.entries()){
  const id=sample.goalId+':'+(i+1),entry=sample.evidence[id];
  const result=entry?JSON.parse(entry.text):modules.observations.retrieve(h,event.input);
  if(entry)modules.observations.store(h,{id,name:event.name,result,at:entry.at});
  modules.memory.observe(h,event.name,event.input,result,id);modules.evidence.remember(h,event.name,event.input,result,id);
  history.push({type:'function_call',callId:event.sdkToolCallId,name:event.name,arguments:JSON.stringify(event.input)},
   {type:'function_call_result',callId:event.sdkToolCallId,name:event.name,status:'completed',output:JSON.stringify(context.preview(result,id))});
  h=JSON.parse(JSON.stringify(h));states.push(structuredClone(h.progress));
 }
 return {h,states,history};
}
test('actual visible failure: negative controls reproduce premature stop and missing facts; integrated repair fixes both',()=>{
 const old=replay({evidence:legacy('evidence'),memory:legacy('memory'),observations:legacy('observations')});
 assert.equal(old.states[11].stagnant,2);assert.equal(old.h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
 const oldMemory=legacy('memory').working(old.h);assert(oldMemory.facts[0].partial);assert.equal(oldMemory.facts[0].data,undefined);
 const {h,states,history}=replay();assert.equal(states[11].last.newFacts,true);assert.equal(states[11].stagnant,0);
 assert.equal(h.progress.stagnant,2);assert.equal(h.progress.finalReason,undefined);
 const packed=memory.working(h);assert(packed.facts[0].data.rows);assert.equal(packed.facts[0].partial,undefined);
 assert.deepEqual(packed.facts[0].data.rows,JSON.parse(sample.evidence[sample.goalId+':12'].text).rows);
 const form=JSON.parse(sample.evidence[sample.goalId+':14'].text);
 assert(packed.browser.pages.some(p=>p.fields.length===3&&p.text===form.text));
 assert(context.bytes(packed)<=8500);assert(context.bytes(packed.browser)+context.bytes(packed.facts)<=5000);
 // Exercise BOTH production context boundaries with the actual tool trace.
 const sdk=context.windowInput({input:history});assert(context.bytes(sdk.input)<=16000);
 const input=sdk.input.map(i=>i.type==='function_call'?{type:i.type,call_id:i.callId,name:i.name,arguments:i.arguments}:
  i.type==='function_call_result'?{type:'function_call_output',call_id:i.callId,output:i.output}:i);
 const fitted=require(base+'wire-context').fit('openai',{model:require(base+'wire-policy').MODELS.openai,max_output_tokens:3000,input},{memory:packed});
 const supplied=JSON.parse(fitted.body.input.at(-1).content.slice(require(base+'wire-context').NOTICE.length));
 assert.deepEqual(supplied.facts[0].data.rows,packed.facts[0].data.rows);
 for(const c of form.controls.filter(c=>c.tag==='input'))assert(JSON.stringify(fitted.body).includes(c.ref));
 assert.notEqual(fitted.body.tool_choice,'none');assert(fitted.inputTokens<=60000);
});
test('recorded journal remains immutable and survives JSONB key reordering without preferring stale forms',()=>{
 const {h}=replay(),saved=JSON.stringify(h.evidence);
 const reorder=Object.fromEntries(Object.entries(h.evidence).reverse());
 h.evidence=reorder;const view=memory.working(h);
 assert(view.browser.pages.some(p=>p.evidenceId===sample.goalId+':14'));
 assert(!view.browser.pages.some(p=>p.evidenceId===sample.goalId+':4'));
 for(const e of Object.values(h.evidence))assert.equal(e.text,sample.evidence[e.id].text);
 assert.equal(Object.keys(JSON.parse(saved)).length,Object.keys(h.evidence).length);
 const fact=Object.values(h.facts)[0];h.facts={newer:{...fact,observedAt:'2026-10-13',data:{rows:[{value:'new'}]}},older:{...fact,observedAt:'2026-10-12',data:{rows:[{value:'old'}]}}};
 assert.equal(memory.working(h).facts[0].data.rows[0].value,'new');
});
test('timestamps, query variations, references, notes and contract lookups cannot launder a loop',()=>{
 const form=JSON.parse(sample.evidence[sample.goalId+':14'].text),data=JSON.parse(sample.evidence[sample.goalId+':12'].text),h={};
 evidence.remember(h,'environment_dataset',{},data,'first');
 evidence.remember(h,'environment_browser',{},form,'screen');
 for(let i=0;i<4;i++){
  evidence.remember(h,'environment_dataset',{offset:i},{...data,asOf:'different '+i},'r'+i);
  evidence.remember(h,'environment_interfaces',{search:String(i)},{operations:[{name:'contract'+i}]},'c'+i);
  evidence.remember(h,'environment_notebook',{note:'new hypothesis '+i},{saved:true},'n'+i);
  evidence.remember(h,'environment_browser',{}, {...form,controls:form.controls.map(c=>({...c,ref:'new'+i+c.ref}))},'b'+i);
 }
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
 const changed=structuredClone(data);changed.rows[0].on_hand='different recorded value';
 evidence.remember(h,'environment_dataset',{},changed,'changed');assert.equal(h.progress.stagnant,0);
 evidence.remember(h,'environment_browser',{},form,'refresh');assert.equal(h.progress.stagnant,1);
 assert.equal(h.progress.finalReason,undefined);
});
test('even identical-query reads with a fresh envelope timestamp remain repetitions',()=>{
 const data=JSON.parse(sample.evidence[sample.goalId+':12'].text),h={};
 for(let i=0;i<5;i++)evidence.remember(h,'environment_dataset',{}, {...data,asOf:'clock '+i},'r'+i);
 assert.equal(h.progress.stagnant,4);assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
});
test('actual form filling advances progress without relaxing the four-repeat stop or turn limit',()=>{
 const {h}=replay(),form=JSON.parse(sample.evidence[sample.goalId+':14'].text);
 const changed=structuredClone(form);changed.controls[0].value='38';
 evidence.remember(h,'environment_browser',{action:'fill'},changed,'filled');assert.equal(h.progress.stagnant,0);
 for(let i=0;i<4;i++)evidence.remember(h,'environment_browser',{action:'inspect'},changed,'r'+i);
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
});
test('bounded memory retains real row values, not display copies, across large surrounding histories',()=>{
 const {h}=replay();
 for(let i=0;i<40;i++)h.evidence['older'+i]={id:'older'+i,name:'environment_browser',at:'2020-01-01',text:JSON.stringify({url:'http://local/old'+i,text:'Historical page '.repeat(500),controls:[]})};
 h.notebook={note:'🙂'.repeat(1000)};h.lastToolError={message:'🙂'.repeat(1000)};
 const view=memory.working(h);assert(context.bytes(view)<=8500);assert(view.facts[0].data.rows.length===2);
 assert(view.browser.pages.some(p=>p.evidenceId===sample.goalId+':14'));
});
module.exports={replay};
