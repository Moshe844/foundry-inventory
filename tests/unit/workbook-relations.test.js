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

test('equivalent worksheet relationships retain exact records regardless of serialization direction or order',()=>{
 const original=contract(),reversed=contract();reversed.joins=[{sheet:0,fromSheet:1,fromColumn:0,toColumn:0}];
 const expected=relations.compile(fixture(),original),actual=relations.compile(fixture(),reversed);assert.deepEqual(actual.sheet,expected.sheet);assert.deepEqual(actual.contract,expected.contract);assert.equal(reversed.joins[0].sheet,0,'Source interpretation is not mutated');
 const book=fixture();book.sheets.push(sheet('Other attributes',[['Reference','Grade code'],['ZX-11','X'],['ZX-27','Y']]));
 const a=contract();a.coverage.push({sheet:3,role:'reference',reason:'Complementary attributes.'});a.joins.push({sheet:3,fromSheet:1,fromColumn:0,toColumn:0});const b=structuredClone(a);b.joins.reverse();assert.deepEqual(relations.compile(book,b).sheet,relations.compile(book,a).sheet);
 const cycle=contract();cycle.joins.push({...cycle.joins[0]});assert.throws(()=>relations.compile(fixture(),cycle),/repeated or circular/);
 const self=contract();self.joins=[{sheet:0,fromSheet:0,fromColumn:0,toColumn:0}];assert.throws(()=>relations.compile(fixture(),self),/repeated or circular/);
 const disconnected=contract();disconnected.joins=[{sheet:1,fromSheet:2,fromColumn:1,toColumn:0}];assert.throws(()=>relations.compile(fixture(),disconnected),/could not safely match/);
 const duplicate=fixture();duplicate.sheets[1].rows.push({...duplicate.sheets[1].rows[0]});assert.throws(()=>relations.compile(duplicate,reversed),/duplicate join key/,'Reorientation must never multiply stock');
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
test('contextual references are accounted for without pretending their records were joined or imported',()=>{
 const spec=contract();spec.coverage[2]={sheet:2,role:'reference',reason:'Read as historical context, not replayed.'};const result=relations.compile(fixture(),spec);assert.equal(result.physicalUnits,9);assert.equal(result.coverage[2].role,'not_imported');assert.equal(result.coverage[2].contextOnly,true);assert.equal(result.coverage[2].joined,false);spec.coverage[2].role='inventory';assert.throws(()=>relations.compile(fixture(),spec),/coverage disagrees/);
});
test('tracking flags cannot masquerade as serial or lot identifiers',()=>{
 const s=sheet('Flags',[['SKU','Serial Tracked','Lot Tracked'],['XX-1','No','No'],['XX-2','Yes','No']]);const guess=fields.guessMappings(s.columns,s.rows);assert.equal(guess.mappings.serial,undefined);assert.equal(guess.mappings.lotCode,undefined);assert.equal(guess.mappings.serialTracked,1);assert.equal(guess.mappings.lotTracked,2);
});
test('workbook profiles discover categories and tracking requirements appearing after the first rows',()=>{
 const rows=[['Reference','Unfamiliar attribute','Serial Tracked'],...Array.from({length:120},(_,i)=>['REF-'+i,i===119?'Carton of six':'Each',i===119?'Yes':'No'])],s=sheet('Late distinctions',rows),p=relations.profile({sheets:[s]})[0];assert.equal(p.columns[1].distinct,2);assert.deepEqual(p.columns[1].samples,['Each','Carton of six']);assert.deepEqual(p.columns[2].samples,['No','Yes']);assert.equal(p.columns[2].booleanRate,1);
});
test('numeric Excel roundoff is normalized, genuine precision and text are preserved',()=>{
 const XLSX=require('xlsx'),book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['SKU','Unit Cost','Sell Price','Exact text'],['XX-1',8.130000000000001,1.234,'8.130000000000001']]),'Data');const result=parser.parse({buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})});assert.deepEqual(result.sheets[0].rows[0].cells,['XX-1','8.13','1.234','8.130000000000001']);
});
