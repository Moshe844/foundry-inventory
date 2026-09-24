'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exploration = require('../../src/onboarding/exploration');
const auth = require('../../src/domain/auth-service');
const deletion = require('../../src/domain/workspace-deletion');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Live business' });
  const actor = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, actor };
}

test('sample records are isolated and repeat loading reuses the disposable inventory', () => {
  const { db, workspace, actor } = setup();
  const sampleId = exploration.load(db, workspace.ctx, actor, workspace.accountId);
  assert.notEqual(sampleId, workspace.workspaceId);
  assert.equal(exploration.load(db, workspace.ctx, actor, workspace.accountId), sampleId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(sampleId).n, 3);
  assert.equal(db.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id = ?').get(sampleId).n, 76);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n, 0);
  assert.equal(exploration.state(db, sampleId, workspace.accountId).canClear, true);
  assert.equal(exploration.state(db, sampleId, 'another-account').canClear, false);
});

test('clear never accepts a real inventory or another account and keeps original data', () => {
  const { db, workspace, actor } = setup();
  assert.throws(() => exploration.clear(db, workspace.ctx, actor, workspace.accountId), /Only an isolated sample/);
  const sampleId = exploration.load(db, workspace.ctx, actor, workspace.accountId);
  const context = { ...workspace.ctx, workspaceId: sampleId };
  assert.throws(() => exploration.clear(db, context, actor, 'another-account'), /not your disposable/);
  assert.equal(exploration.clear(db, context, actor, workspace.accountId), workspace.workspaceId);
  assert.ok(db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspace.workspaceId));
  assert.equal(db.prepare('SELECT id FROM workspaces WHERE id = ?').get(sampleId), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ?').get(workspace.workspaceId).n, 2);
});

test('deleting the original inventory does not strand a sample without its clear action', () => {
  const { db, workspace, actor } = setup();
  const sampleId = exploration.load(db, workspace.ctx, actor, workspace.accountId);
  deletion.deleteWorkspace(db, workspace.accountId, workspace.workspaceId, { confirmName: 'Live business' });
  const state = exploration.state(db, sampleId, workspace.accountId);
  assert.equal(state.sample, true);
  assert.equal(state.canClear, true);
  assert.equal(state.originId, null);
  assert.equal(exploration.clear(db, { ...workspace.ctx, workspaceId: sampleId }, actor, workspace.accountId), null);
  assert.equal(db.prepare('SELECT id FROM workspaces WHERE id = ?').get(sampleId), undefined);
});

test('skip and sample dismissal are durable preferences, not invented inventory facts', () => {
  const { db, workspace } = setup();
  exploration.skip(db, workspace.workspaceId);
  exploration.dismiss(db, workspace.workspaceId);
  assert.equal(exploration.state(db, workspace.workspaceId, workspace.accountId).dismissed, true);
  assert.ok(db.prepare('SELECT skipped_at FROM workspace_entry_preferences WHERE workspace_id = ?').get(workspace.workspaceId).skipped_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n, 0);
});
