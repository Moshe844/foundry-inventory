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
