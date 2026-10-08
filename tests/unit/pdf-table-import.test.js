'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const pdfTable=require('../../src/imports/pdf-table');

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
