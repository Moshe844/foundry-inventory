'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const proof=require('../../src/documents/document-target-proof');
const source=require('../../src/documents/contract-source');
const section=(text,extra={})=>({page:1,sourceKind:'text',text,...extra});

test('exact original fields preserve multiline quotes and ignore unrelated line-item codes on order documents',()=>{
  const found=proof.inspect([
    section('Packing slip\nSKU: PRODUCT-1\nPurchase order: PO-1, PO-2'),
    section('Customer order:\nSO-77\nSKU: PRODUCT-2',{page:2})
  ]);
  assert.equal(found.documentKind,'packing_slip');
  assert.deepEqual(found.unique.map(x=>[x.targetKind,x.value,x.page]),[
    ['purchase_order','PO-1',1],['purchase_order','PO-2',1],['sales_order','SO-77',2]
  ]);
  assert.equal(found.unique[2].quote,'Customer order:\nSO-77');
  assert(!found.issues.length);
});

test('supplier codes and multilingual exact product fields are distinguishable from incidental numbers',()=>{
  const found=proof.inspect([section('Fiche technique\nBon de commande: PO-98\nSupplier SKU: AA-77\nRéférence produit: AB-9\nWeight 81')]);
  assert.equal(found.documentKind,'specification');
  assert.deepEqual(found.unique.map(x=>x.value),['AA-77','AB-9']);
  assert(found.unique.every(x=>x.targetKind==='item'));
});

test('OCR and annotated references keep original quotes but require review',()=>{
  const found=proof.inspect([section('Safety data sheet\nSKU: OCR-77',{sourceKind:'scan'}),section('Supplier SKU: VENDOR-5',{requiresSourceConfirmation:true})]);
  assert.equal(found.documentKind,'safety_sheet');
  assert(found.unique.every(x=>x.uncertain));
  assert.equal(found.unique[1].quote,'Supplier SKU: VENDOR-5');
});

test('complete real workbook retains every sheet and accepts only exact literal reference cells',async()=>{
  const xlsx=require('xlsx'),book=xlsx.utils.book_new();
  const cover=xlsx.utils.aoa_to_sheet([['Packing slip'],['Purchase order','PO-42'],['Address','62 Example Road']]);
  const appendix=xlsx.utils.aoa_to_sheet([['Customer order','SO-1'],['Customer order','SO-FAKE','Unrelated third cell'],['SKU','B-11']]);
  appendix.B1={t:'s',v:'SO-1',f:'UPPER("so-1")'};
  xlsx.utils.book_append_sheet(book,cover,'Delivery');xlsx.utils.book_append_sheet(book,appendix,'Appendix');
  const buffer=xlsx.write(book,{type:'buffer',bookType:'xlsx'});
  const pages=await source.read({filename:'Original.xlsx',buffer,filingOriginal:true});
  assert.deepEqual(pages.map(p=>p.sourceName),['Delivery','Appendix']);
  assert.match(pages[1].text,/SO-1 \[Formula:/);
  assert.match(pages[1].text,/SO-FAKE/);
  assert.equal(pages[1].requiresSourceConfirmation,true);
  assert.deepEqual(proof.inspect(pages).unique.map(x=>x.value),['PO-42']);
});

test('short literal UTF-8 documents remain readable and unsupported originals are held',async()=>{
  const pages=await source.read({filename:'SKU.txt',buffer:Buffer.from('SKU: A-1'),filingOriginal:true});
  assert.equal(proof.inspect(pages).unique[0].value,'A-1');
  await assert.rejects(source.read({filename:'Original.bin',buffer:Buffer.from('binary source bytes'),filingOriginal:true}),e=>e.code==='validation_error');
});
