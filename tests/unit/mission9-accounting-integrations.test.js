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

test('provider-omitted zero-balance accounts are not presented as financial differences', async () => {
  const env = fixture();
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'SHADOW', accountingSource: 'EXTERNAL' });
  const result = await sync.shadow(env.db, env.workspace.ctx, env.connection.id,
    { readAccountingSnapshot: async () => ({ asOf: '2026-09-10', currency: 'USD', version: 'empty-books', accounts: [] }) }, {});
  assert.equal(result.status, 'MATCHED');
  assert.deepEqual(result.differences, []);
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
  const accounts = ledger.listAccounts(env.db, env.workspace.workspaceId);
  ledger.post(env.db, env.workspace.ctx, { postingDate: '2026-09-10', sourceKey: 'mapping-proof',
    description: 'Create a material balance that requires an exact mapping', lines: [
      { accountId: accounts[0].id, debitMinor: 2500 }, { accountId: accounts[1].id, creditMinor: 2500 },
    ] });
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

test('empty StockChief books can import provider opening books with exact identities and reconcile', async () => {
  const env = fixture();
  const snapshot = { asOf: '2026-09-10', currency: 'USD', version: 'qb-opening-v1', accounts: [
    { externalId: '35', name: 'Checking', accountType: 'Bank', classification: 'Asset', balanceMinor: 12500 },
    { externalId: '33', name: 'Accounts Payable', accountType: 'Accounts Payable', classification: 'Liability', balanceMinor: -7500 },
    { externalId: '2', name: 'Owner Equity', accountType: 'Equity', classification: 'Equity', balanceMinor: -5000 },
    { externalId: '7', name: 'Unused expense', accountType: 'Expense', classification: 'Expense', balanceMinor: 0 },
  ] };
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id,
    { authority: 'SHADOW', accountingSource: 'EXTERNAL' });
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id,
    { readAccountingSnapshot: async () => snapshot }, {});
  const imported = sync.importOpeningBooks(env.db, env.workspace.ctx, env.membership, env.connection.id);
  assert.equal(imported.replayed, false);
  assert.equal(imported.preview.accountCount, 4);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_record_type = 'accounting_connection_opening' AND status = 'POSTED'`)
    .get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_external_identities
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'account'`)
    .get(env.workspace.workspaceId, env.connection.id).n, 4);
  const matched = await sync.shadow(env.db, env.workspace.ctx, env.connection.id,
    { readAccountingSnapshot: async () => snapshot }, {});
  assert.equal(matched.status, 'MATCHED');
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).requested_authority, 'POST');
});

test('imported opening books are never posted back and sandbox proof posts one charge plus its reversal', async () => {
  const env = fixture();
  const snapshot = { asOf: '2026-09-10', currency: 'USD', version: 'qb-proof-v1', accounts: [
    { externalId: 'bank', name: 'Checking', accountType: 'Bank', classification: 'Asset', balanceMinor: 10000 },
    { externalId: 'expense', name: 'Other Business Expenses', accountType: 'Expense', classification: 'Expense', balanceMinor: 5000 },
    { externalId: 'equity', name: 'Opening Equity', accountType: 'Equity', classification: 'Equity', balanceMinor: -15000 },
  ] };
  const adapter = { readAccountingSnapshot: async () => snapshot, calls: [],
    async postJournalEntry(input) { this.calls.push(input); return { externalId: `qb-${this.calls.length}`, version: '1' }; } };
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id,
    { authority: 'SHADOW', accountingSource: 'EXTERNAL' });
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  sync.importOpeningBooks(env.db, env.workspace.ctx, env.membership, env.connection.id);
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  sync.enableWrites(env.db, env.workspace.ctx, env.connection.id);
  sync.createSandboxProof(env.db, env.workspace.ctx, env.connection.id);
  const posted = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(posted.posted, 2);
  assert.equal(adapter.calls.length, 2);
  assert.equal(adapter.calls.some((call) => call.entry.source_record_type === 'accounting_connection_opening'), false);
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  const finalState = sync.state(env.db, env.workspace.workspaceId, env.connection.id);
  assert.equal(finalState.policy.stage, 'WRITE_ENABLED');
  assert.equal(finalState.sandboxProof.passed, true);
  assert.deepEqual(finalState.sandboxProof.entries.map((entry) => entry.external_id), ['qb-1', 'qb-2']);
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

test('owner-approved posting aliases preserve imported account identities and restore governed posting', async () => {
  const env = fixture();
  const adapter = { readAccountingSnapshot: async () => exactSnapshot(env), calls: [],
    async postJournalEntry(input) { this.calls.push(input); return { externalId: `journal-${input.entry.id}`, version: '1' }; } };
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'POST', accountingSource: 'FOUNDRY' });
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  sync.enableWrites(env.db, env.workspace.ctx, env.connection.id);

  const accounts = ledger.listAccounts(env.db, env.workspace.workspaceId);
  const canonical = accounts[0];
  const balancing = accounts[1];
  const canonicalIdentity = env.db.prepare(`SELECT * FROM accounting_external_identities
    WHERE workspace_id = ? AND connector_id = ? AND entity_type = 'account' AND foundry_record_id = ?`)
    .get(env.workspace.workspaceId, env.connection.id, canonical.id);
  const mirror = ledger.createAccount(env.db, env.workspace.ctx, env.membership, {
    code: 'QB-MIRROR', name: `Imported ${canonical.name}`, type: canonical.account_type,
    normalBalance: canonical.normal_balance,
  });
  env.db.prepare(`UPDATE accounting_external_identities SET foundry_record_id = ? WHERE id = ?`)
    .run(mirror.id, canonicalIdentity.id);

  const journal = ledger.post(env.db, env.workspace.ctx, { postingDate: '2026-09-10', sourceKey: 'posting-alias-proof',
    description: 'Canonical account posts through imported provider account', lines: [
      { accountId: canonical.id, debitMinor: 1000 }, { accountId: balancing.id, creditMinor: 1000 },
    ] }).entry;
  const stopped = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  assert.equal(stopped.posted, 0);
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'CONFLICT');

  const mapped = sync.mapAccount(env.db, env.workspace.ctx, env.connection.id,
    { accountId: canonical.id, externalId: canonicalIdentity.external_id });
  assert.equal(mapped.sharedReadIdentity, true);
  assert.equal(env.db.prepare(`SELECT foundry_record_id FROM accounting_external_identities WHERE id = ?`)
    .get(canonicalIdentity.id).foundry_record_id, mirror.id);
  assert.equal(env.db.prepare(`SELECT external_id FROM accounting_posting_account_mappings
    WHERE workspace_id = ? AND connector_id = ? AND foundry_account_id = ?`)
    .get(env.workspace.workspaceId, env.connection.id, canonical.id).external_id, canonicalIdentity.external_id);
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'WRITE_ENABLED');
  assert.equal(sync.state(env.db, env.workspace.workspaceId, env.connection.id).conflicts
    .filter((row) => row.conflict_type === 'UNCERTAIN_ACCOUNT_IDENTITY').every((row) => row.status === 'RESOLVED'), true);

  const preview = sync.pendingEntries(env.db, env.workspace.workspaceId, env.connection.id);
  assert.equal(preview.length, 1);
  assert.equal(preview[0].id, journal.id);
  assert.deepEqual(preview[0].missingAccounts, []);
  const first = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {}, { entryIds: [journal.id] });
  const retry = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {}, { entryIds: [journal.id] });
  assert.equal(first.posted, 1);
  assert.equal(retry.posted, 0);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].entry.lines.find((line) => line.account_id === canonical.id).external_account_id,
    canonicalIdentity.external_id);
});

test('a missing QuickBooks customer identity preflights the entire batch before any journal write', async () => {
  const env = fixture();
  const adapter = { readAccountingSnapshot: async () => exactSnapshot(env), calls: [],
    async postJournalEntry(input) { this.calls.push(input); return { externalId: `journal-${input.entry.id}`, version: '1' }; } };
  sync.chooseAuthority(env.db, env.workspace.ctx, env.connection.id, { authority: 'POST', accountingSource: 'FOUNDRY' });
  await sync.shadow(env.db, env.workspace.ctx, env.connection.id, adapter, {});
  sync.enableWrites(env.db, env.workspace.ctx, env.connection.id);
  const accounts = ledger.listAccounts(env.db, env.workspace.workspaceId);
  const customerId = 'customer_posting_preflight'; const now = new Date().toISOString();
  env.db.prepare(`INSERT INTO customers
    (id, workspace_id, name, email, record_state, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, 'Posting Test Customer', 'posting@example.test', 'ACTIVE', ?, ?, ?)`)
    .run(customerId, env.workspace.workspaceId, env.workspace.ownerId, now, now);
  const entry = ledger.post(env.db, env.workspace.ctx, { postingDate: '2026-09-10', sourceKey: 'party-preflight',
    description: 'Receivable needs exact customer', lines: [
      { accountId: accounts[0].id, debitMinor: 2500, customerId },
      { accountId: accounts[1].id, creditMinor: 2500, customerId },
    ] }).entry;

  const stopped = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {}, { entryIds: [entry.id] });
  assert.deepEqual(stopped, { posted: 0, remaining: 1 });
  assert.equal(adapter.calls.length, 0);
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'CONFLICT');
  const preview = sync.pendingEntries(env.db, env.workspace.workspaceId, env.connection.id)
    .find((candidate) => candidate.id === entry.id);
  assert.deepEqual(preview.missingParties.map((party) => [party.partyType, party.name]),
    [['customer', 'Posting Test Customer']]);

  sync.mapPostingParty(env.db, env.workspace.ctx, env.connection.id, { partyType: 'customer', partyId: customerId,
    externalId: 'qb-customer-7', external: { externalId: 'qb-customer-7', name: 'Posting Test Customer', version: '1' } });
  assert.equal(sync.policy(env.db, env.workspace.workspaceId, env.connection.id).stage, 'WRITE_ENABLED');
  const posted = await sync.syncPending(env.db, env.workspace.ctx, env.connection.id, adapter, {}, { entryIds: [entry.id] });
  assert.equal(posted.posted, 1);
  assert.equal(adapter.calls.length, 1);
  assert.equal(adapter.calls[0].entry.lines.every((line) => line.external_customer_id === 'qb-customer-7'), true);
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
