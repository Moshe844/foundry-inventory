'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{compact,expand}=require('../../scripts/environment-agent-demo/interface-presentation');
test('operation index prefix groups preserve complete names and order without changing any operation authority',()=>{
 const names=Array.from({length:180},(_,i)=>'unfamiliar_extension.workflow_operation_'+i),value={operations:[{name:'read.existing',kind:'read',fields:{},authority:{mode:'none'}}],operationIndex:{read:['read.existing'],mutation:names},indexComplete:true};const wire=compact(value);assert.equal(wire._stockchiefOperationIndexEncoding,'operation_numbers_and_prefix_groups');assert.deepEqual(expand(wire),value);assert(Buffer.byteLength(JSON.stringify(wire))<Buffer.byteLength(JSON.stringify(value))/2);const corrupt=structuredClone(wire);corrupt.operationIndex.mutation[0].suffixes[0]=4;assert.throws(()=>expand(corrupt),/INVALID_INTERFACE_INDEX_PREFIX/);
});
test('small repeated metadata remains lossless and uses its actual reference size rather than starving useful schemas',()=>{
 const schema={type:'string',description:'A current typed field with a repeated explanation that belongs in both complete metadata contracts.'},original={operations:[{name:'read.one',fields:{name:schema}},{name:'read.two',fields:{name:schema}}]},wire=compact(original);
 assert(wire._stockchiefDefinitions);assert(Buffer.byteLength(JSON.stringify(wire))<Buffer.byteLength(JSON.stringify(original)));assert.deepEqual(expand(wire),original);
});
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

test('shared defaults preserve empty properties, explicit differences and complete dataset lookup',()=>{
 const original={operations:[{name:'read.a',kind:'read',required:[],authority:{mode:'none'},unavailable:[]},{name:'read.b',kind:'read',required:[],authority:{mode:'none'},unavailable:[]}],datasetIndex:[{name:'directory',detailsByName:true,fields:{name:'text'}},{name:'totals',detailsByName:true}]};
 const wire=compact(original);assert.deepEqual(expand(wire),original);assert.deepEqual(compact(wire),wire);assert.equal(wire._stockchiefOperationDefaults.kind,'read');assert.equal(wire._stockchiefDatasetDefaults.detailsByName,true);
 const different={operations:[original.operations[0],{name:'write.a',kind:'mutation',required:['amount'],authority:{mode:'owner_review'},unavailable:['missing_scope']}]};assert.deepEqual(expand(compact(different)),different);
});

test('complete operation indexes retain exact order and unknown details without repeating delivered names',()=>{
 const operations=Array.from({length:30},(_,i)=>({name:'read.long_record_type_'+i,kind:'read',required:[],fields:{},authority:{mode:'none'},unavailable:[]}));
 const original={operations,operationIndex:{read:[operations[9].name,'read.details_not_delivered',...operations.map(o=>o.name)],mutation:['write.undelivered']},indexComplete:true};
 const before=JSON.stringify(original),wire=compact(original);assert.equal(wire._stockchiefOperationIndexEncoding,'operation_numbers');assert.equal(wire.operationIndex.read[0],9);assert.equal(wire.operationIndex.read[1],'read.details_not_delivered');assert.deepEqual(wire.operationIndex.mutation,['write.undelivered']);
 assert.deepEqual(expand(JSON.parse(JSON.stringify(wire))),original);assert.equal(JSON.stringify(original),before);assert.deepEqual(compact(wire),wire);assert.equal(wire.indexComplete,true);
 for(const bad of [-1,1.5,1000,null])assert.throws(()=>expand({...wire,operationIndex:{read:[bad]}}),/INTERFACE_INDEX_REFERENCE_UNAVAILABLE/);
 assert.throws(()=>expand({...wire,_stockchiefOperationIndexEncoding:'unrecognized'}),/INVALID_INTERFACE_INDEX_ENCODING/);
});
