'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const helpers=require('../../src/web/view-helpers');

test('Ask and report rows present governed fields as human-readable labels',()=>{
  assert.equal(helpers.columnLabel('book_cost_change_minor'),'Book cost change');
  assert.equal(helpers.columnLabel('source_kind'),'Source');
  assert.equal(helpers.columnLabel('quantity_delta'),'Quantity change');
  assert.equal(helpers.columnLabel('recorded_on'),'Recorded on');
  assert.equal(helpers.columnLabel('sku'),'SKU');
  assert.equal(helpers.columnLabel('pricing_complete'),'Pricing complete');
  assert.equal(helpers.columnLabel('onHand'),'On hand');
});

test('Ask formats measured quantities without rewriting numeric business names',()=>{
  const supplier='Parts 12345';
  assert.equal(helpers.figures(`Order 12000 units from ${supplier}.`,[supplier]),
    `Order 12,000 units from ${supplier}.`);
  assert.equal(helpers.figures('Supplier 12345 has 10000 units.', ['Supplier 12345']),
    'Supplier 12345 has 10,000 units.');
  assert.equal(helpers.figures('Use 0012345 for 12000 units.',['0012345']),
    'Use 0012345 for 12,000 units.');
});
