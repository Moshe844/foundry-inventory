'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {compact,expand}=require('../../scripts/environment-agent-demo/browser-presentation'),{createPool}=require('../../scripts/environment-agent-demo/codex-sandbox-pool');
test('browser presentation preserves unknown form fields, values, options, safety flags and pointers losslessly',()=>{
 const controls=Array.from({length:80},(_,i)=>({ref:'live:'+i,tag:i%2?'select':'input',label:'Unfamiliar field '+i,name:'field_'+i,
  type:null,role:null,form:null,min:null,max:null,step:null,pattern:null,maxLength:null,description:'',disabled:false,required:false,readOnly:false,sensitive:false,multiple:false,optionsTruncated:false,
  value:'',checked:false,options:[{label:'New choice',value:'new_'+i,disabled:i%2===0}]}));
 controls[17]={...controls[17],required:true,disabled:true,sensitive:true,form:{method:'post',action:'/unregistered'},value:'pending',description:'Required physical measurement'};
 const original={url:'http://example.test/unknown',text:'Actual screen',controls,pagination:{controlsNextRef:'next:cursor'}};
 const encoded=compact(original);assert.deepEqual(expand(encoded),original);assert.equal(original.controls[0].required,false,'Source observations are immutable');
 assert.equal(encoded.controls[17].disabled,true);assert.equal(encoded.controls[17].required,true);assert.equal(encoded.controls[17].sensitive,true);
 assert.equal(encoded.controls[0].checked,false);assert.equal(encoded.controls[0].value,'');assert.equal(encoded.pagination.controlsNextRef,'next:cursor');
 assert(Buffer.byteLength(JSON.stringify(encoded))<Buffer.byteLength(JSON.stringify(original))*.65);
 const partial={controls:[{label:'No invented defaults',name:'unknown'}]};assert.deepEqual(expand(compact(partial)),partial);
 const wrapped={error:{code:'STALE_BROWSER_REFERENCE'},screen:original};assert.deepEqual(expand(compact(wrapped)),wrapped);
});
test('a spare is certified again, consumed once and never reused for another goal',async()=>{
 let serial=0;const closed=[],certified=[];
 const pool=createPool({image:'immutable',prepare:async image=>{const id=++serial;return {image,id,sandbox:{certify:async()=>{certified.push(id);return {passed:true};},close:async()=>{closed.push(id);}}};}});
 await pool.ready();await assert.rejects(pool.take('other-image'),/SCOPE_MISMATCH/);
 const first=await pool.take('immutable'),second=await pool.take('immutable');assert.notEqual(first.id,second.id);assert.deepEqual(certified,[first.id,second.id]);
 await first.sandbox.close();await second.sandbox.close();await pool.close();assert.equal(new Set(closed).size,3,'Both leased sandboxes and one unused spare close');
 await assert.rejects(pool.take('immutable'),/SCOPE_MISMATCH/);
});
test('failed fresh certification never releases a sandbox to an agent',async()=>{
 const closed=[];let i=0;const pool=createPool({image:'immutable',prepare:async()=>{const id=++i;return {id,sandbox:{certify:async()=>{throw Error('ISOLATION_CHANGED');},close:async()=>closed.push(id)}};}});
 await pool.ready();await assert.rejects(pool.take('immutable'),/ISOLATION_CHANGED/);assert(closed.includes(1));await pool.close();assert(closed.includes(2));
});
