'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pdfTable=require('../../src/imports/pdf-table');
const {scannedTablePdf}=require('../helpers/scanned-table-pdf');

test('text-layer PDF inventory table preserves columns, rows and quantities',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../fixtures/ask-import-stock.pdf'));
  const parsed=await pdfTable.parse(source);
  assert.equal(parsed.format,'pdf');
  assert.deepEqual(parsed.sheets[0].columns.map((column)=>column.name),
    ['Stock code','Item description','Qty available','Site']);
  assert.deepEqual(parsed.sheets[0].rows.map((row)=>row.cells),[
    ['LAB-PT-012','PTFE Tape 12 m','24','Lab Main Warehouse'],
    ['LAB-BN-015','Brass Compression Nut','36','Lab Main Warehouse'],
    ['LAB-PC-022','Pipe Cutter 22 mm','7','Lab Overflow Shelf'],
  ]);
});

test('a mislabeled non-PDF is not interpreted as inventory',async()=>{
  await assert.rejects(pdfTable.parse(Buffer.from('not a PDF')),/not a readable PDF/i);
});

test('image-only PDF inventory reaches a real OCR table preview', {timeout:120000},async()=>{
  const parsed=await pdfTable.parse(await scannedTablePdf());
  assert.equal(parsed.format,'pdf');
  assert.deepEqual(parsed.sheets[0].columns.map((column)=>column.name),['Product','SKU','Quantity']);
  assert.equal(parsed.sheets[0].rows.length,2);
  assert.match(parsed.sheets[0].rows[0].cells.join(' '),/Desk Lamp.*LAMP-10.*3/);
  assert.match(parsed.sheets[0].rows[1].cells.join(' '),/Wall Light.*LIGHT-20.*4/);
});

test('selectable title above an image-only table still triggers OCR', {timeout:120000},async()=>{
  const parsed=await pdfTable.parse(await scannedTablePdf({selectableTitle:true}));
  assert.equal(parsed.sheets[0].rows.length,2);
  assert.match(parsed.sheets[0].rows[0].cells.join(' '),/Desk Lamp.*LAMP-10.*3/);
});
