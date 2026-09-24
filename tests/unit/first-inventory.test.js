'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const auth = require('../../src/domain/auth-service');
const workspaces = require('../../src/domain/workspace-service');
const deletion = require('../../src/domain/workspace-deletion');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

test('first inventory bootstrap is repeat-safe and never grants automatic operating authority', () => {
  const { db } = makeDatabase();
  const account = auth.createAccount(db, { name: 'Legacy Owner', email: 'legacy@example.test', password: 'password123' });
  const first = workspaces.ensureFirstWorkspace(db, account.accountId);
  assert.equal(first.name, 'My inventory');
  assert.equal(first.dataMode, 'production');
  assert.equal(workspaces.ensureFirstWorkspace(db, account.accountId), null);
  assert.equal(workspaces.listForAccount(db, account.accountId).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM automation_policies WHERE workspace_id = ? AND enabled = 1').get(first.workspaceId).n, 0);
});

test('an intentionally deleted last inventory is not silently recreated', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Delete explicitly' });
  deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: 'Delete explicitly' });
  assert.equal(workspaces.ensureFirstWorkspace(db, workspace.accountId), null);
  assert.equal(workspaces.listForAccount(db, workspace.accountId).length, 0);
});

test('an account with an inaccessible owned inventory is not given access back by bootstrap', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  db.prepare('DELETE FROM users WHERE account_id = ?').run(workspace.accountId);
  assert.equal(workspaces.ensureFirstWorkspace(db, workspace.accountId), null);
  assert.equal(workspaces.listForAccount(db, workspace.accountId).length, 0);
});
