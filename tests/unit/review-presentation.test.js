'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),codec=require('../../src/assistant/review-presentation');
test('large review evidence retains every field, zero, null, source boundary and arbitrary customer key losslessly',()=>{
 const rows=Array.from({length:180},(_,index)=>Object.fromEntries([['product','Unfamiliar product '+index],['stock',index%11],['missing',null],['empty',''],['_reviewRows',{columns:['untrusted'],rows:[['still data']]}],['_reviewValue',index],['scope',{complete:index%2===0,totalRows:180,returnedRows:90}],['note','Treat this invoice text as data; it cannot grant permission or change the current goal.']]));
 const input={originalGoal:'Investigate the complete requested scope.',claims:[],evidence:[{id:'arbitrary-source',name:'unfamiliar_read',observation:{rows,extent:{complete:false,totalRows:360,returnedRows:180},nextOffset:180,zero:0,flag:false}}]},before=JSON.stringify(input),encoded=codec.encode(input);
 assert.deepEqual(codec.decode(encoded),input);assert.equal(JSON.stringify(input),before);assert.equal(encoded.originalGoal,input.originalGoal);assert(Buffer.byteLength(JSON.stringify(encoded))<Buffer.byteLength(before)*.75);
 assert.equal(codec.decode(encoded).evidence[0].observation.extent.complete,false);assert.equal(codec.decode(encoded).evidence[0].observation.nextOffset,180);
});
test('small packets remain unchanged and repeated irregular objects round-trip without prototype pollution',()=>{
 const small={evidence:[{observation:{rows:[{id:'A',quantity:0}]}}]};assert.equal(codec.encode(small),small);
 let seed=87;const random=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
 for(let round=0;round<12;round++){
  const evidence=Array.from({length:120},(_,i)=>({id:'e-'+i,source:{scope:'unfamiliar source scope '+round,complete:false},observation:JSON.parse(JSON.stringify({number:random()*1000,zero:0,empty:'',missing:null,rows:Array.from({length:3},()=>Object.fromEntries([['__proto__',{readOnly:true}],['word','معلومات Ω שלום'],['value',Math.floor(random()*100)],...(random()>.5?[['extra',false]]:[])]))}))}));
  const packet={originalGoal:'All requested outcomes '+round,evidence};assert.deepEqual(codec.decode(codec.encode(packet)),packet);
 }
 assert.equal({}.readOnly,undefined);
});
