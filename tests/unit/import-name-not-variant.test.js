'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { proposeMappings } = require('../../src/imports/mapping-service');
const { parse } = require('../../src/imports/parser');

test('a column of distinct product names stays the name when the model files it as a variant', async () => {
  const csv = 'Code,Item,Stock,Sell\n' + ['8', '9', '10', '11'].map((size) => `AM90-${size},Air Max 90 Black ${size},${size},129.99`).join('\n');
  const parsed = parse({ text: csv });
  const sheet = parsed.sheets[parsed.primarySheet];
  const provider = { complete: async () => ({ data: { detectedType: 'variant_inventory', note: '',
    columns: [{ index: 1, field: 'variant1', axisName: 'size' }, { index: 2, field: 'quantity', axisName: '' }, { index: 3, field: 'sellingPrice', axisName: '' }] } }) };
  const result = await proposeMappings({ ...sheet, sourceName: 'old-excel.csv' }, { provider });
  assert.equal(result.mappings.name, 1);
  assert.equal(result.mappings.variant1, undefined);
  assert.equal(result.mappings.code, 0);
  assert.equal(result.mappings.quantity, 2);
});

test('a repeating size column the model files as a variant stays a variant', async () => {
  const csv = 'Code,Item,Size,Stock\n' + ['8', '9', '10', '11'].map((size) => `AM90-${size},Air Max 90,${size},3`).join('\n');
  const parsed = parse({ text: csv });
  const sheet = parsed.sheets[parsed.primarySheet];
  const provider = { complete: async () => ({ data: { detectedType: 'variant_inventory', note: '',
    columns: [{ index: 2, field: 'variant1', axisName: 'Size' }] } }) };
  const result = await proposeMappings({ ...sheet, sourceName: 'sizes.csv' }, { provider });
  assert.equal(result.mappings.name, 1);
  assert.equal(result.mappings.variant1, 2);
});
