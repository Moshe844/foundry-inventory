'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),wire=require('../../scripts/environment-agent-demo/evidence-presentation'),codec=require('../../scripts/environment-agent-demo/record-presentation');
test('recorded one-based row failure stays rejected while filtered rows retain exact host paths across journal restart',()=>{
 const fixture=require('../fixtures/codex-record-row-offset.json'),original=structuredClone(fixture.observation),saved=JSON.stringify(original),h={evidence:{}};
 const entry=require('../../scripts/environment-agent-demo/observations').store(h,{id:'recorded:1',name:'business_operations',result:original});
 assert.notEqual(wire.locate(original,fixture.failedClaim.path).value,fixture.failedClaim.value,'Reproduce the actual live failure before adding coordinates');
 const projected=wire.project('business_operations',JSON.parse(entry.text)),field=projected._stockchiefRecordPaths.field,filtered=projected.outcomes[0].result.rows.filter(r=>r.status==='FULFILLED').reverse();
 for(const row of filtered){assert.equal(wire.locate(original,row[field]+'/order').value,row.order);assert.equal(wire.locate(original,row[field]+'/status').value,row.status);assert.equal(codec.metadataClaim(original,row[field]+'/order'),false);assert.equal(codec.metadataClaim(original,row[field]+'/'+field),true);}
 assert.equal(filtered.find(r=>r.order==='SO-00003')[field],'/outcomes/0/result/rows/2');assert.equal(codec.metadataClaim(original,'/_stockchiefRecordPaths/field'),true);
 const restarted=JSON.parse(JSON.stringify(h));assert.deepEqual(wire.project('business_operations',JSON.parse(restarted.evidence[entry.id].text)),projected);assert.equal(JSON.stringify(original),saved);assert.equal(entry.text,saved,'Presentation must never change the journal or its hash');
});
test('unfamiliar dataset names and colliding user fields retain all values and escaped coordinates',()=>{
 const value={'unknown/~section':{rows:[{_stockchiefRecordPath:'a real user-defined column',quantity:0,available:false,nested:{rows:[{value:null}]}},null,7,['array row']]}};
 const encoded=wire.project('environment_dataset',value),field=encoded._stockchiefRecordPaths.field;assert.notEqual(field,'_stockchiefRecordPath');const row=encoded['unknown/~section'].rows[0];assert.equal(row._stockchiefRecordPath,value['unknown/~section'].rows[0]._stockchiefRecordPath);assert.equal(row[field],'/unknown~1~0section/rows/0');assert.equal(wire.locate(value,row[field]+'/quantity').value,0);assert.equal(wire.locate(value,row[field]+'/available').value,false);assert.equal(codec.metadataClaim(value,row[field]+'/_stockchiefRecordPath'),false);
 assert.equal(row.nested.rows[0][field],'/unknown~1~0section/rows/0/nested/rows/0');assert.deepEqual(encoded['unknown/~section'].rows.slice(1),value['unknown/~section'].rows.slice(1));assert.equal(codec.project({rows:[]})._stockchiefRecordPaths,undefined);
 const collision={_stockchiefRecordPaths:{user:'retained'},rows:[{name:'unchanged'}]};assert.equal(codec.project(collision),collision,'Reserved root collisions must preserve the complete value without rewriting data');
});

test('coordinates preserve the exact JSON wire values of driver timestamps and buffers',()=>{
 const source={rows:[{at:new Date('2026-10-16T13:00:00.123Z'),bytes:Buffer.from('fixture'),amount:0}]},expected=JSON.parse(JSON.stringify(source)),view=codec.project(source),key=view._stockchiefRecordPaths.field;
 const {[key]:coordinate,...business}=view.rows[0];assert.equal(coordinate,'/rows/0');assert.deepEqual(business,expected.rows[0]);assert(source.rows[0].at instanceof Date);assert(Buffer.isBuffer(source.rows[0].bytes));
});
