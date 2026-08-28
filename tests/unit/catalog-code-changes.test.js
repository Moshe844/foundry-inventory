'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const changes = require('../../src/manager/catalog-code-changes');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('bulk code language becomes a general prefix operation', () => {
  assert.deepEqual(changes.parseInstruction(
    'Can you replace the first two letters of the code for each item from TS to ME'
  ), { mode: 'prefix', from: 'TS', to: 'ME' });
  assert.deepEqual(changes.parseInstruction(
    'Change prefix AB- to ZX- across all SKU codes'
  ), { mode: 'prefix', from: 'AB-', to: 'ZX-' });
  assert.equal(changes.parseInstruction('Change the supplier code from TS to ME'), null,
    'supplier identifiers use the separate supplier mapping capability');
});

test('the preview is catalogue-driven and rejects collisions', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  makeQuantityItem(db, workspace.ctx, { name: 'First', baseCode: 'TS-100' });
  makeQuantityItem(db, workspace.ctx, { name: 'Second', baseCode: 'TS-200' });
  makeQuantityItem(db, workspace.ctx, { name: 'Existing target', baseCode: 'ME-100' });

  assert.throws(() => changes.snapshotFor(db, workspace.workspaceId,
    { mode: 'prefix', from: 'TS', to: 'ME' }), /already used|already exists/i);
});
