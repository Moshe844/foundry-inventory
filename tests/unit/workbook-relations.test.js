'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const parser=require('../../src/imports/parser'),relations=require('../../src/imports/workbook-relations'),fields=require('../../src/imports/fields');
const sheet=(name,grid)=>({name,...parser.tabulate(grid)});
function fixture(){return {sheets:[
 sheet('Versions',[['Reference','Label','Hue','Grain','Profile','Grade'],['ZX-11','Panel','Blue','Fine','Slim','A'],['ZX-27','Panel','Red','Coarse','Wide','B']]),
 sheet('Physical counts',[['Reference','North counter','Back room','Physical total'],['ZX-27',3,0,3],['ZX-11',2,4,6]]),
 sheet('Prior transactions',[['Document','Reference','Quantity'],['ORDER-OLD','ZX-11',99]])]};}
function contract(){return {baseSheet:0,joins:[{sheet:1,fromSheet:0,fromColumn:0,toColumn:0}],fields:[{field:'code',source:{sheet:0,column:0}},{field:'name',source:{sheet:0,column:1}}],variants:[2,3,4,5].map(column=>({sheet:0,column})),stock:{total:{sheet:1,column:3},locations:[{sheet:1,column:1},{sheet:1,column:2}]},coverage:[{sheet:0,role:'inventory',reason:'Product identities and all configuration axes.'},{sheet:1,role:'reference',reason:'Physical opening counts; total checked, not added.'},{sheet:2,role:'not_imported',reason:'Historical transactions are not replayed.'}]};}
test('related sheets are joined by actual keys, matrices preserve zeroes and history never adds stock',()=>{
 const result=relations.compile(fixture(),contract());assert.equal(result.rows,undefined);assert.equal(result.sourceRows,2);assert.equal(result.outputRows,4);assert.equal(result.physicalUnits,9);assert.equal(result.variantColumns.length,4);
 const rows=result.sheet.rows,m=result.mappings;assert.deepEqual(rows.map(r=>r.cells[m.quantity]),['2','4','3','0']);assert.deepEqual(rows.map(r=>r.cells[m.location]),['North counter','Back room','North counter','Back room']);assert.deepEqual(JSON.parse(rows[0].cells[result.provenanceIndex]),{'Versions':2,'Physical counts':3});assert.equal(result.coverage[2].role,'not_imported');
});
test('ambiguous joins, incomplete coverage, duplicate pivots and invented columns are rejected',()=>{
 const book=fixture();book.sheets[1].rows.push({...book.sheets[1].rows[0]});assert.throws(()=>relations.compile(book,contract()),/duplicate join key/);
 const missing=contract();missing.coverage.pop();assert.throws(()=>relations.compile(fixture(),missing),/Every worksheet/);
 const repeated=contract();repeated.stock.locations.push(repeated.stock.locations[0]);assert.throws(()=>relations.compile(fixture(),repeated),/component is repeated/);
 const invented=contract();invented.fields[0].source.column=400;assert.throws(()=>relations.compile(fixture(),invented),/source column/);
});
test('unmatched records and inconsistent physical totals remain blocking evidence after persistence',()=>{
 const book=fixture();book.sheets[1].rows[0].cells[3]='4';book.sheets[1].rows.pop();const result=relations.compile(book,contract());assert.equal(result.outputRows,4);assert.equal(result.issueCount,1);const all=result.sheet.rows.flatMap(r=>JSON.parse(r.cells[result.problemsIndex]));assert(all.some(p=>p.code==='workbook_unmatched_key'));assert(all.some(p=>p.code==='workbook_stock_mismatch'));
});
test('tracking flags cannot masquerade as serial or lot identifiers',()=>{
 const s=sheet('Flags',[['SKU','Serial Tracked','Lot Tracked'],['XX-1','No','No'],['XX-2','Yes','No']]);const guess=fields.guessMappings(s.columns,s.rows);assert.equal(guess.mappings.serial,undefined);assert.equal(guess.mappings.lotCode,undefined);assert.equal(guess.mappings.serialTracked,1);assert.equal(guess.mappings.lotTracked,2);
});
test('numeric Excel roundoff is normalized, genuine precision and text are preserved',()=>{
 const XLSX=require('xlsx'),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['SKU','Unit Cost','Sell Price','Exact text'],['XX-1',8.130000000000001,1.234,'8.130000000000001']]),'Data');const result=parser.parse({buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})});assert.deepEqual(result.sheets[0].rows[0].cells,['XX-1','8.13','1.234','8.130000000000001']);
});
