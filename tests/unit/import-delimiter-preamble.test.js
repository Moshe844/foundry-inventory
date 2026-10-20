'use strict';const test=require('node:test'),assert=require('node:assert/strict'),parser=require('../../src/imports/parser');
test('unknown delimiters survive arbitrary title rows, quoted separators and multiline descriptions',()=>{
 for(const delimiter of [';',',','\t','|']){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',header=['SKU','Description','Quantity','Location','Unit Cost','Currency','Selling Price'],rows=[['TXT-A',quote('Glass, large; blue|clear\nSecond description line'),'4','Room α','1.25','USD','0'],['TXT-B',quote('Box "small"'),'0','Room β','2.00','USD','7.50']];
  const text='\uFEFFUnknown stocktake report\nExported from an unfamiliar system\n\n'+[header,...rows].map(row=>row.join(delimiter)).join('\n'),sheet=parser.parse({text,filename:'unfamiliar.txt'}).sheets[0];assert.deepEqual(sheet.columns.map(c=>c.name),header);assert.equal(sheet.rows.length,2);assert.equal(sheet.rows[0].cells[1],'Glass, large; blue|clear\nSecond description line');assert.equal(sheet.rows[0].cells[6],'0');assert.equal(sheet.rows[1].cells[2],'0');assert.equal(sheet.preamble.length,3);
 }
});
test('headerless and ordinary delimited sources keep their first record and escaped literal quote',()=>{
 const flat=parser.parse({text:'A-1,Widget,2,Depot\nA-2,"Widget, \"\"large\"\"",3,Depot'}).sheets[0];assert.equal(flat.rows.length,2);assert.equal(flat.rows[0].cells[0],'A-1');assert.equal(flat.rows[1].cells[1],'Widget, "large"');
 assert.equal(parser.detectDelimiter('Only a note without table data'),',');
});
