'use strict';const test=require('node:test'),assert=require('node:assert/strict'),parser=require('../../src/imports/parser'),XLSX=require('xlsx');
test('JSON product objects and ODS tables retain columns without evaluating instructions',()=>{
 const records=[{SKU:'V-8',Name:'Variable 8',Quantity:3,Price:0},{SKU:'V-9',Name:'Variable 9',Quantity:7,Price:9.99}];const result=parser.parse({buffer:Buffer.from(JSON.stringify({products:records})),filename:'unfamiliar.json'});assert.equal(result.sheets[0].rows.length,2);assert.deepEqual(result.sheets[0].rows[0].cells,['V-8','Variable 8','3','0']);
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(records),'Items');const ods=parser.parse({buffer:XLSX.write(book,{bookType:'ods',type:'buffer'}),filename:'unfamiliar.ods'});assert.equal(ods.sheets[0].rows.length,2);assert(ods.sheets[0].rows[1].cells.includes('V-9'));
 const xml=parser.parse({text:'<products><product id="7"><sku>X</sku><unit_cost>1.5</unit_cost></product><product id="8"><sku>Y</sku><unit_cost>2</unit_cost></product></products>',filename:'products.xml'});assert.deepEqual(xml.sheets[0].columns.map(c=>c.name),['id','sku','unit cost']);assert.deepEqual(xml.sheets[0].rows[1].cells,['8','Y','2']);
 // Declared entities are dropped, never expanded or fetched.
 const entity=parser.parse({text:'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><products><product><sku>A</sku><name>&e;</name></product><product><sku>B</sku><name>Tray</name></product></products>',filename:'products.xml'});assert.equal(entity.sheets[0].rows[0].cells[1],'&e;');
 assert.throws(()=>parser.parse({text:'{"products":[{"SKU":"A","nested":{"secret":"not silently ignored"}}]}',filename:'nested.json'}),/nested records/);
});
test('invalid photo bytes receive actionable messages before raw text parsing',()=>{for(const ext of ['heic','tiff'])assert.throws(()=>parser.parse({buffer:Buffer.from('not a spreadsheet'),filename:'photo.'+ext}),/could not be opened as a readable image/);});

test('Word table cells remain columns and escaped text is retained',()=>{
 const zip=XLSX.CFB.utils.cfb_new();XLSX.CFB.utils.cfb_add(zip,'word/document.xml',Buffer.from('<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:t>SKU</w:t></w:p></w:tc><w:tc><w:p><w:t>Name</w:t></w:p></w:tc><w:tc><w:p><w:t>Qty</w:t></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:t>WORD-9</w:t></w:p></w:tc><w:tc><w:p><w:t>Nut &amp; bolt</w:t></w:p></w:tc><w:tc><w:p><w:t>6</w:t></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'));
 const result=parser.parse({buffer:Buffer.from(XLSX.CFB.write(zip,{type:'buffer',fileType:'zip'})),filename:'unfamiliar.docx'});assert.deepEqual(result.sheets[0].rows[0].cells,['WORD-9','Nut & bolt','6']);
});
