'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {compare}=require('../../src/purchasing/delivery-comparison');
const line={id:'line-1',code:'ITEM-1',supplier_sku:'SUPPLIER-1',name:'Ordered item',unit_label:'piece',quantity_precision:0,
  quantity_increment:'1',secondary_precision:3,secondary_increment:'0.001',secondary_unit_label:null,tracking_mode:'quantity',
  quantity_units:'12',quantity_received_units:'0',units_per_purchase_unit:'6',purchase_unit:'case'};

test('delivery comparison converts exact supplier packs and reports shortages, extras and wrong codes independently',()=>{
  const short=compare([line],[{code:'SUPPLIER-1',quantity:'1',basis:'purchase'}]);
  assert.equal(short.rows[0].observed,'6');
  assert.equal(short.rows[0].short,6);
  const extra=compare([line],[{code:'ITEM-1',quantity:'14'}]);
  assert.equal(extra.rows[0].extra,2);
  const wrong=compare([line],[{code:'WRONG-ITEM',quantity:'3',unit:'carton',lineId:line.id}]);
  assert.equal(wrong.unexpected[0].code,'WRONG-ITEM');
  assert.equal(wrong.unexpected[0].quantity,'3');
  assert.equal(wrong.rows[0].observed,'0');
  assert.equal(wrong.rows[0].short,12);
  assert.equal(wrong.agrees,false);
});

test('decimal and independent-weight deliveries retain exact quantities and missing actual measurements',()=>{
  const fractional={...line,unit_label:'m',quantity_precision:3,quantity_increment:'0.001',quantity_units:'1.25',quantity_received_units:'0.25'};
  const actual=compare([fractional],[{code:line.code,quantity:'0.3'},{code:line.code,quantity:'0.7'}]);
  assert.equal(actual.rows[0].observed,'1');
  assert.equal(actual.agrees,true);
  const weighted={...line,secondary_unit_label:'kg',quantity_units:'2',quantity_received_units:'0',secondary_quantity_ordered:'2.35',secondary_quantity_received:'0'};
  assert.equal(compare([weighted],[{code:line.code,quantity:'2',secondaryQuantity:'2.35'}]).agrees,true);
  const missing=compare([weighted],[{code:line.code,quantity:'2'}]);
  assert.equal(missing.rows[0].observedWeight,null);
  assert.match(missing.rows[0].findings.join(' '),/Actual kg is missing/);
  assert.equal(compare([weighted],[{code:line.code,quantity:'2',secondaryQuantity:'2.30'}]).agrees,false);
});

test('duplicate product lines need an exact line choice and saved pack or unit mismatches never choose silently',()=>{
  const duplicate={...line,id:'line-2'};
  assert.equal(compare([line,duplicate],[{code:line.code,quantity:'12'}]).unexpected.length,1);
  const precise=compare([line,duplicate],[{lineId:line.id,code:line.code,quantity:'12'},
    {lineId:duplicate.id,code:line.code,quantity:'12'}]);
  assert.equal(precise.agrees,true);
  assert.throws(()=>compare([line],[{code:line.code,quantity:'1.5'}]),/whole number/);
  assert.throws(()=>compare([line],[{code:line.code,quantity:'1',unit:'kg'}]),/stated unit/);
  const alreadyOver={...line,quantity_received_units:'14'};
  assert.equal(compare([alreadyOver],[{code:line.code,quantity:'0'}]).agrees,true);
});
