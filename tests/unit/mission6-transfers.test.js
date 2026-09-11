'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const transfers = require('../../src/transfers/transfer-service');
const inventory = require('../../src/domain/inventory-engine');
const costing = require('../../src/accounting/costing');
const ledger = require('../../src/accounting/ledger');
const accountingReports = require('../../src/accounting/reports');
const ownerDashboard = require('../../src/accounting/owner-dashboard');
const forecasting = require('../../src/forecasting/projection');
const sales = require('../../src/sales/sales-order-service');
const auth = require('../../src/domain/auth-service');
const permissions = require('../../src/actions/permissions');
const prices = require('../../src/pricing/price-service');
const needsYou = require('../../src/manager/needs-you-inbox');
const { openDatabase } = require('../../src/db');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeSerialItem, unitsFor } = require('../helpers');

test.after(cleanupAll);

function setup({ costed = false } = {}) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Priority Trainer' });
  const receipt = inventory.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 10,
  });
  if (costed) {
    ledger.configure(db, workspace.ctx, membership, {
      startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
    });
    costing.receive(db, workspace.ctx, { movementIds: receipt.movementIds,
      unitCostMinor: 100, sourceType: 'opening_balance', sourceRecordId: item.skuId });
    const equity = db.prepare(`SELECT id FROM accounting_accounts
      WHERE workspace_id = ? AND account_type = 'EQUITY' ORDER BY code LIMIT 1`).get(workspace.workspaceId);
    ledger.post(db, workspace.ctx, {
      sourceKey: `mission6-opening:${item.skuId}`, description: 'Mission 6 opening inventory value',
      sourceType: 'opening_balance', sourceRecordType: 'sku', sourceRecordId: item.skuId,
      lines: [{ accountKey: 'INVENTORY_ASSET', debitMinor: 1000 },
        { accountId: equity.id, creditMinor: 1000 }],
    });
  }
  return { db, workspace, membership, item };
}

function requested(env, quantity = 10) {
  return transfers.request(env.db, env.workspace.ctx, env.membership, {
    fromLocationId: env.workspace.main.id, toLocationId: env.workspace.store.id,
    expectedArrivalDate: '2026-09-12', lines: [{ skuId: env.item.skuId, quantity }],
  });
}

function dispatched(env, quantity = 10) {
  let transfer = requested(env, quantity);
  transfer = transfers.approve(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfer = transfers.pick(env.db, env.workspace.ctx, env.membership, transfer.id);
  return transfers.dispatch(env.db, env.workspace.ctx, env.membership, transfer.id);
}

test('request, approval and pick do not move stock; dispatch creates custody once', () => {
  const env = setup();
  let transfer = requested(env, 6);
  assert.equal(transfer.status, 'REQUESTED');
  assert.equal(inventoryBalance(env, env.workspace.main.id), 10);
  assert.equal(inventoryBalance(env, env.workspace.store.id), 0);

  transfer = transfers.approve(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfer = transfers.pick(env.db, env.workspace.ctx, env.membership, transfer.id);
  assert.equal(inventoryBalance(env, env.workspace.main.id), 10);

  transfer = transfers.dispatch(env.db, env.workspace.ctx, env.membership, transfer.id,
    { idempotencyKey: 'dispatch-browser-1' });
  assert.equal(transfer.status, 'SHIPPED');
  assert.equal(transfer.totals.inTransit, 6);
  assert.equal(inventoryBalance(env, env.workspace.main.id), 4);
  assert.equal(inventoryBalance(env, env.workspace.store.id), 0);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE group_id LIKE 'transfer:%'`).get().n, 1);

  const replay = transfers.dispatch(env.db, env.workspace.ctx, env.membership, transfer.id,
    { idempotencyKey: 'dispatch-browser-1' });
  assert.equal(replay.totals.inTransit, 6);
  assert.equal(inventoryBalance(env, env.workspace.main.id), 4);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE group_id LIKE 'transfer:%'`).get().n, 1);
  assert.equal(transfers.verify(env.db, env.workspace.workspaceId, transfer.id).ok, true);
});

test('partial receipt, loss and damage settle custody without over-receipt or duplicate effects', () => {
  const env = setup({ costed: true });
  let transfer = dispatched(env);
  transfer = transfers.markInTransit(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfer = transfers.receive(env.db, env.workspace.ctx, env.membership, transfer.id, {
    idempotencyKey: 'receipt-dock-1',
    lines: [{ lineId: transfer.lines[0].id, received: 6, lost: 1, damaged: 1 }],
  });
  assert.equal(transfer.status, 'PARTIALLY_RECEIVED');
  assert.deepEqual(transfer.totals, { requested: 10, approved: 10, picked: 10,
    shipped: 10, received: 6, lost: 1, damaged: 1, inTransit: 2 });
  assert.equal(inventoryBalance(env, env.workspace.store.id), 6);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 800);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).inTransitCostMinor, 200);
  const owned = ownerDashboard.ownerDashboard(env.db, env.workspace.workspaceId, {
    from: '2026-01-01', to: '2026-12-31', asOf: '2026-12-31',
  }).inventory;
  assert.equal(owned.totalUnits, 8);
  assert.equal(owned.inTransitUnits, 2);
  assert.equal(owned.totalCostMinor, 800);
  assert.equal(accountingReports.inventoryReconciliation(env.db, env.workspace.workspaceId,
    { asOf: '2026-12-31' }).reconciled, true);

  assert.throws(() => transfers.receive(env.db, env.workspace.ctx, env.membership, transfer.id, {
    idempotencyKey: 'receipt-over', lines: [{ lineId: transfer.lines[0].id, received: 3 }],
  }), /over-receive.*2 remain in transit/i);
  assert.equal(inventoryBalance(env, env.workspace.store.id), 6);

  const replay = transfers.receive(env.db, env.workspace.ctx, env.membership, transfer.id, {
    idempotencyKey: 'receipt-dock-1',
    lines: [{ lineId: transfer.lines[0].id, received: 6, lost: 1, damaged: 1 }],
  });
  assert.equal(replay.totals.received, 6);

  transfer = transfers.receive(env.db, env.workspace.ctx, env.membership, transfer.id, {
    idempotencyKey: 'receipt-dock-2', lines: [{ lineId: transfer.lines[0].id, received: 2 }],
  });
  assert.equal(transfer.status, 'RECEIVED');
  assert.equal(transfer.totals.inTransit, 0);
  assert.equal(inventoryBalance(env, env.workspace.store.id), 8);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).inTransitCostMinor, 0);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 800);
  assert.equal(transfers.verify(env.db, env.workspace.workspaceId, transfer.id).ok, true);

  const transit = ledger.accountBySystemKey(env.db, env.workspace.workspaceId, 'INVENTORY_IN_TRANSIT');
  const balance = env.db.prepare(`SELECT COALESCE(SUM(debit_minor-credit_minor),0) AS n
    FROM accounting_journal_lines WHERE account_id = ?`).get(transit.id).n;
  assert.equal(balance, 0, 'ordinary receipt plus explicit write-off must fully clear in-transit value');
});

test('a transfer may be cancelled before dispatch but never erases shipped custody', () => {
  const env = setup();
  let transfer = requested(env, 3);
  transfer = transfers.approve(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfer = transfers.cancel(env.db, env.workspace.ctx, env.membership, transfer.id, { reason: 'No longer needed' });
  assert.equal(transfer.status, 'CANCELLED');
  assert.equal(inventoryBalance(env, env.workspace.main.id), 10);

  const shipped = dispatched(env, 2);
  assert.throws(() => transfers.cancel(env.db, env.workspace.ctx, env.membership, shipped.id),
    /cannot be cancelled.*receipt, loss, or damage/i);
  assert.equal(transfers.get(env.db, env.workspace.workspaceId, shipped.id).totals.inTransit, 2);
});

test('transfer permissions separate request, approval, dispatch and receipt', () => {
  const env = setup();
  const staffAccount = auth.authenticate(env.db, env.workspace.staffEmail, 'password123');
  const staff = auth.getMembership(env.db, env.workspace.workspaceId, staffAccount.id);
  assert.equal(permissions.can(staff, permissions.REQUEST_TRANSFER), true);
  assert.equal(permissions.can(staff, permissions.APPROVE_TRANSFER), false);
  const transfer = transfers.request(env.db,
    { workspaceId: env.workspace.workspaceId, actorId: env.workspace.staffId, accountId: staffAccount.id },
    staff, { fromLocationId: env.workspace.main.id, toLocationId: env.workspace.store.id,
      lines: [{ skuId: env.item.skuId, quantity: 1 }] });
  assert.throws(() => transfers.approve(env.db,
    { workspaceId: env.workspace.workspaceId, actorId: env.workspace.staffId }, staff, transfer.id),
    /permission to approve/i);

  let shipped = transfers.approve(env.db, env.workspace.ctx, env.membership, transfer.id);
  shipped = transfers.pick(env.db, env.workspace.ctx, env.membership, shipped.id);
  shipped = transfers.dispatch(env.db, env.workspace.ctx, env.membership, shipped.id);
  assert.throws(() => transfers.receive(env.db,
    { workspaceId: env.workspace.workspaceId, actorId: env.workspace.staffId }, staff, shipped.id, {
      idempotencyKey: 'staff-writeoff-denied',
      lines: [{ lineId: shipped.lines[0].id, received: 0, lost: 1, damaged: 0 }],
    }), /permission to record transfer loss or damage/i);
  assert.equal(transfers.get(env.db, env.workspace.workspaceId, shipped.id).totals.inTransit, 1);
});

test('a requested transfer becomes one permission-valid Needs You decision', () => {
  const env = setup();
  const transfer = requested(env, 2);
  const ownerEntry = needsYou.inbox(env.db, env.workspace.workspaceId, env.membership)
    .find((entry) => entry.id === `transfer:${transfer.id}`);
  assert.equal(ownerEntry.actionLabel, 'Approve the transfer');
  assert.equal(ownerEntry.href, `/transfers/${transfer.id}`);
  assert.match(ownerEntry.happened, /No stock has moved/i);

  const staffAccount = auth.authenticate(env.db, env.workspace.staffEmail, 'password123');
  const staff = auth.getMembership(env.db, env.workspace.workspaceId, staffAccount.id);
  assert.equal(needsYou.inbox(env.db, env.workspace.workspaceId, staff)
    .some((entry) => entry.id === `transfer:${transfer.id}`), false);
});

test('forecasting sees destination-bound in-transit stock and transfer comparison explains its choice', () => {
  const env = setup();
  let transfer = requested(env, 4);
  env.db.prepare('UPDATE inventory_transfers SET expected_arrival_date = ? WHERE id = ?').run('2026-09-12', transfer.id);
  transfer = transfers.approve(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfer = transfers.pick(env.db, env.workspace.ctx, env.membership, transfer.id);
  transfers.dispatch(env.db, env.workspace.ctx, env.membership, transfer.id);
  const incoming = forecasting.incomingFor(env.db, env.workspace.workspaceId, env.item.skuId,
    { now: Date.parse('2026-09-10T12:00:00Z') });
  assert.equal(incoming.onOrder, 4);
  assert.equal(incoming.arrivals[0].source, 'INTERNAL_TRANSFER');

  const choice = transfers.compareTransferToPurchase(env.db, env.workspace.workspaceId, {
    skuId: env.item.skuId, fromLocationId: env.workspace.main.id, quantity: 3,
    transferDays: 2, purchaseDays: 12, transferCostMinor: 300, purchaseCostMinor: 900,
  });
  assert.equal(choice.choice, 'TRANSFER');
  assert.match(choice.reason, /expected in 2 days.*costs no more/i);
});

test('customer allocation priority is deterministic and higher priority can preempt ordinary demand', () => {
  const env = setup();
  // Only five units are at the destination. The remaining five are at source
  // and deliberately irrelevant to this location-specific promise.
  inventory.issue(env.db, env.workspace.ctx, { skuId: env.item.skuId,
    locationId: env.workspace.main.id, quantity: 5, reasonCode: 'used' });
  inventory.transfer(env.db, env.workspace.ctx, { skuId: env.item.skuId,
    fromLocationId: env.workspace.main.id, toLocationId: env.workspace.store.id, quantity: 5 });
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.item.skuId, amountMinor: 1000, currency: 'USD' });
  const ordinary = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Ordinary customer', fulfillmentLocationId: env.workspace.store.id,
    allocationPriority: 200, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);
  const urgent = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Urgent customer', fulfillmentLocationId: env.workspace.store.id,
    allocationPriority: 10, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);
  assert.equal(ordinary.totals.allocated, 5);
  assert.equal(urgent.totals.backordered, 5);
  sales.reconcileForSkus(env.db, env.workspace.ctx, [env.item.skuId]);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, urgent.id).totals.allocated, 5);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, ordinary.id).totals.backordered, 5);
});

test('a destination transfer is pegged to exact customer shortages in priority order', () => {
  const env = setup();
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.item.skuId, amountMinor: 1000, currency: 'USD' });
  inventory.issue(env.db, env.workspace.ctx, { skuId: env.item.skuId,
    locationId: env.workspace.main.id, quantity: 10, reasonCode: 'used' });
  const ordinary = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Ordinary customer', fulfillmentLocationId: env.workspace.store.id,
    allocationPriority: 200, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);
  const urgent = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Urgent customer', fulfillmentLocationId: env.workspace.store.id,
    allocationPriority: 10, lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);
  const transfer = requested(env, 6);
  assert.equal(transfer.lines[0].pegs.length, 2);
  assert.equal(transfer.lines[0].pegs[0].order_number, urgent.order_number);
  assert.equal(Number(transfer.lines[0].pegs[0].quantity), 5);
  assert.equal(transfer.lines[0].pegs[1].order_number, ordinary.order_number);
  assert.equal(Number(transfer.lines[0].pegs[1].quantity), 1);
});

test('serialized units have one explicit custody outcome and are never in two locations', () => {
  const { db } = makeDatabase(); const workspace = seedWorkspace(db);
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeSerialItem(db, workspace.ctx, { name: 'Serialized Scanner' });
  inventory.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id,
    serials: [{ serial: 'SCAN-001' }, { serial: 'SCAN-002' }] });
  const unitIds = unitsFor(db, workspace.workspaceId, item.skuId).map((row) => row.id);
  let transfer = transfers.request(db, workspace.ctx, membership, {
    fromLocationId: workspace.main.id, toLocationId: workspace.store.id,
    lines: [{ skuId: item.skuId, quantity: 2, serialUnitIds: unitIds }],
  });
  transfer = transfers.approve(db, workspace.ctx, membership, transfer.id);
  transfer = transfers.pick(db, workspace.ctx, membership, transfer.id);
  transfer = transfers.dispatch(db, workspace.ctx, membership, transfer.id);
  assert.equal(unitsFor(db, workspace.workspaceId, item.skuId).every((row) => row.status === 'issued' && !row.location_id), true);
  transfer = transfers.receive(db, workspace.ctx, membership, transfer.id, {
    idempotencyKey: 'serial-receipt', lines: [{ lineId: transfer.lines[0].id,
      received: 1, lost: 1, receivedSerialUnitIds: [unitIds[0]], lostSerialUnitIds: [unitIds[1]] }],
  });
  const units = unitsFor(db, workspace.workspaceId, item.skuId);
  assert.equal(units.find((row) => row.id === unitIds[0]).location_id, workspace.store.id);
  assert.equal(units.find((row) => row.id === unitIds[1]).status, 'issued');
  assert.equal(transfer.status, 'RECEIVED');
  assert.equal(inventory.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('provable historic atomic transfers become completed legacy transfers without new movements', () => {
  const store = makeDatabase(); const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Legacy Stock' });
  inventory.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 4 });
  inventory.transfer(store.db, workspace.ctx, { skuId: item.skuId,
    fromLocationId: workspace.main.id, toLocationId: workspace.store.id, quantity: 3 });
  const before = store.db.prepare('SELECT COUNT(*) AS n FROM movements').get().n;
  store.db.close();
  let reopened;
  try { reopened = openDatabase(store.databasePath); }
  catch (error) { throw new Error(`Legacy reopen failed: ${error.message}\n${error.stack}`); }
  const legacy = reopened.prepare(`SELECT * FROM inventory_transfers WHERE workspace_id = ? AND legacy_group_id IS NOT NULL`).all(workspace.workspaceId);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].status, 'RECEIVED');
  assert.equal(reopened.prepare('SELECT COUNT(*) AS n FROM movements').get().n, before);
  reopened.close();
});

function inventoryBalance(env, locationId) {
  return Number(env.db.prepare(`SELECT COALESCE(on_hand,0) AS n FROM balances
    WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`)
    .get(env.workspace.workspaceId, env.item.skuId, locationId)?.n || 0);
}
