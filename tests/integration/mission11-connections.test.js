'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/event-ingestion');
const needsYou = require('../../src/manager/needs-you-inbox');
const queryPlanner = require('../../src/attention/query-planner');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace, makeQuantityItem,
  signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Connected Operations' });
  const membership = authService.getMembership(store.db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Black T-shirt Small', baseCode: 'TS-BLK-S' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.store.id,
    quantity: 40, reference: 'opening' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'mission-11-test' });
  const created = connections.create(store.db, workspace.ctx, membership, {
    providerType: 'reference_webhook', displayName: 'Downtown POS', expectedIntervalMinutes: 360,
  });
  return { ...store, workspace, membership, item, app, connection: created.connection, token: created.token };
}

function postEvent(env, body, token = env.token) {
  return request(env.app).post('/api/v1/events').set('Authorization', `Bearer ${token}`).send(body);
}

test('normalized external sale uses the inventory engine, is audited, and replay is exactly once', async () => {
  const env = setup();
  const body = { eventId: 'pos-sale-1', type: 'sale.completed', version: '1',
    occurredAt: '2026-08-27T12:00:00.000Z', data: { externalSku: 'pos-8473', skuCode: 'TS-BLK-S',
      externalLocationId: 'store-12', locationName: 'Downtown Store', quantity: 3 } };
  const first = await postEvent(env, body);
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 37);
  const movement = env.db.prepare("SELECT * FROM movements WHERE reference = 'external:pos-sale-1'").get();
  assert.equal(movement.operation, 'issue');
  assert.match(movement.notes, /Source: Downtown POS; external event: pos-sale-1/);
  assert.equal(env.db.prepare("SELECT action_type FROM connector_feed_events WHERE external_event_id = 'pos-sale-1'").get().action_type,
    'inventory.issue');

  const replay = await postEvent(env, body);
  assert.equal(replay.body.replayed, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 37);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE reference = 'external:pos-sale-1'").get().n, 1);
  env.db.close();
});

test('unknown SKU goes to Needs You, mapping once retries safely and remains durable', async () => {
  const env = setup();
  const body = { eventId: 'unknown-sku-sale', type: 'sale.completed', data: {
    externalSku: 'vendor-unknown-9', locationName: 'Downtown Store', quantity: 2 } };
  const waiting = await postEvent(env, body);
  assert.equal(waiting.status, 207);
  assert.equal(waiting.body.needsMapping, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 40);
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((row) => /Unknown sku/i.test(row.title)));

  connections.mapExternal(env.db, env.workspace.ctx, env.connection.id, {
    entityType: 'sku', externalId: 'vendor-unknown-9', foundryRecordId: env.item.skuId,
  });
  const auth = { connectorId: env.connection.id, workspaceId: env.workspace.workspaceId,
    actorId: env.workspace.ownerId, accountId: env.workspace.accountId,
    providerType: env.connection.provider_type, displayName: env.connection.display_name };
  const retried = ingestion.retryPending(env.db, auth);
  assert.equal(retried[0].accepted, true);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 38);
  assert.equal(env.db.prepare("SELECT status FROM connector_feed_events WHERE external_event_id = 'unknown-sku-sale'").get().status,
    'COMPLETED');
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, env.connection.id, 'sku', 'vendor-unknown-9').foundry_record_id,
    env.item.skuId);
  env.db.close();
});

test('unknown location is blocked without mutation and its approved mapping enables retry', async () => {
  const env = setup();
  const body = { eventId: 'unknown-place-sale', type: 'sale.completed', data: {
    skuCode: 'TS-BLK-S', externalLocationId: 'store-77', quantity: 1 } };
  const waiting = await postEvent(env, body);
  assert.equal(waiting.body.needsMapping, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 40);
  connections.mapExternal(env.db, env.workspace.ctx, env.connection.id, {
    entityType: 'location', externalId: 'store-77', foundryRecordId: env.workspace.store.id,
  });
  const again = await postEvent(env, body);
  assert.equal(again.body.accepted, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 39);
  env.db.close();
});

test('external Sales Order uses Mission 10 commitments and fulfillment uses its stock movement path', async () => {
  const env = setup();
  const created = await postEvent(env, { eventId: 'order-created-20', type: 'sales_order.created',
    aggregateId: 'web-order-20', version: 1, data: { externalOrderId: 'web-order-20',
      customer: { externalId: 'cust-20', name: 'ABC School' }, fulfillmentLocationName: 'Downtown Store',
      lines: [{ skuCode: 'TS-BLK-S', quantity: 5 }] } });
  assert.equal(created.body.accepted, 1);
  const mapped = connections.mapping(env.db, env.workspace.workspaceId, env.connection.id, 'sales_order', 'web-order-20');
  const order = sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id);
  assert.equal(order.totals.allocated, 5);
  assert.equal(order.status, 'CONFIRMED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 40,
    'commitment does not pretend stock left');

  const fulfilled = await postEvent(env, { eventId: 'order-fulfilled-20', type: 'sales_order.fulfilled',
    aggregateId: 'web-order-20', version: 2, data: { externalOrderId: 'web-order-20' } });
  assert.equal(fulfilled.body.accepted, 1);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).status, 'FULFILLED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 35);
  assert.ok(env.db.prepare("SELECT 1 FROM domain_events WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled'")
    .get(env.workspace.workspaceId));
  env.db.close();
});

test('external cancellation releases commitments and wakes Mission 9 reaction handling', async () => {
  const env = setup();
  await postEvent(env, { eventId: 'order-created-21', type: 'sales_order.created', aggregateId: 'web-order-21', version: 1,
    data: { externalOrderId: 'web-order-21', customerName: 'Cancel Customer', fulfillmentLocationName: 'Downtown Store',
      lines: [{ skuCode: 'TS-BLK-S', quantity: 7 }] } });
  const mapped = connections.mapping(env.db, env.workspace.workspaceId, env.connection.id, 'sales_order', 'web-order-21');
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).totals.allocated, 7);
  const cancelled = await postEvent(env, { eventId: 'order-cancelled-21', type: 'sales_order.cancelled',
    aggregateId: 'web-order-21', version: 2, data: { externalOrderId: 'web-order-21', reason: 'Customer cancelled' } });
  assert.equal(cancelled.body.accepted, 1);
  const order = sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id);
  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.totals.allocated, 0);
  assert.ok(env.db.prepare("SELECT 1 FROM domain_events WHERE workspace_id = ? AND event_type = 'sales_order.cancelled'")
    .get(env.workspace.workspaceId));
  env.db.close();
});

test('older external state is recorded as stale and cannot rewrite newer Foundry truth', async () => {
  const env = setup();
  await postEvent(env, { eventId: 'order-new', type: 'sales_order.created', aggregateId: 'ordered-stream', version: 3,
    data: { externalOrderId: 'ordered-stream', customerName: 'Versioned Buyer', fulfillmentLocationName: 'Downtown Store',
      lines: [{ skuCode: 'TS-BLK-S', quantity: 2 }] } });
  const stale = await postEvent(env, { eventId: 'order-old-cancel', type: 'sales_order.cancelled',
    aggregateId: 'ordered-stream', version: 2, data: { externalOrderId: 'ordered-stream' } });
  assert.equal(stale.status, 207);
  assert.equal(stale.body.results[0].status, 'STALE');
  const mapped = connections.mapping(env.db, env.workspace.workspaceId, env.connection.id, 'sales_order', 'ordered-stream');
  assert.notEqual(sales.getOrder(env.db, env.workspace.workspaceId, mapped.foundry_record_id).status, 'CANCELLED');
  env.db.close();
});

test('fulfillment arriving before its order waits safely, then completes when the order arrives', async () => {
  const env = setup();
  const early = await postEvent(env, { eventId: 'early-fulfillment', type: 'sales_order.fulfilled',
    aggregateId: 'late-order', version: 2, data: { externalOrderId: 'late-order' } });
  assert.equal(early.body.needsMapping, 1);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 40);
  const order = await postEvent(env, { eventId: 'late-order-created', type: 'sales_order.created',
    aggregateId: 'late-order', version: 1, data: { externalOrderId: 'late-order', customerName: 'Late Stream',
      fulfillmentLocationName: 'Downtown Store', lines: [{ skuCode: 'TS-BLK-S', quantity: 4 }] } });
  assert.equal(order.body.accepted, 1);
  assert.equal(order.body.retried, 1);
  assert.equal(env.db.prepare("SELECT status FROM connector_feed_events WHERE external_event_id = 'early-fulfillment'").get().status,
    'COMPLETED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), 36);
  env.db.close();
});

test('reconciliation reports evidence mismatch and never overwrites stock', async () => {
  const env = setup();
  await postEvent(env, { eventId: 'recon-sale', type: 'sale.completed', data: {
    skuCode: 'TS-BLK-S', locationName: 'Downtown Store', quantity: 1 } });
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const reconciled = await postEvent(env, { eventId: 'recon-1', type: 'reconciliation.summary', data: {
    expected: { 'sale.completed': 2 } } });
  assert.equal(reconciled.body.accepted, 1);
  const row = env.db.prepare('SELECT * FROM connection_reconciliations WHERE connector_id = ?').get(env.connection.id);
  assert.equal(row.status, 'MISMATCH');
  assert.match(row.discrepancies, /sale.completed/);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => /does not match/i.test(entry.title)));
  env.db.close();
});

test('connection staleness covers a missing first event and resolves automatically when activity resumes', async () => {
  const env = setup();
  env.db.prepare(`UPDATE workspace_connectors SET last_activity_at = NULL, last_synced_at = NULL, created_at = ?,
    expected_interval_minutes = 60 WHERE id = ?`).run('2026-08-26T00:00:00.000Z', env.connection.id);
  const state = connections.refreshHealth(env.db, env.workspace.workspaceId, { now: Date.parse('2026-08-27T12:00:00.000Z') });
  assert.equal(state[0].publicStatus, 'Needs attention');
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => /stopped sending/i.test(entry.title)));
  const resumed = await postEvent(env, { eventId: 'after-outage', type: 'sale.completed', data: {
    skuCode: 'TS-BLK-S', locationName: 'Downtown Store', quantity: 1 } });
  assert.equal(resumed.body.accepted, 1);
  assert.equal(env.db.prepare(`SELECT status FROM connection_issues WHERE connector_id = ?
    AND issue_type = 'CONNECTION_STALE'`).get(env.connection.id).status, 'RESOLVED');
  assert.equal(connections.get(env.db, env.workspace.workspaceId, env.connection.id).publicStatus, 'Connected');
  env.db.close();
});

test('connection tokens and mappings stay isolated between workspaces', async () => {
  const env = setup();
  const other = seedAnotherWorkspace(env.db, env.workspace.accountId, 'Other Inventory');
  const otherItem = makeQuantityItem(env.db, other.ctx, { name: 'Other Product', baseCode: 'OTHER-1' });
  inventory.receive(env.db, other.ctx, { skuId: otherItem.skuId, locationId: other.store.id, quantity: 9 });
  const attempt = await postEvent(env, { eventId: 'cross-tenant', type: 'sale.completed', data: {
    skuId: otherItem.skuId, locationId: other.store.id, quantity: 2 } });
  assert.equal(attempt.body.needsMapping, 1);
  assert.equal(repo.getBalance(env.db, other.workspaceId, otherItem.skuId, other.store.id), 9);
  assert.equal(env.db.prepare('SELECT workspace_id FROM connector_feed_events WHERE external_event_id = ?').get('cross-tenant').workspace_id,
    env.workspace.workspaceId);
  env.db.close();
});

test('supplier email captures configured sender and attachments exactly once without receiving inventory', async () => {
  const env = setup();
  const email = connections.create(env.db, env.workspace.ctx, env.membership, {
    providerType: 'supplier_email', displayName: 'Supplier Inbox', expectedIntervalMinutes: 1440,
  });
  connections.addEmailRule(env.db, env.workspace.ctx, email.connection.id, { senderPattern: 'orders@supplier.test' });
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  const payload = { messageId: 'msg-100', sender: 'orders@supplier.test', subject: 'Invoice 884',
    bodyText: 'Invoice for 50 units', receivedAt: '2026-08-27T09:00:00Z',
    attachments: [{ id: 'a1', filename: 'invoice-884.pdf', mimeType: 'application/pdf',
      contentBase64: Buffer.from('not a real pdf').toString('base64') }] };
  const first = await request(env.app).post('/api/v1/email/messages')
    .set('Authorization', `Bearer ${email.token}`).send(payload);
  const replay = await request(env.app).post('/api/v1/email/messages')
    .set('Authorization', `Bearer ${email.token}`).send(payload);
  assert.equal(first.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM connection_email_messages WHERE external_message_id = 'msg-100'").get().n, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM connection_email_attachments').get().n, 1);
  assert.equal(env.db.prepare("SELECT classification FROM connection_email_messages WHERE external_message_id = 'msg-100'").get().classification,
    'invoice');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before,
    'an invoice is not proof of physical receipt');
  env.db.close();
});

test('unconfigured supplier sender is retained as untrusted evidence and changes nothing', async () => {
  const env = setup();
  const email = connections.create(env.db, env.workspace.ctx, env.membership, {
    providerType: 'supplier_email', displayName: 'Supplier Inbox',
  });
  const before = repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id);
  await request(env.app).post('/api/v1/email/messages').set('Authorization', `Bearer ${email.token}`).send({
    messageId: 'unknown-sender', sender: 'intruder@example.test', subject: 'Packing slip', bodyText: 'Delivered 100',
  });
  assert.equal(env.db.prepare("SELECT trust_status FROM connection_email_messages WHERE external_message_id = 'unknown-sender'").get().trust_status,
    'UNTRUSTED');
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.store.id), before);
  assert.ok(needsYou.inbox(env.db, env.workspace.workspaceId).some((entry) => /unapproved sender/i.test(entry.title)));
  env.db.close();
});

test('disconnect and reconnect revoke credentials but preserve mappings and audit history', async () => {
  const env = setup();
  await postEvent(env, { eventId: 'before-disconnect', type: 'sale.completed', data: {
    externalSku: 'durable-sku', skuCode: 'TS-BLK-S', locationName: 'Downtown Store', quantity: 1 } });
  connections.disconnect(env.db, env.workspace.workspaceId, env.connection.id);
  const rejected = await postEvent(env, { eventId: 'while-off', type: 'sale.completed', data: {
    externalSku: 'durable-sku', locationName: 'Downtown Store', quantity: 1 } });
  assert.equal(rejected.status, 401);
  const rotated = connections.rotateToken(env.db, env.workspace.ctx, env.membership, env.connection.id);
  const accepted = await postEvent(env, { eventId: 'after-reconnect', type: 'sale.completed', data: {
    externalSku: 'durable-sku', locationName: 'Downtown Store', quantity: 1 } }, rotated.token);
  assert.equal(accepted.body.accepted, 1);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM connector_feed_events WHERE connector_id = ?').get(env.connection.id).n, 2);
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, env.connection.id, 'sku', 'durable-sku').foundry_record_id,
    env.item.skuId);
  env.db.close();
});

test('Connections UI is simple by default and advanced diagnostics are opt-in', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const list = await agent.get('/settings/connections');
  const text = plain(list.text);
  assert.equal(list.status, 200);
  assert.match(text, /Keep Foundry informed automatically/);
  assert.match(text, /Downtown POS/);
  assert.match(text, /Connected/);
  const detail = await agent.get(`/settings/connections/${env.connection.id}`);
  assert.match(detail.text, /Advanced diagnostics/);
  assert.match(plain(detail.text), /Replaying one external event ID never repeats its Foundry action/);
  env.db.close();
});

test('Ask Foundry answers connection health and last-event questions from connection records', async () => {
  const env = setup();
  await postEvent(env, { eventId: 'latest-pos-event', type: 'sale.completed', data: {
    skuCode: 'TS-BLK-S', locationName: 'Downtown Store', quantity: 1 } });
  const summary = await queryPlanner.ask(env.db, env.workspace.workspaceId, 'What connections need attention?', {});
  assert.equal(summary.plan.intent, 'connection_summary');
  assert.match(summary.answer, /1 connection/);
  const last = await queryPlanner.ask(env.db, env.workspace.workspaceId, 'What was the last event received from the POS?', {});
  assert.equal(last.plan.intent, 'connection_last_event');
  assert.match(last.answer, /latest-pos-event/);
  env.db.close();
});
