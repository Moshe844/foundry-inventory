'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),XLSX=require('xlsx'),{parse}=require('../../src/imports/parser'),{infer}=require('../../src/imports/workbook-evidence');
function source({reordered=false,bad=false,sparse=false,duplicate=false}={}){
 const stock=[['SKU','On hand','Counter','Upper shelf','Reserved','Available','Incoming','Inventory value'],['CX-71',9,3,6,1,8,2,117],['BR-26',5,0,bad?4:5,2,3,0,25]],catalogue=[['SKU','Product name','Unit cost','Sell price','Reorder point','Serial tracked'],['CX-71','Copper component',13,21,0,'No'],['BR-26','Brass part',5,9,3,'No']];
 if(duplicate)catalogue.push([...catalogue[1]]);if(sparse)catalogue.pop();
 const parts=[['Current positions',stock],['Component definitions',catalogue],['Earlier activity',[['Document ID','SKU','Quantity'],['P-51','CX-71',999]]],['Sparse identifier evidence',[['SKU','Lot ID'],['CX-71','LOT-X']]]];
 const book=XLSX.utils.book_new();for(let[name,rows]of reordered?parts.toReversed():parts){if(reordered){name='Unfamiliar '+name.length;const width=rows[0].length;rows=rows.map(r=>Array.from({length:width},(_,i)=>r[width-i-1]));rows=[rows[0],...rows.slice(1).toReversed()];}XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(rows),name);}return parse({buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})});
}
function canonical(result){return result.sheet.rows.map(row=>({sku:row.cells[result.mappings.code],name:row.cells[result.mappings.name],quantity:Number(row.cells[result.mappings.quantity]),location:row.cells[result.mappings.location],cost:row.cells[result.mappings.unitCost],price:row.cells[result.mappings.sellingPrice],reorder:row.cells[result.mappings.reorderPoint]})).sort((a,b)=>(a.sku+a.location).localeCompare(b.sku+b.location));}
test('complete unique source evidence reuses the existing contract and reconciles all physical components independent of labels, column order and row order',()=>{
 const a=infer(source()),b=infer(source({reordered:true}));assert(a);assert(b);assert.equal(a.aiUsed,false);assert.equal(a.outputRows,4);assert.equal(a.physicalUnits,14);assert.deepEqual(canonical(a),canonical(b));assert.equal(a.contract.joins.length,1,'Sparse lot evidence and historical quantities cannot become required stock joins');assert.equal(a.coverage.filter(c=>c.role==='not_imported').length,2);assert(canonical(a).some(r=>r.reorder==='0'&&r.price==='21'));assert(!canonical(a).some(r=>r.quantity===999));
});
test('missing keys, duplicate target keys and a physical reconciliation mismatch defer to review instead of multiplying or dropping records',()=>{
 for(const options of [{sparse:true},{duplicate:true},{bad:true}])assert.equal(infer(source(options)),null,JSON.stringify(options));
});
test('configuration dimensions come from explicit source declarations, beyond the three familiar axes',()=>{
 const book=XLSX.utils.book_new();for(const[name,grid]of [['Counts',[['SKU','On hand','Location','Product ID'],['BOLT-A',2,'Depot','P-A'],['BOLT-B',3,'Depot','P-A']]],['Definitions',[['SKU','Product ID','Product name','Color','Size','Material','Surface treatment','Thread direction'],['BOLT-A','P-A','Bolt','Silver','M8','Steel','Galvanised','Right'],['BOLT-B','P-A','Bolt','Silver','M8','Steel','Plain','Left']]],['Families',[['Product ID','Configuration dimensions'],['P-A','Surface treatment / Thread direction / Size / Color / Material']]]])XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(grid),name);
 const result=infer(parse({buffer:XLSX.write(book,{type:'buffer',bookType:'xlsx'})}));assert(result);assert.equal(result.variantColumns.length,5);assert(result.variantColumns.some(v=>v.name==='Thread direction'));assert(result.variantColumns.some(v=>v.name==='Surface treatment'));assert.equal(result.physicalUnits,5);
});
test('zero-only unexplained numeric columns cannot become warehouses through a coincidental total',()=>{
 const parsed=source(),stock=parsed.sheets.find(s=>s.name==='Current positions');stock.columns.push({index:stock.columns.length,name:'Unspecified amount'});for(const row of stock.rows)row.cells.push('0');assert.equal(infer(parsed),null);
});
