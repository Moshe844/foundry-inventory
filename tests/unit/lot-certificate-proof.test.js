'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const proof=require('../../src/documents/lot-certificate-proof');
const lots=[{id:'native-lot-1',sku_id:'sku-1',sku:'SYN-01',supplier_sku:'SUP-0001',code:'LOT-003'},
  {id:'native-lot-2',sku_id:'sku-2',sku:'SYN-02',supplier_sku:'SUP-0002',code:'LOT-003'}];
const page=(text,n=1,sourceKind='text')=>({text,page:n,sourceKind});
const original='Certificat d’analyse\nSKU: SUP-0001\nNuméro de lot: LOT-003\nDate d’expiration: 31/12/2027';
test('certificate proof preserves original multilingual evidence, exact supplier aliases, and page-level expiry evidence',()=>{
  const result=proof.parse([page(original.split('\n').slice(0,3).join('\n')),page('Date d’expiration: 31/12/2027',2)],lots);
  assert.equal(result.links.length,1);const row=result.links[0];assert.equal(row.lotId,'native-lot-1');assert.equal(row.expiresOn,'2027-12-31');assert.equal(row.expiryPage,2);assert.equal(row.skuQuote,'SKU: SUP-0001');assert.equal(row.expiryQuote,'Date d’expiration: 31/12/2027');
});
test('ambiguous dates, changed identifiers, conflicting sections, and scanned evidence remain held',()=>{
  for(const pages of [[page(original.replace('31/12','01/02'))],[page(original.replace('LOT-003','LOT-0034'))],[page(original),page('Date d’expiration: 01/01/2028',2)],[page(original,1,'scan')],[page(original+'\n[Tracked deletion: SKU: SYN-02]')]]){
    const result=proof.parse(pages,lots);assert.equal(result.links.length,0);assert(result.reason);
  }
});

test('a complete original two-page certificate PDF retains the title, lot, product and expiry evidence',async()=>{
  const PDF=require('pdfkit'),doc=new PDF({margin:40}),chunks=[];doc.on('data',part=>chunks.push(part));
  const finished=new Promise(resolve=>doc.on('end',resolve));doc.fontSize(12).text('Certificate of Analysis\nSKU: SYN-01\nLot: LOT-003');
  doc.addPage().text('Test result: recorded material.\nExpiry date: 2027-12-31');doc.end();await finished;
  const pages=await require('../../src/documents/contract-source').read({filename:'Synthetic CoA.pdf',buffer:Buffer.concat(chunks)});
  assert.equal(pages.length,2);const result=proof.parse(pages,lots);assert.equal(result.links.length,1,JSON.stringify(result));assert.equal(result.links[0].expiryPage,2);
});
