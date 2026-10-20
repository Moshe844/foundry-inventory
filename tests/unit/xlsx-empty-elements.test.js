'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const reader=require('../../src/imports/xlsx-reader');

function workbook(sheet,strings){
  // Independent ZIP writer; explicit OOXML covers legal blank encodings that
  // writers omitting blank cells would never exercise.
  const {CFB}=require('xlsx'),zip=CFB.utils.cfb_new();
  for(const [name,xml]of Object.entries({
    'xl/workbook.xml':'<workbook><sheets><sheet name="Positions" sheetId="1"/></sheets></workbook>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+sheet+'</sheetData></worksheet>',
    ...(strings?{'xl/sharedStrings.xml':'<sst>'+strings+'</sst>'}:{}),
  }))CFB.utils.cfb_add(zip,name,Buffer.from(xml));
  return Buffer.from(CFB.write(zip,{type:'buffer',fileType:'zip'}));
}

test('empty cells and rows never borrow values from the following element',()=>{
  const xml='<row r="1"><c r="A1"/><c r="B1" t="inlineStr"/><c r="C1" t="inlineStr"><is><t/></is></c><c r="D1"><v>0</v></c><c r="E1" t="inlineStr"><is><t>Next value</t></is></c></row>'+
    '<row r="2"/><row r="3"><c r="C3" t="inlineStr"><is><t>Last value</t></is></c></row>';
  assert.deepEqual(reader.readWorkbook(workbook(xml)).sheets[0].rows,[['','','','0','Next value'],[],['','','Last value']]);
});

test('self-closing shared strings preserve all subsequent indexes and rich text',()=>{
  const strings='<si/><si><t/></si><si><r><t/></r><r><t xml:space="preserve">A &amp; B</t></r></si>';
  const xml='<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>';
  assert.deepEqual(reader.readWorkbook(workbook(xml,strings)).sheets[0].rows,[['','','A & B']]);
});
