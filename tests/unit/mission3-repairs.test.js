'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const events = require('../../src/manager/events');
const repairs = require('../../src/repairs/service');
const connections = require('../../src/connections/service');
const workItems = require('../../src/autopilot/work-items');
const ledger = require('../../src/accounting/ledger');
const payments = require('../../src/accounting/payments');
const receivables = require('../../src/accounting/receivables');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const costing = require('../../src/accounting/costing');

test.after(cleanupAll);

function setup(name = 'Repair Lab') {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: name });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

test('duplicate external/domain event is retained once and the repair is idempotent', () => {
  const env = setup();
  const first = events.publish(env.db, env.workspace.workspaceId, events.TYPES.INVENTORY_RECEIVED,
    { quantity: 2 }, { idempotencyKey: 'provider:event-77' });
  const replay = events.publish(env.db, env.workspace.workspaceId, events.TYPES.INVENTORY_RECEIVED,
    { quantity: 2 }, { idempotencyKey: 'provider:event-77' });
  assert.equal(first.event.id, replay.event.id);

  let repair = repairs.openAndAssess(env.db, env.ctx, {
    kind: 'duplicate_event', symptom: 'The provider delivered the same event twice',
    failedInvariant: 'One provider event may produce at most one durable business event',
    affectedRecords: { eventId: first.event.id }, idempotencyKey: 'repair:duplicate:77',
  }).repairCase;
  assert.equal(repair.status, 'SIMULATED');
  repair = repairs.execute(env.db, env.ctx, env.membership, repair.id).repairCase;
  assert.equal(repair.status, 'RESOLVED');
  const again = repairs.execute(env.db, env.ctx, env.membership, repair.id);
  assert.equal(again.replayed, true);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM domain_events
    WHERE workspace_id = ? AND idempotency_key = 'provider:event-77'`).get(env.workspace.workspaceId).n, 1);
});

test('a wrong mapping is simulated, authority-gated, applied through the connection service and verified', () => {
  const env = setup();
  const oldProduct = makeQuantityItem(env.db, env.ctx, { name: 'Old Match' });
  const correctProduct = makeQuantityItem(env.db, env.ctx, { name: 'Correct Match' });
  const connection = connections.create(env.db, env.ctx, env.membership, {
    providerType: 'reference_webhook', displayName: 'Repair POS',
  }).connection;
  connections.mapExternal(env.db, env.ctx, connection.id, {
    entityType: 'sku', externalId: 'EXT-9', foundryRecordId: oldProduct.skuId,
  });
  let repair = repairs.openAndAssess(env.db, env.ctx, {
    kind: 'wrong_mapping', symptom: 'EXT-9 is mapped to the wrong product',
    failedInvariant: 'External product EXT-9 must resolve to the owner-approved Foundry SKU',
    affectedRecords: { connectorId: connection.id, entityType: 'sku', externalId: 'EXT-9',
      foundryRecordId: correctProduct.skuId },
  }).repairCase;
  assert.equal(repair.status, 'NEEDS_AUTHORITY');
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sku', 'EXT-9').foundry_record_id,
    oldProduct.skuId, 'simulation changes nothing');
  repair = repairs.approve(env.db, env.ctx, env.membership, repair.id);
  assert.equal(repair.status, 'AUTHORIZED');
  repair = repairs.execute(env.db, env.ctx, env.membership, repair.id).repairCase;
  assert.equal(repair.status, 'RESOLVED');
  assert.equal(connections.mapping(env.db, env.workspace.workspaceId, connection.id, 'sku', 'EXT-9').foundry_record_id,
    correctProduct.skuId);
  assert.ok(repair.verification.checks.every((check) => check.passed));
  const eventsBeforeReplay = repairs.events(env.db, env.workspace.workspaceId, repair.id).length;
  repair = repairs.approve(env.db, env.ctx, env.membership, repair.id);
  assert.equal(repair.status, 'RESOLVED', 'a replayed approval cannot reopen a verified repair');
  assert.equal(repairs.events(env.db, env.workspace.workspaceId, repair.id).length, eventsBeforeReplay,
    'a replayed approval creates no second lifecycle event');
  assert.equal(repairs.execute(env.db, env.ctx, env.membership, repair.id).replayed, true);
});

test('a crashed job reconciles a successful prior effect and never executes it again', () => {
  const env = setup();
  const work = workItems.upsert(env.db, env.workspace.workspaceId, {
    category: 'balance_transfer', recommendedAction: { actionType: 'transfer', quantity: 2 },
    approvalRequirement: 'NONE', executionStatus: 'EXECUTING', verificationStatus: 'PENDING',
    idempotencyKey: 'crash-work',
  }).item;
  const now = new Date().toISOString();
  env.db.prepare(`INSERT INTO action_executions
    (id, workspace_id, idempotency_key, executed_by_user_id, status, movement_group_ids,
     movement_ids, result, started_at, finished_at)
    VALUES ('exec_crash', ?, ?, ?, 'SUCCEEDED', '[]', '["movement_once"]', '{}', ?, ?)`)
    .run(env.workspace.workspaceId, `autopilot:${work.id}`, env.workspace.ownerId, now, now);

  const turn = require('../../src/manager/loop').run(env.db, env.ctx, env.membership,
    { trigger: 'restart' });
  assert.ok(turn.recoveredRepairs >= 1);
  const repair = repairs.list(env.db, env.workspace.workspaceId)
    .find((entry) => entry.kind === 'stuck_job' && entry.affectedRecords.workItemId === work.id);
  assert.equal(repair.status, 'RESOLVED');
  const recovered = workItems.get(env.db, env.workspace.workspaceId, work.id);
  assert.equal(recovered.executionStatus, 'COMPLETED');
  assert.equal(recovered.verificationStatus, 'VERIFIED');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM action_executions
    WHERE workspace_id = ? AND idempotency_key = ?`).get(env.workspace.workspaceId, `autopilot:${work.id}`).n, 1);
});

test('an overpayment repair reverses the old journal and re-records the cash once', () => {
  const env = setup();
  ledger.configure(env.db, env.ctx, env.membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const customer = sales.createCustomer(env.db, env.ctx, { name: 'Payment Repair Customer' });
  const draft = receivables.createDraft(env.db, env.ctx, env.membership, {
    customerId: customer.id, issueDate: '2026-09-08',
    lines: [{ description: 'Goods', quantity: 1, unitPriceMinor: 10000 }],
  }).invoice;
  const invoice = receivables.open(env.db, env.ctx, env.membership, draft.id);
  const original = payments.record(env.db, env.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: customer.id, amountMinor: 15000,
    paymentDate: '2026-09-08', allocations: [{ invoiceId: invoice.id, amountMinor: 10000 }],
    sourceKey: 'bad-allocation',
  }).payment;

  let repair = repairs.openAndAssess(env.db, env.ctx, {
    kind: 'overpayment', symptom: 'A customer receipt was applied to the wrong balance',
    failedInvariant: 'Customer cash must be allocated only to the intended invoice',
    affectedRecords: { paymentId: original.id, correctAllocations: [] },
  }).repairCase;
  assert.equal(repair.status, 'NEEDS_AUTHORITY');
  repair = repairs.approve(env.db, env.ctx, env.membership, repair.id);
  repair = repairs.execute(env.db, env.ctx, env.membership, repair.id).repairCase;
  assert.equal(repair.status, 'RESOLVED');
  assert.equal(payments.requirePayment(env.db, env.workspace.workspaceId, original.id).status, 'VOID');
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_payments
    WHERE workspace_id = ? AND source_key = ?`).get(env.workspace.workspaceId, `repair:${repair.id}`).n, 1);
  assert.equal(repairs.execute(env.db, env.ctx, env.membership, repair.id).replayed, true);
});

test('inventory/accounting mismatch retries the exact source and resolves only after reconciliation passes', () => {
  const env = setup();
  ledger.configure(env.db, env.ctx, env.membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const product = makeQuantityItem(env.db, env.ctx, { name: 'Cost Repair Shoe' });
  prices.setPrice(env.db, env.ctx, { skuId: product.skuId, amount: '20.00', currency: 'USD' });
  const stock = inventory.receive(env.db, env.ctx, {
    skuId: product.skuId, locationId: env.workspace.main.id, quantity: 1,
    reference: 'repair-opening', occurredAt: '2026-01-02',
  });
  let order = sales.createOrder(env.db, env.ctx, {
    customerName: 'Repair Buyer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: product.skuId, quantity: 1 }],
  });
  order = sales.confirm(env.db, env.ctx, order.id);
  sales.fulfill(env.db, env.ctx, order.id, {}, { idempotencyKey: 'repair-sale' });
  const failed = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled'`)
    .get(env.workspace.workspaceId);
  assert.equal(failed.status, 'NEEDS_REVIEW');

  costing.receive(env.db, env.ctx, { movementIds: stock.movementIds, unitCostMinor: 800,
    sourceType: 'opening_balance', sourceRecordId: 'repair-opening' });
  ledger.post(env.db, env.ctx, { postingDate: '2026-01-02', description: 'Opening inventory',
    sourceKey: 'repair-opening-ledger', lines: [
      { accountKey: 'INVENTORY_ASSET', debitMinor: 800 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 800 },
    ] });

  let repair = repairs.openAndAssess(env.db, env.ctx, {
    kind: 'inventory_accounting_mismatch', symptom: 'Inventory and Accounting disagree after shipment',
    failedInvariant: 'Inventory value agrees with accounting',
    affectedRecords: { eventId: failed.domain_event_id },
  }).repairCase;
  assert.equal(repair.status, 'NEEDS_AUTHORITY');
  repair = repairs.approve(env.db, env.ctx, env.membership, repair.id);
  repair = repairs.execute(env.db, env.ctx, env.membership, repair.id).repairCase;
  assert.equal(repair.status, 'RESOLVED');
  assert.ok(repair.verification.checks.every((check) => check.passed));
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'sales_fulfillment'`).get(env.workspace.workspaceId).n, 1);
});

test('an unprovable mismatch remains inconclusive and never creates a correction', () => {
  const env = setup();
  const repair = repairs.openAndAssess(env.db, env.ctx, {
    kind: 'inventory_accounting_mismatch', symptom: 'Inventory and Accounting differ',
    failedInvariant: 'Inventory value agrees with accounting', affectedRecords: {},
  }).repairCase;
  assert.equal(repair.status, 'INCONCLUSIVE');
  assert.match(repair.errorMessage, /No exact failed operational event/i);
  assert.equal(repair.attempts, 0);
});

test('repair event history is immutable', () => {
  const env = setup();
  const event = events.publish(env.db, env.workspace.workspaceId, events.TYPES.TIME_REEVALUATION_DUE,
    {}, { idempotencyKey: 'immutable-case' }).event;
  const repair = repairs.open(env.db, env.ctx, { kind: 'duplicate_event', symptom: 'Replay',
    failedInvariant: 'One event', affectedRecords: { eventId: event.id } }).repairCase;
  assert.throws(() => env.db.prepare(`UPDATE repair_case_events SET event = 'changed'
    WHERE repair_case_id = ?`).run(repair.id), /immutable/);
});
