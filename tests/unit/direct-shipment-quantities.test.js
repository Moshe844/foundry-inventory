'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const direct=require('../../src/purchasing/direct-shipment-quantities');

const ordinary={code:'DIRECT',unit_label:'unit',tracking_mode:'quantity',quantity_precision:0,quantity_increment:1};
const offer={purchase_unit:'box',units_per_purchase_unit:'2',minimum_order_quantity:'1',order_multiple:'1',last_unit_cost:'7.50',currency:'USD'};

test('direct buying covers only unfulfilled, unpromised customer quantities and preserves exact supplier packs',()=>{
  const line={quantity_ordered:'12',quantity_fulfilled:'2',direct_committed_quantity:'4'};
  assert.deepEqual(direct.remaining(line),{quantity:'6',secondary:null});
  assert.deepEqual(direct.claim(line,ordinary,offer,{quantity:'6'}),{
    quantity:6,secondaryQuantity:null,purchaseUnits:'3',unitCostMinor:750,totalMinor:4500});
  assert.throws(()=>direct.claim(line,ordinary,offer,{quantity:'5'}),/packs, minimum or multiple/);
  assert.throws(()=>direct.claim(line,ordinary,offer,{quantity:'8'}),/exceeds the customer quantity/);
});

test('decimal direct orders keep stocking increments and independent measured weights',()=>{
  const fabric={...ordinary,unit_label:'m',quantity_precision:3,quantity_increment:'0.005'};
  const line={quantity_ordered:'3.755',quantity_fulfilled:'0.25',direct_committed_quantity:'1.005'};
  const result=direct.claim(line,fabric,{...offer,purchase_unit:'m',units_per_purchase_unit:'0.5',minimum_order_quantity:'0.5',order_multiple:'0.5'},{quantity:'2.5'});
  assert.equal(result.purchaseUnits,'5');
  assert.equal(result.totalMinor,1875);
  assert.throws(()=>direct.claim(line,fabric,offer,{quantity:'0.001'}),/increments/);
  const meat={...ordinary,secondary_unit_label:'kg',secondary_precision:3,secondary_increment:'0.001'};
  const measured={quantity_ordered:'6',quantity_fulfilled:'1',direct_committed_quantity:'1',
    secondary_quantity_ordered:'12.4',secondary_quantity_fulfilled:'2',direct_committed_secondary_quantity:'2.4'};
  assert.deepEqual(direct.remaining(measured),{quantity:'4',secondary:'8'});
  const full=direct.claim(measured,meat,offer,{quantity:'4'});
  assert.equal(full.secondaryQuantity,8);
  assert.equal(full.totalMinor,6000);
  assert.throws(()=>direct.claim(measured,meat,offer,{quantity:'2'}),/actual kg/);
  assert.throws(()=>direct.claim(measured,meat,offer,{quantity:'2',secondaryQuantity:'8'}),/remaining agreed measures/);
});

test('supplier dispatches retain literal lot and serial evidence with exact piece and weight totals',()=>{
  const serial={...ordinary,tracking_mode:'serial',secondary_unit_label:'kg',secondary_precision:3,secondary_increment:'0.001'};
  const input={quantity:'2',secondaryQuantity:'3.125',serials:[{serial:'SN-A',weight:'1.125'},{serial:'SN-B',weight:'2'}]};
  const result=direct.dispatch(serial,input,{quantity:'2',secondary:'3.125'},'2026-11-10');
  assert.equal(result.serials[0].serial,'SN-A');
  assert.throws(()=>direct.dispatch(serial,{...input,serials:[{serial:'SN-A',weight:1},{serial:'sn-a',weight:2.125}]},
    {quantity:2,secondary:3.125},'2026-11-10'),/appear once/);
  assert.throws(()=>direct.dispatch(serial,{...input,serials:[{serial:'SN-A',weight:1},{serial:'SN-B',weight:2}]},
    {quantity:2,secondary:3.125},'2026-11-10'),/add up/);
  const lot={...ordinary,tracking_mode:'lot'};
  const shipped=direct.dispatch(lot,{quantity:'3',lots:[{lotCode:'LOT-A',quantity:1,expiresAt:'2026-12-01'},
    {lotCode:'LOT-B',quantity:2}]},{quantity:3,secondary:null},'2026-11-10');
  assert.equal(shipped.lots.length,2);
  assert.throws(()=>direct.dispatch(lot,{quantity:1,lots:[{lotCode:'OLD',quantity:1,expiresAt:'2026-11-09'}]},
    {quantity:1,secondary:null},'2026-11-10'),/unexpired/);
});
