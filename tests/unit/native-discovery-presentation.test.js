'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const codec=require('../../scripts/environment-agent-demo/browser-presentation');
test('browser text has one lossless source, while every line, field and action remains retrievable',()=>{
 const text=' New screen \n\n Changed form \r\n Quantity: 37\n';
 const original={text,textBlocks:{line0:'New screen',line1:'Changed form',line2:'Quantity: 37'},
  controls:[{ref:'live-unknown',name:'new_field',value:'37',required:true,form:{method:'post',action:'/unknown'},options:[{value:'x',label:'Unfamiliar'}]}]};
 const wire=codec.compact(original);assert.equal(wire.text,undefined);assert.deepEqual(wire.textBlocks,original.textBlocks);
 assert.deepEqual(codec.expand(wire),original);assert.deepEqual(wire.controls,original.controls);
 assert.deepEqual(codec.expand(codec.compact({screen:original,image:{base64:'unchanged'}})),{screen:original,image:{base64:'unchanged'}});
});
test('non-generated text blocks are preserved rather than guessed or discarded',()=>{
 const original={text:'different',textBlocks:{field:'Independent information'},controls:[]};
 assert.deepEqual(codec.expand(codec.compact(original)),original);
});
test('existing default encoding still restores all original field metadata',()=>{
 const defaults={type:null,role:null,name:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false};
 const original={text:'Information',textBlocks:{line0:'Information'},controls:[{...defaults,ref:'dynamic1',tag:'input',value:'5'},{...defaults,ref:'dynamic2',required:true,tag:'button',label:'Proceed'}]};
 assert.deepEqual(codec.expand(codec.compact(original)),original);
});
test('labelled citations survive a long form without model-side line counting',()=>{
 const blocks=Object.fromEntries(Array.from({length:80},(_,i)=>['line'+i,'Value '+i]));
 const original={text:Object.values(blocks).join('\n\n'),textBlocks:blocks,controls:[]};
 const wire=codec.compact(original);assert.equal(wire.textBlocks.line52,'Value 52');
 assert.deepEqual(codec.expand(wire),original);
});
test('canonical read links do not initialize a browser and are forwarded when it is opened',async()=>{
 let created=0;const received=[];
 const ui=require('../../scripts/environment-agent-demo/lazy-browser').lazyBrowser(async()=>{created++;return {observeReadLinks:v=>received.push(v),act:async()=>({ready:true})};});
 const links=[{capability:'read.purchase_orders',result:{status:'ANSWERED',rows:[{href:'/unknown-record'}]}}];
 await ui.observeReadLinks(links);assert.equal(created,0);
 assert.deepEqual(await ui.act({action:'inspect'}),{ready:true});assert.deepEqual(received,[links]);
 await ui.observeReadLinks(links);assert.equal(received.length,2);assert.equal(created,1);
});

test('governed dataset links survive lazy creation and journal restoration without teaching routes to the agent',async()=>{
 let created=0;const seen=[];
 const ui=require('../../scripts/environment-agent-demo/lazy-browser').lazyBrowser(async()=>{created++;return {
  observeDatasetLinks:result=>seen.push(result),act:async()=>({ready:true})};});
 const report={rows:[{href:'/record-'+require('node:crypto').randomUUID()}]};
 const tools=require('../../scripts/environment-agent-demo/candidates').sharedTools({browser:ui,gateway:{dataset:async()=>report}});
 assert.equal(await tools.find(t=>t.name==='environment_dataset').execute({specJson:'{}',offset:0}),report);
 assert.equal(created,0);assert.equal(seen.length,0);
 await ui.act({action:'inspect'});assert.deepEqual(seen,[report]);
 const restored=[];require('../../scripts/environment-agent-demo/read-navigation').restoreReadLinks({observeDatasetLinks:r=>restored.push(r)},
  {full:{name:'environment_dataset',text:JSON.stringify(report)},truncated:{name:'environment_dataset',text:JSON.stringify(report),truncated:true},
   model:{name:'environment_notebook',text:JSON.stringify(report)},broken:{name:'environment_dataset',text:'broken'}});
 assert.deepEqual(restored,[report]);
 await assert.rejects(()=>require('../../scripts/environment-agent-demo/candidates').sharedTools({browser:ui,gateway:{dataset:async()=>{throw Error('DENIED');}}})
  .find(t=>t.name==='environment_dataset').execute({specJson:'{}',offset:0}),/DENIED/);
 assert.equal(seen.length,1,'Failed/unauthorized reads cannot seed navigation');
 const legacy=[];require('../../scripts/environment-agent-demo/read-navigation').restoreReadLinks({observeReadLinks:r=>legacy.push(r)},
  {wrong:{name:'business_operations',text:'{"outcomes":"invalid"}'},empty:{name:'business_operations',text:'null'},
   valid:{name:'business_operations',text:JSON.stringify({outcomes:[null,{capability:'read.locations',result:{status:'ANSWERED',rows:[]}}]})}});
 assert.deepEqual(legacy,[[{capability:'read.locations',result:{status:'ANSWERED',rows:[]}}]],'Malformed legacy records cannot break restoration of valid observations');
});
