'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),parser=require('../../src/imports/parser'),tables=require('../../src/imports/workbook-tables');
const sheet=(name,grid)=>({name,...parser.tabulate(grid)});
test('independent worksheets preserve reordered canonical fields, zeroes, custom columns and provenance',async()=>{
 const book={sheets:[sheet('Comptage',[['SKU','Product name','Quantity','Unit cost (USD)','Selling price (USD)','Unit','Category','Reorder point','Supplier','Lead time','Size','Opaque attribute A'],['UNF-A','Écrou',0,'0.00','0.00','boxes','Hardware',2,'Supplier A',3,'M','Satin']]),sheet('מדף',[['Product name','Quantity','SKU','Selling price (USD)','Size','Unit cost (USD)','Supplier','Unit','Category','Lead time','Reorder point','Opaque attribute B'],['כיסא',7,'UNF-B','12.50','L','3.10','Supplier B','chairs','Furniture',5,4,'Review only']])]};
 const result=await tables.combine(book);assert(result);assert.equal(result.aiUsed,false);assert.equal(result.physicalUnits,7);assert.equal(result.sourceRows,2);assert.equal(result.coverage.filter(p=>p.combined).length,2);
 const read=(row,field)=>result.sheet.rows[row].cells[result.mappings[field]];
 assert.equal(read(0,'code'),'UNF-A');assert.equal(read(1,'code'),'UNF-B');assert.equal(read(1,'name'),'כיסא');assert.equal(read(0,'quantity'),'0');assert.equal(read(0,'sellingPrice'),'0.00');assert.equal(read(0,'unitCost'),'0.00');assert.equal(read(1,'unitLabel'),'chairs');assert.equal(read(1,'reorderPoint'),'4');assert.equal(read(1,'leadTimeDays'),'5');assert.equal(read(1,'supplierName'),'Supplier B');assert.equal(result.axisNames.variant1,'Size');assert.equal(read(1,'variant1'),'L');
 for(const label of ['Opaque attribute A','Opaque attribute B'])assert(result.sheet.columns.some(c=>c.name===label));
 assert.deepEqual(JSON.parse(result.sheet.rows[1].cells[result.provenanceIndex]),{'מדף':2});assert.deepEqual(JSON.parse(result.sheet.rows[1].cells[result.problemsIndex]),[]);
 assert.equal(book.sheets[1].rows[0].cells[2],'UNF-B','Source workbook is not mutated');
});
test('blank source column gaps retain their original indexes',async()=>{
 const source=sheet('A',[['SKU','','Name','Qty'],['GAP-A','','A',3]]),other=sheet('B',[['Name','Qty','','SKU'],['B',4,'','GAP-B']]);
 const result=await tables.combine({sheets:[source,other]});assert(result);assert.deepEqual(result.sheet.rows.map(row=>row.cells[result.mappings.code]),['GAP-A','GAP-B']);assert.equal(result.physicalUnits,7);
});

test('combined image pages retain uncertain readings and genuine source errors for review',async()=>{
 const first=sheet('Page A',[['SKU','Name','Quantity'],['PAGE-A','Bracket',2]]),second=sheet('Page B',[['SKU','Name','Quantity'],['PAGE-B','Hook',3]]);
 first.rows[0].problems=[{code:'image_identity_uncertain',message:'Confirm the original SKU.'},{code:'source_mismatch',message:'Source totals disagree.'}];
 const result=await tables.combine({sheets:[first,second]});assert(result);
 assert.deepEqual(JSON.parse(result.sheet.rows[0].cells[result.problemsIndex]),first.rows[0].problems);
 assert.deepEqual(JSON.parse(result.sheet.rows[1].cells[result.problemsIndex]),[]);
});
test('overlapping identities, complementary tables and different monetary meanings require interpretation',async()=>{
 const base=sheet('Stock',[['SKU','Name','Quantity','Unit cost (USD)'],['SAME-1','Widget',4,1]]);
 for(const alternative of [
  sheet('Other',[['SKU','Name','Quantity','Unit cost (USD)'],['same-1 ','Widget',4,1]]),
  sheet('Prices',[['SKU','Name','Unit cost (USD)'],['OTHER-1','Widget',1]]),
  sheet('Euro',[['SKU','Name','Quantity','Unit cost (EUR)'],['OTHER-2','Widget',4,1]]),
  sheet('Retail',[['SKU','Name','Quantity','Selling price (USD)'],['OTHER-3','Widget',4,1]]),
  sheet('Notes',[['Explanation'],['These rows describe the workbook']])
 ])assert.equal(await tables.combine({sheets:[base,alternative]}),null);
 assert.equal(await tables.combine({sheets:[base]}),null);
});
test('a union exceeding source column capacity is not truncated or silently combined',async()=>{
 const grid=(code,prefix)=>[['SKU','Name','Quantity',...Array.from({length:255},(_,i)=>prefix+i)],[code,'Unfamiliar',1,...Array.from({length:255},()=>42)]];
 assert.equal(await tables.combine({sheets:[sheet('A',grid('CAP-A','Opaque A ')),sheet('B',grid('CAP-B','Opaque B '))]}),null);
});
