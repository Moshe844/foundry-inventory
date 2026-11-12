'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const source=require('../../src/purchasing/supplier-price-list-source');

test('reads the exact worksheet, PDF page, supplier code, price and currency from real originals',async()=>{
  const XLSX=require('xlsx'),workbook=XLSX.utils.book_new();
  const header=['Supplier SKU','Case price (JPY)','Pack size'];
  for(const [name,sku,amount] of [['Northern','P-123','760'],['Southern','P-124','900']]){
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([header,[sku,amount,'6']]),name);
  }
  const rows=await source.read({filename:'regional-prices.xlsx',buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})});
  assert.deepEqual(rows.map(r=>[r.sheet,r.rowNumber,r.code,r.amount,r.currency,r.unit,r.pack]),[
    ['Northern',2,'P-123','760','JPY','case','6'],['Southern',2,'P-124','900','JPY','case','6']
  ]);
  const PDF=require('pdfkit'),pdf=new PDF({margin:36}),buffers=[];
  pdf.on('data',chunk=>buffers.push(chunk));
  const complete=new Promise(resolve=>pdf.on('end',resolve));
  for(const [page,sku,amount] of [[1,'P-123','760'],[2,'P-124','900']]){
    if(page===2)pdf.addPage();
    for(const [y,values] of [[90,header],[115,[sku,amount,'6']]]){
      values.forEach((value,index)=>pdf.fontSize(11).text(value,35+160*index,y,{lineBreak:false}));
    }
  }
  pdf.end();
  await complete;
  const pages=await source.read({filename:'regional-prices.pdf',buffer:Buffer.concat(buffers)});
  assert.deepEqual(pages.map(r=>[r.sheet,r.code,r.amount,r.currency,r.pack]),[
    ['Page 1','P-123','760','JPY','6'],['Page 2','P-124','900','JPY','6']
  ]);
  const product={purchase_unit:'case',units_per_purchase_unit:6,unit_label:'piece'};
  assert.deepEqual(source.comparable(pages[0],product),{currency:'JPY',amountMinor:760,pricingQuantity:6,unit:'piece'});
  assert.throws(()=>source.comparable({...pages[0],amount:'760.01'},product),/exact|currency|decimal|fraction/i);
  assert.throws(()=>source.comparable(pages[0],{...product,secondary_unit_label:'kg'}),/independent measured/);
  assert.deepEqual(source.comparable({...pages[0],unit:'kg',quantity:'0.25',pack:''},{...product,secondary_unit_label:'kg'}),
    {currency:'JPY',amountMinor:760,pricingQuantity:0.25,unit:'kg'});
});
