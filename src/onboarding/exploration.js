'use strict';

const { inTransaction } = require('../db');
const workspaces = require('../domain/workspace-service');
const deletion = require('../domain/workspace-deletion');
const permissions = require('../actions/permissions');
const { ValidationError } = require('../domain/errors');
const paths = require('./paths');

function state(db, workspaceId, accountId = null) {
  const sample = db.prepare('SELECT * FROM workspace_sample_explorations WHERE workspace_id = ?').get(workspaceId);
  const ownSample = db.prepare('SELECT workspace_id FROM workspace_sample_explorations WHERE origin_workspace_id = ? AND created_by_account_id = ?')
    .get(workspaceId, accountId);
  const preferences = db.prepare('SELECT * FROM workspace_entry_preferences WHERE workspace_id = ?').get(workspaceId);
  const empty = !db.prepare('SELECT 1 FROM items WHERE workspace_id = ? AND is_active = 1 LIMIT 1').get(workspaceId);
  return { empty, sample: Boolean(sample), originId: sample ? sample.origin_workspace_id : null,
    canClear: Boolean(sample && sample.created_by_account_id === accountId),
    dismissed: Boolean(preferences && preferences.sample_dismissed_at),
    sampleId: ownSample && ownSample.workspace_id };
}

function ensure(db, workspaceId) {
  db.prepare('INSERT INTO workspace_entry_preferences(workspace_id) VALUES (?) ON CONFLICT DO NOTHING').run(workspaceId);
}

function load(db, ctx, actor, accountId) {
  permissions.assertCan(actor, permissions.ADMIN, 'load isolated sample data');
  return inTransaction(db, () => {
    const existing = state(db, ctx.workspaceId, accountId);
    if (existing.sample) return ctx.workspaceId;
    if (existing.sampleId && workspaces.resolveForAccount(db, accountId, existing.sampleId)) return existing.sampleId;
    const created = workspaces.createWorkspace(db, accountId, 'Sample inventory', { dataMode: 'synthetic' });
    const sampleContext = { workspaceId: created.workspaceId, actorId: created.userId };
    const location = require('../domain/location-service').createLocation(db, sampleContext,
      { name: 'Sample warehouse', kind: 'warehouse' });
    const catalog = require('../domain/item-service');
    const inventory = require('../domain/inventory-engine');
    for (const product of [
      { name: 'Sample coffee beans', code: 'SAMPLE-COFFEE', quantity: 40 },
      { name: 'Sample travel mug', code: 'SAMPLE-MUG', quantity: 24 },
      { name: 'Sample gift box', code: 'SAMPLE-BOX', quantity: 12 },
    ]) {
      const item = catalog.createExactItem(db, sampleContext,
        { name: product.name, baseCode: product.code, variants: [{ code: product.code, options: {} }] });
      inventory.receive(db, sampleContext, { skuId: item.skus[0].skuId, locationId: location.id,
        quantity: product.quantity, reference: 'SAMPLE-OPEN', notes: 'Disposable sample data, not business evidence.' });
    }
    paths.choose(db, created.workspaceId, 'fresh');
    paths.setStatus(db, created.workspaceId, 'ready');
    db.prepare('INSERT INTO workspace_sample_explorations(workspace_id, origin_workspace_id, created_by_account_id) VALUES (?, ?, ?)')
      .run(created.workspaceId, ctx.workspaceId, accountId);
    return created.workspaceId;
  });
}

function clear(db, ctx, actor, accountId) {
  permissions.assertCan(actor, permissions.ADMIN, 'clear disposable sample inventory');
  return inTransaction(db, () => {
    const current = state(db, ctx.workspaceId, accountId);
    if (!current.sample) throw new ValidationError('Only an isolated sample inventory can be cleared here.');
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ctx.workspaceId);
    if (workspace.data_mode !== 'synthetic' || workspace.owner_account_id !== accountId) {
      throw new ValidationError('This is not your disposable sample inventory.');
    }
    deletion.deleteWorkspace(db, accountId, workspace.id, { confirmName: workspace.name });
    return workspaces.resolveForAccount(db, accountId, current.originId) ? current.originId : null;
  });
}

function dismiss(db, workspaceId) {
  ensure(db, workspaceId);
  db.prepare('UPDATE workspace_entry_preferences SET sample_dismissed_at = ? WHERE workspace_id = ?')
    .run(new Date().toISOString(), workspaceId);
}

function skip(db, workspaceId) {
  ensure(db, workspaceId);
  db.prepare('UPDATE workspace_entry_preferences SET skipped_at = ? WHERE workspace_id = ?')
    .run(new Date().toISOString(), workspaceId);
}

module.exports = { state, load, clear, dismiss, skip };
