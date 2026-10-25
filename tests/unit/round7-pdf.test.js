'use strict';const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('logical Unicode PDF glyph streams are reconciled without reversing other producers',async()=>{
 const parsed=await require('../../src/imports/pdf-table').parse(fs.readFileSync(path.join(__dirname,'../fixtures/rtl-logical-table.pdf'))),sheet=parsed.sheets[0];
 assert.deepEqual(sheet.columns.map(c=>c.name),['SKU','שם מוצר','כמות','מחיר']);
 assert.equal(sheet.rows[0].cells[1],'מחברת ירוקה');assert.equal(sheet.rows[1].cells[1],'מחברת כחולה');
 assert(sheet.rows.some(r=>r.cells.includes('מע״מ 17%')));assert(sheet.rows.some(r=>r.cells.includes('סה״כ יחידות')));
 const roles=require('../../src/imports/document-rows').classify(sheet,{code:0,name:1,quantity:2,sellingPrice:3});
 assert.equal(roles.get(sheet.rows[2].sourceRow)?.kind,'total');assert.equal(roles.get(sheet.rows[3].sourceRow)?.kind,'charge');assert.equal(roles.get(sheet.rows[4].sourceRow)?.kind,'total');assert.equal(roles.productCount,2);
});
test('distant document totals remain available as evidence rather than disappearing',()=>{
 const rows=[{y:740,cells:[{text:'SKU'},{text:'Quantity'}]},{y:700,cells:[{text:'A'},{text:'3'}]},{y:400,cells:[{text:'סה״כ יחידות'}]}];
 assert.equal(require('../../src/imports/pdf-table').withoutSeparatedFooter(rows).length,3);
});
