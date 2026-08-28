'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const scopeSafety = require('../../src/imports/scope-safety');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

test('a file with no catalogue overlap is stopped using real records, not industry vocabulary', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Current operation' });
  makeQuantityItem(db, workspace.ctx, { name: 'Classic Cotton T-Shirt', baseCode: 'TS-BLK' });

  const result = scopeSafety.evaluate(db, workspace.workspaceId, [
    { name: 'Kids Loafer - Black', code: 'SH-101-BLK' },
    { name: 'Boys Dress Oxford - Brown', code: 'SH-204-BRN' },
  ]);

  assert.equal(result.needsConfirmation, true);
  assert.equal(result.workspaceName, 'Current operation');
  assert.deepEqual(result.currentExamples, ['Classic Cotton T-Shirt']);
  assert.equal(result.matches, 0);
});

test('a matching name or identifier continues without an unnecessary warning', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  makeQuantityItem(db, workspace.ctx, { name: 'Classic Cotton T-Shirt', baseCode: 'TS-BLK' });

  assert.equal(scopeSafety.evaluate(db, workspace.workspaceId,
    [{ name: 'Classic Cotton T-Shirt - Black', code: '' }]).needsConfirmation, false);
  assert.equal(scopeSafety.evaluate(db, workspace.workspaceId,
    [{ name: 'Something renamed by the supplier', code: 'TS-BLK' }]).needsConfirmation, false);
});

test('the first file in an empty inventory does not ask which inventory it belongs in', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  assert.equal(scopeSafety.evaluate(db, workspace.workspaceId,
    [{ name: 'Any new product', code: 'NEW-1' }]).needsConfirmation, false);
});
