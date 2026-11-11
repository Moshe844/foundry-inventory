'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {project}=require('../../src/purchasing/po-amendment-terms');

function line(overrides={}){
  return {unit_label:'pieces',quantity_precision:0,quantity_increment:1,quantity_units:'12',
    quantity_received_units:'0',quantity_purchase_units:'2',units_per_purchase_unit:'6',
    unit_cost:'3.00',secondary_quantity_received:'0',...overrides};
}

test('projected supplier changes retain the existing pack and exact money on an unreceived line',()=>{
  const change=project(line(),{quantity:'18',price:'3.25'},'USD');
  assert.deepEqual(change.before,{quantity:'12',secondary:null,price:300,packs:'2',totalMinor:3600});
  assert.deepEqual(change.retained,{quantity:'18',secondary:null,price:325,packs:'3',totalMinor:5850});
  assert.equal(change.replacement,null);
  assert.equal(project(line(),{quantity:'12.0',price:'3.00'},'USD').changed,false);
  assert.throws(()=>project(line(),{price:'3.255'},'USD'),/smaller than the currency supports/);
});

test('the revised remainder price never replaces the terms for received goods',()=>{
  const prior=line({quantity_received_units:'6'});
  const change=project(prior,{quantity:'12',price:'3.25'},'USD');
  assert.deepEqual(change.retained,{quantity:'6',secondary:null,price:300,packs:'1',totalMinor:1800});
  assert.deepEqual(change.replacement,{quantity:'12',secondary:null,price:325,packs:'2',totalMinor:3900});
  const closed=project(prior,{quantity:'0'},'USD');
  assert.equal(closed.retained.quantity,'6');
  assert.equal(closed.replacement,null);
  assert.throws(()=>project(line({quantity_received_units:'5'}),{price:'3.25'},'USD'),/cannot be represented exactly/);
});

test('measured stock preserves the received weight and prices the revised remaining weight independently',()=>{
  const prior=line({units_per_purchase_unit:1,quantity_purchase_units:'12',quantity_received_units:'4',
    secondary_unit_label:'kg',secondary_quantity_ordered:'17.5',secondary_quantity_received:'5.125'});
  assert.throws(()=>project(prior,{quantity:'9'},'USD'),/remaining weight as well/);
  const change=project(prior,{quantity:'9',secondary:'12.625',price:'4.50'},'USD');
  assert.deepEqual(change.retained,{quantity:'4',secondary:'5.125',price:300,packs:'4',totalMinor:1538});
  assert.deepEqual(change.replacement,{quantity:'9',secondary:'12.625',price:450,packs:'9',totalMinor:5681});
  assert.throws(()=>project(prior,{quantity:'0',secondary:'1'},'USD'),/must both be positive or both be zero/);
});

test('fractional products retain the exact inventory increment and purchase-pack conversion',()=>{
  const prior=line({unit_label:'metres',quantity_precision:3,quantity_increment:'0.125',
    quantity_units:'4.5',quantity_purchase_units:'2',units_per_purchase_unit:'2.25'});
  assert.throws(()=>project(prior,{quantity:'4.55'},'USD'),/increments/);
  const change=project(prior,{quantity:'6.75',price:'2.45'},'USD');
  assert.deepEqual(change.retained,{quantity:'6.75',secondary:null,price:245,packs:'3',totalMinor:1654});
});
