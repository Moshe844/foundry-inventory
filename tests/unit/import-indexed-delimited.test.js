'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),parser=require('../../src/imports/parser');
test('indexed text retains ordinary parser semantics across headers, blanks, quotes and late columns',()=>{
 for(const delimiter of [',',';','\t','|'])for(const text of [
  ['Report','Exported today','','SKU,Name,Qty,Extra','A,"One\nwith ""quote""",1,','SKU,Name,Qty,Extra','','B,Two,2,late'].join('\n').replaceAll(',',delimiter),
  ['A,One,1','B,Two,2'].join('\n').replaceAll(',',delimiter),
  'SKU,Name,Qty\nA,One,1\nB,Two,2\n'.replaceAll(',',delimiter),
 ]){
  const regular=parser.parse({text}).sheets[0],indexed=parser.parse({text,indexed:true}).sheets[0];
  assert.deepEqual({...indexed,rows:[...indexed.rows]},regular);
  assert.deepEqual(indexed.rows.slice(-1),regular.rows.slice(-1));
  assert.deepEqual(indexed.rows.map(r=>r.sourceRow),regular.rows.map(r=>r.sourceRow));
  assert(Array.isArray(indexed.rows));
 }
});
test('no path silently accepts an unterminated quote, excess columns or excess indexed rows',()=>{
 for(const indexed of [true,false])assert.throws(()=>parser.parse({text:'SKU,Name\nA,"unfinished',indexed}),/quoted field/);
 assert.throws(()=>parser.parse({text:'SKU,Name\nA,One\nB,Two',indexed:true,maxRows:1}),/row capacity/);
 assert.throws(()=>parser.parse({text:Array.from({length:513},(_,i)=>'C'+i).join(','),indexed:true}),/column capacity/);
});
test('million-row source uses indexed access without retaining decoded rows',{timeout:60000},()=>{
 const text='SKU,Name,Qty\n'+'A,Product,1\n'.repeat(1000000),sheet=parser.parse({text,indexed:true}).sheets[0];
 assert.equal(sheet.rows.length,1000000);assert.equal(sheet.rows[999999].sourceRow,1000001);
 assert.deepEqual(sheet.rows.slice(999998).map(r=>r.cells),[['A','Product','1'],['A','Product','1']]);
});
