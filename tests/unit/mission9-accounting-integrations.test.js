'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const ledger = require('../../src/accounting/ledger');
const sync = require('../../src/accounting/integration-sync');
const connections = require('../../src/connections/service');
const publicApi = require('../../src/connections/public-api');
const webhooks = require('../../src/connections/outbound-webhooks');
const events = require('../../src/manager/events');
const outbox = require('../../src/operations/outbox');
const credentialStore = require('../../src/connections/credentials');
const providerService = require('../../src/connections/provider-service');

test.after(cleanupAll);

function fixture(capabilities = ['accounting:read', 'accounting:shadow', 'accounting:post']) {
  const { db } = makeDatabase(); const workspace = seedWorkspace(db, { workspaceName: 'Mission 9 Accounting' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, { startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE' });
  const id = `con_${crypto.randomBytes(8).toString('hex')}`; const now = new Date().toISOString();
  db.prepare(`INSERT INTO workspace_connectors
    (id, workspace_id, connector_key, display_name, provider_type, status, capabilities, provides,
     config, expected_interval_minutes, setup_status, authorized_by_user_id, provider_account_id, created_at, updated_at)
    VALUES (?, ?, ?, 'QuickBooks Sandbox', 'quickbooks', 'connected', ?, '[]', '{}', 360,
      'AUTHORITY_REQUIRED', ?, 'realm-1', ?, ?)`)
    .run(id, workspace.workspaceId, `quickbooks:${id}`, JSON.stringify(capabilities), workspace.ownerId, now, now);
  const connection = connections.get(db, workspace.workspaceId, id);
  sync.initialize(db, connection, workspace.ownerId, { label: 'QuickBooks company', value: 'Real Test Company', externalId: 'realm-1' });
  return { db, workspace, membership, connection };
}

function exactSnapshot(env, mutate = (rows) => rows) {
  const local = sync.localSnapshot(env.db, env.workspace.workspaceId, '2026-09-10');
  return { asOf: local.asOf, currency: local.currency, version: 'provider-v1',
    accounts: mutate(local.accounts.map((row, index) => ({ externalId: `qb-${index + 1}`,
      version: '1', code: row.code, name: row.name, balanceMinor: row.balanceMinor }))) };
}

test('accounting starts verified and read-only, then exact shadow parity gates posting', async () => {
  const env = fixture();
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'READ_ONLY_VERIFIED');
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'POST', accountingSource: 'FOUNDRY' });
  assert.throws(() => sync.enableWrites(env.db, env.workspace.ctx, env.connection.id), /matching shadow/i);
  const adapter = { readAccountingSnapshot: async () => exactSnapshot(env) };
  const shadow = await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(shadow.status, 'MATCHED');
  assert.equal(sync.enableWrites(env.db, env.workspace.ctx, env.connection.id).stage, 'WRITE_ENABLED');
});

test('unmapped or conflicting external facts stop safely and never become silent identity mappings', async () => {
  const env = fixture();
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'POST', accountingSource: 'FOUNDRY' });
  const adapter = { readAccountingSnapshot: async () => exactSnapshot(env, (rows) => [
    ...rows.slice(1), { externalId: 'mystery', code: null, name: 'Maybe inventory', balanceMinor: 2500 },
  ]) };
  const result = await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(result.status, 'MISMATCH');
  assert.ok(result.differences.some((row) => row.kind === 'UNMAPPED_EXTERNAL_ACCOUNT'));
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'CONFLICT');
  assert.throws(() => sync.enableWrites(env.db, env.workspace.ctx, env.connection.id), /matching shadow/i);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_external_identities
    WHERE connector_id = ? AND external_id = 'mystery'`).get(env.connection.id).n, 0);
});

test('an approved exact mapping can resolve an uncertain account on the next shadow run', async () => {
  const env = fixture(); sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id,
    { authority: 'POST', accountingSource: 'FOUNDRY' });
  const local = sync.localSnapshot(env.db, env.workspace.workspaceId, '2026-09-10');
  const target = local.accounts[0];
  const snapshot = exactSnapshot(env, (rows) => rows.map((row) => row.code === target.code
    ? { ...row, code: null, name: `External ${target.name}` } : row));
  const adapter = { readAccountingSnapshot: async () => snapshot };
  let result = await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  const uncertain = result.differences.find((row) => row.kind === 'UNMAPPED_EXTERNAL_ACCOUNT');
  const account = env.db.prepare('SELECT id FROM accounting_accounts WHERE workspace_id = ? AND code = ?')
    .get(env.workspace.workspaceId, target.code);
  sync.mapAccount(env.db, env.workspace.ctx, env.connection.id, { externalId: uncertain.externalId, accountId: account.id });
  result = await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(result.status, 'MATCHED');
  assert.equal(sync.state(env.db, env.workspace.workspaceId, env.connection.id).conflicts.every((row) => row.status === 'RESOLVED'), true);
});

test('out-of-order accounting snapshots and revoked authorization stop with actionable evidence', async () => {
  const env = fixture(); sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id,
    { authority: 'SHADOW', accountingSource: 'FOUNDRY' });
  const first = exactSnapshot(env); first.asOf = '2026-09-10';
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, { readAccountingSnapshot: async () => first }, {}, { asOf: first.asOf });
  const stale = exactSnapshot(env); stale.asOf = '2026-09-09';
  await assert.rejects(sync.shadow(env.db, env.workspace.ctx, env.connection.id,
    { readAccountingSnapshot: async () => stale }, {}, { asOf: stale.asOf }), /out-of-order/i);
  credentialStore.put(env.db, env.workspace.workspaceId, env.connection.id, 'provider',
    { accessToken: 'expired', refreshToken: 'revoked', expiresAt: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(providerService.loadProviderCredentials(env.db, env.connection,
    { refreshCredentials: async () => { const error = new Error('authorization revoked'); error.status = 401; throw error; } }), /revoked/i);
  const connection = connections.get(env.db, env.workspace.workspaceId, env.connection.id);
  assert.equal(connection.setup_status, 'REAUTHORIZATION_REQUIRED');
  assert.equal(connection.openIssues > 0, true);
});

test('governed posting uses exact account identities and provider idempotency once', async () => {
  const env = fixture(); const adapter = { readAccountingSnapshot: async () => exactSnapshot(env), calls: [],
    async postJournalEntry(input) { this.calls.push(input); return { externalId: `journal-${input.entry.id}`, version: '1' }; } };
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'POST', accountingSource: 'FOUNDRY' });
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {}); sync.enableWrites(env.db, env.workspace.ctx, env.connection.id);
  const accounts = ledger.listAccounts(env.db, env.workspace.workspaceId);
  ledger.post(env.db, env.workspace.ctx, { postingDate: '2026-09-10', sourceKey: 'mission9-entry',
    description: 'Certified test entry', lines: [{ accountId: accounts[0].id, debitMinor: 1000 },
      { accountId: accounts[1].id, creditMinor: 1000 }] });
  const first = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  const replay = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(first.posted, 1); assert.equal(replay.posted, 0); assert.equal(adapter.calls.length, 1);
  assert.match(adapter.calls[0].idempotencyKey, /^foundry-/);
});

test('scoped API tokens enforce authority and revocation immediately', () => {
  const env = fixture(); const client = publicApi.create(env.db, env.workspace.ctx,
    { name: 'Read-only BI', scopes: ['inventory:read'] });
  assert.equal(publicApi.authenticate(env.db, `Bearer ${client.token}`, 'inventory:read').workspaceId, env.workspace.workspaceId);
  assert.throws(() => publicApi.authenticate(env.db, `Bearer ${client.token}`, 'inventory:write'), /does not have/i);
  publicApi.revoke(env.db, env.workspace.workspaceId, client.id);
  assert.throws(() => publicApi.authenticate(env.db, `Bearer ${client.token}`, 'inventory:read'), /invalid or revoked/i);
});

test('outbound events are signed, durable, and duplicate publication cannot duplicate delivery', async () => {
  const env = fixture(); const hook = webhooks.create(env.db, env.workspace.ctx,
    { name: 'Audit sink', endpointUrl: 'http://localhost:9999/events', eventTypes: ['inventory.received'] });
  const published = events.publish(env.db, env.workspace.workspaceId, 'inventory.received', { quantity: 3 },
    { idempotencyKey: 'mission9-webhook-event' });
  events.publish(env.db, env.workspace.workspaceId, 'inventory.received', { quantity: 3 },
    { idempotencyKey: 'mission9-webhook-event' });
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM outbound_webhook_deliveries WHERE subscription_id = ?').get(hook.id).n, 1);
  let observed;
  const dispatch = webhooks.dispatcher(env.db, { fetchImpl: async (url, options) => {
    observed = { url, options }; return { ok: true, status: 204 };
  } });
  const delivered = await outbox.processOne(env.db, { 'outbound.webhook': dispatch }, { owner: 'mission9-test' });
  assert.equal(delivered.status, 'DELIVERED'); assert.equal(observed.url, 'http://localhost:9999/events');
  const expected = crypto.createHmac('sha256', hook.secret)
    .update(`${observed.options.headers['x-foundry-timestamp']}.${observed.options.body}`).digest('hex');
  assert.equal(observed.options.headers['x-foundry-signature'], `v1=${expected}`);
  assert.equal(JSON.parse(observed.options.body).id, published.event.id);
});
