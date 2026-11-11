'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const source=require('../../src/imports/exact-variant-source');
const xlsx=require('xlsx');
function workbook(type,sheets){
  const book=xlsx.utils.book_new();
  for(const [name,rows] of Object.entries(sheets))xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet(rows),name);
  return xlsx.write(book,{type:'buffer',bookType:type});
}

test('reads every workbook variant sheet and links exact product references to a separate product table',()=>{
  const rows={
    Products:[['Product Code','Product Name'],['STYLE-01','Exact Shirt']],
    Colors:[['Parent SKU','Variant SKU','Color','Size','Barcode'],['STYLE-01','000543','Red','S','000099123']],
    Sizes:[['Product Code','Variant SKU','Colour','Size'],['STYLE-01','EXACT-Blue-2','Blue','M']]
  };
  for(const type of ['xlsx','xls','xlsb','ods']){
    const read=source.read('Variant sample.'+type,workbook(type,rows));
    assert.equal(read.sheets.length,3,type);assert.deepEqual(read.issues,[],type);
    assert.deepEqual(read.candidates.map(r=>[r.name,r.sku,r.barcode,r.options.map(a=>a.value)]),[
      ['Exact Shirt','000543','000099123',['Red','S']],['Exact Shirt','EXACT-Blue-2','',['Blue','M']]
    ],type);
    assert(read.candidates.every(r=>r.row===2),type);
  }
});

test('Shopify paired options keep source names, family, exact barcode and blank-title continuation',()=>{
  const read=source.read('ecommerce.csv',Buffer.from(
    'Handle,Title,Variant SKU,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Variant Barcode\n'+
    'gloves,Work gloves,GL-RS,Colour,Red,Size,S,00001\n'+
    'gloves,,GL-BM,Colour,Blue,Size,M,00002'));
  assert.deepEqual(read.issues,[]);
  assert.deepEqual(read.candidates.map(p=>[p.parent,p.name,p.sku,p.barcode]),[
    ['gloves','Work gloves','GL-RS','00001'],['gloves','Work gloves','GL-BM','00002']
  ]);
});

test('wide layout requires exact cells, while ambiguous tabs and missing SKU rows stay in review',()=>{
  const read=source.read('matrix.tsv',Buffer.from('Product Code\tProduct Name\tColor\tSize: S SKU\tSize: M SKU\tSize: L SKU\n'+
    'WIDE\tWide product\tGreen\tWIDE-S\t\t000345'));
  assert.deepEqual(read.issues,[]);
  assert.deepEqual(read.candidates.map(r=>[r.sku,r.options[1].value]),[['WIDE-S','S'],['000345','L']]);
  const bad=source.read('Original.csv',Buffer.from('Product Name,SKU,Size,Color\nOriginal,,M,Green'));
  assert.match(bad.candidates[0].errors.join(' '),/exact SKU from the source/);
  const data=workbook('xlsx',{Variants:[['Item','Identifier','Finish'],['New item','N1','Polished']],Notes:[['Something else','Contents'],['Notes','See original']]});
  assert.equal(source.read('Original.xlsx',data).issues.length,3);
  const revised=source.read('Original.xlsx',data,{
    0:{mode:'variants',name:0,sku:1,axes:[{index:2,label:'Finish'}]},1:{mode:'skip'}
  });
  assert.deepEqual(revised.issues,[]);assert.equal(revised.candidates[0].sku,'N1');
});

test('current commerce headers preserve variant rows and count source image and default product details',()=>{
  const csv=Buffer.from('URL handle,Title,SKU,Option1 name,Option1 value,Barcodes,Product image URL\n'+
    'blue-shirt,Blue shirt,EXACT-001,Size,Small,000104,https://images.example.test/one.png\n'+
    'blue-shirt,,,,,,https://images.example.test/two.png\n'+
    'blue-shirt,,EXACT-002,Size,Large,000105,\n'+
    'solid,Simple item,EXACT-PLAIN,Title,Default Title,000108,');
  const data=source.read('Export.csv',csv);
  assert.deepEqual(data.issues,[]);
  assert.equal(data.sheets[0].auxiliaryRows,2);
  assert.deepEqual(data.candidates.map(row=>[row.parent,row.name,row.sku,row.barcode]),[
    ['blue-shirt','Blue shirt','EXACT-001','000104'],['blue-shirt','Blue shirt','EXACT-002','000105']
  ]);
});
