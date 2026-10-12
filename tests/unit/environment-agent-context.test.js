'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {windowInput,bytes,LIMIT,preview}=require('../../scripts/environment-agent-demo/context');
test('bounded context preserves user constraints and complete recent tool rounds without model compaction',()=>{
 const original={role:'user',content:'Investigate an unfamiliar business. Never send a message or change stock.'};
 const input=[original];
 for(let i=0;i<100;i++)input.push({type:'reasoning',id:`r${i}`,content:[],providerData:{encrypted_content:'signed'}},
  {type:'function_call',name:'environment_dataset',callId:`c${i}`,arguments:'{}'},
  {type:'function_call_result',name:'environment_dataset',callId:`c${i}`,output:'untrusted '.repeat(450),status:'completed'});
 const filtered=windowInput({instructions:'unchanged authority',input},[{id:'observation-1',tool:'environment_dataset'}]);
 assert.ok(bytes(filtered.input)<=LIMIT);assert.ok(bytes(input)>300000);
 assert.deepEqual(filtered.input[0],original);assert.equal(filtered.instructions,'unchanged authority');
 assert.equal(filtered.input.at(-1).callId,'c99');
 for(const result of filtered.input.filter(i=>i.type==='function_call_result'))
  assert.ok(filtered.input.some(i=>i.type==='function_call'&&i.callId===result.callId));
 assert.ok(input.length>filtered.input.length,'durable input is not mutated');
 assert.throws(()=>windowInput({input:[original,{type:'function_call',callId:'pending'}]}),/INCOMPLETE/);
 assert.throws(()=>windowInput({input:[{role:'user',content:'do not change '.repeat(5000)}]}),/BUDGET_EXHAUSTED/);
});
test('old screenshot payloads leave the working context and evidence previews disclose truncation',()=>{
 const input=[{role:'user',content:'Inspect'}];
 for(let i=0;i<8;i++)input.push({type:'function_call',name:'environment_browser',callId:String(i),arguments:'{}'},
  {type:'function_call_result',name:'environment_browser',callId:String(i),status:'completed',output:[{type:'image',image:'data:image/png;base64,AA'}]});
 const filtered=windowInput({input});
 assert.equal(JSON.stringify(filtered).split('data:image').length-1,1);
 assert.equal(JSON.stringify(input).split('data:image').length-1,8);
 const output={url:'http://127.0.0.1/',text:'不信任内容'.repeat(8000),controls:[{ref:'observed',label:'Products'}]};
 const small=preview(output,'journal:7');assert.equal(small.evidenceId,'journal:7');
 assert.equal(small.truncated,true);assert.ok(bytes(small)<6500);assert.equal(small.controls[0].ref,'observed');
});

test('bounded browser previews retain live continuation and field handles without claiming omitted options are complete',()=>{
 const control={ref:'field-ref',tag:'select',name:'random-field',label:'Packaging',required:true,
  form:{method:'get',action:'/random'},optionsOffset:10,optionsTotal:251,optionsTruncated:true,optionsNextRef:'options-next',
  options:Array.from({length:100},(_,i)=>({value:String(i+10),label:'Long option label '.repeat(20)+i}))};
 const output={url:'http://127.0.0.1/random',partial:true,controls:[control]};
 const result=preview(output,'observation-2');assert.ok(bytes(result)<=6500);
 assert.equal(result.evidenceId,'observation-2');assert.equal(result.partial,true);
 assert.equal(result.controls[0].ref,'field-ref');assert.equal(result.controls[0].optionsNextRef,'options-next');
 assert.equal(result.controls[0].optionsPreviewOnly,true);assert.equal(result.controls[0].optionsOffset,10);
 assert.deepEqual(result.controls[0].form,control.form);assert.equal(result.controls[0].required,true);
 const evidence=require('../../scripts/environment-agent-demo/evidence');
 const retrieved=[];let offset=0;
 do{const page=evidence.page(output,'observation-2',offset);retrieved.push(...page.records);offset=page.nextOffset;}while(offset!==null);
 assert.ok(retrieved.some(r=>r.value?.value==='109'),'preview omissions remain retrievable');
 const h={};
 for(let i=0;i<6;i++){
  evidence.remember(h,'environment_browser',{action:'inspect'},{...output,controls:[{...control,ref:'field-'+i,optionsNextRef:'cursor-'+i}]},'obs-'+i);
  evidence.remember(h,'environment_interfaces',{search:'some contract'},{operations:[]},'other-'+i);
 }
 assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE','random live cursors must not hide unchanged-page loops');
});
