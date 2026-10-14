'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{compact,expand}=require('../../scripts/environment-agent-demo/interface-presentation');
test('interface metadata sharing is lossless and preserves complete contracts, offsets and authority',()=>{
 const fields={search:{type:'string',description:'Search is an optional literal record name or code, not the whole question. Empty filtered results do not establish that a record is absent.'},timeframe:{type:'string',description:'Choose a supported date range.'}};
 const value={operations:Array.from({length:12},(_,i)=>({name:'read.fixture_'+i,kind:'read',fields,required:[],authority:{mode:'none'}})),datasets:[{name:'fixture',fields,queryContract:{fields,limits:{columns:12}}}],total:19,nextOffset:12,datasetNextOffset:null,policy:'No execution authority'};
 const original=JSON.stringify(value),wire=compact(value);assert(Buffer.byteLength(JSON.stringify(wire))<Buffer.byteLength(original)*0.7);
 assert.deepEqual(expand(JSON.parse(JSON.stringify(wire))),value);assert.equal(JSON.stringify(value),original,'original durable evidence is untouched');
 assert.deepEqual(wire.operations.map(o=>o.name),value.operations.map(o=>o.name));assert.equal(wire.nextOffset,12);assert.equal(wire.total,19);
 assert.deepEqual(compact({rows:[fields,fields]}),{rows:[fields,fields]},'business rows never use this format');
 const withNativeRef={...value,originalSchema:{$ref:'#/$defs/existing'}};assert.deepEqual(expand(compact(withNativeRef)),withNativeRef);
 const conflictingRef={...value,originalSchema:{$ref:'#/_stockchiefDefinitions/existing'}};assert.deepEqual(compact(conflictingRef),conflictingRef);
 assert.deepEqual(compact({_stockchiefDefinitions:{existing:true},operations:[],datasets:[]}),{_stockchiefDefinitions:{existing:true},operations:[],datasets:[]});
});
