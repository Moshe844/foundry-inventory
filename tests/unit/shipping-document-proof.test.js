'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const reader=require('../../src/documents/shipping-document-proof');
const page=(text,n=1,sourceKind='text',extra={})=>({page:n,text,sourceKind,...extra});
test('exact labelled PO references are distinct from free text, carrier identifiers and longer lookalike references',()=>{
  const original=reader.inspect([page('BILL OF LADING\nB/L No: BL-09\nContainer: ABCD1234567\nPurchase order PO-019\nOther note cites PO-01 and PO-0199\nVessel: Example')]);
  assert.equal(original.kind,'bill_of_lading');assert.deepEqual(original.references.map(r=>r.value),['PO-019']);assert.equal(original.issues.length,0);
  assert.deepEqual(original.fields.map(f=>f.kind),['document_number','container','vessel']);
  assert.equal(reader.inspect([page('BILL OF LADING\nContainer: PO-01')]).references.length,0);
});
test('multilingual headings and purchase-order labels support several exact references across complete sections',()=>{
  const original=reader.inspect([page('Déclaration en douane\nRéférence douanière: EU-42\nBon de commande: PO-002'),page('Orden de compra: PO-003, PO-004\nHS code: 1234.56',2)]);
  assert.equal(original.kind,'customs');assert.equal(original.issues.length,0);assert.deepEqual(original.references.map(r=>[r.page,r.value]),[[1,'PO-002'],[2,'PO-003'],[2,'PO-004']]);
  assert.equal(original.fields[1].quote,'HS code: 1234.56');
});
test('a complete reference read from a scan, raster-only region, or tracked deletion remains uncertain',()=>{
  for(const source of [page('Customs declaration\nPurchase order: PO-002',1,'scan'),page('Customs declaration\nPurchase order: PO-002',1,'mixed',{nativeText:'Customs declaration'}),page('Customs declaration\nPurchase order: PO-002\n[Tracked deletion: old record]',1,'word_text')]){
    assert.equal(reader.inspect([source]).references[0].uncertain,true);
  }
  assert.equal(reader.inspect([page('Commercial Invoice\nPurchase order: PO-002')]).unrelated,true);
});

test('an HTML fragment preserves every visible shipping field and never treats script text as purchase-order evidence',()=>{
  const html='<h1>Bill of Lading</h1><p>Purchase order: PO-00001</p><p>Carrier: Exact carrier</p><script>Purchase order: FALSE-PO</script><p hidden>Purchase order: HIDDEN-PO</p><template>Purchase order: TEMPLATE-PO</template>';
  const text=require('../../src/documents/html-source-text').text(html),found=reader.inspect([page(text,1,'html_text')]);
  assert.deepEqual(found.references.map(r=>r.value),['PO-00001']);assert.equal(found.fields[0].value,'Exact carrier');assert(!text.includes('FALSE-PO'));assert(!text.includes('HIDDEN-PO'));assert(!text.includes('TEMPLATE-PO'));
});
