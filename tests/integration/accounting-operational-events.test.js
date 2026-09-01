'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const costing = require('../../src/accounting/costing');
const reports = require('../../src/accounting/reports');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const inventory = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const reactions = require('../../src/manager/reactions');
const connections = require('../../src/connections/service');
const ingestion = require('../../src/connections/event-ingestion');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Operational Accounting Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const product = makeQuantityItem(db, workspace.ctx, { name: 'Black Shirt' });
  return { db, workspace, membership, product };
}

test('an approved PO receipt posts inventory/AP and its physical movement is costed once', () => {
  const env = setup();
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'Shirt Supply', email: 'orders@shirts.example', currency: 'USD',
  });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: env.product.skuId, supplierSku: 'BLK-SHIRT',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 8,
  });
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.product.skuId, quantityUnits: 100, unitCost: 8 }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id);
  const result = receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: 'accounting-receipt-1',
    lines: [{ lineId: order.lines[0].id, quantityUnits: 100 }],
  });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);

  const accountingEvent = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'purchase_order.completed'`)
    .get(env.workspace.workspaceId);
  assert.equal(accountingEvent.status, 'POSTED', accountingEvent.error_message);
  const entry = ledger.getEntry(env.db, env.workspace.workspaceId, accountingEvent.journal_entry_id);
  assert.equal(entry.lines.reduce((sum, line) => sum + line.debit_minor, 0), 80_000);
  assert.equal(entry.lines.reduce((sum, line) => sum + line.credit_minor, 0), 80_000);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalUnits, 100);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 80_000);
  assert.equal(result.receipt.id, entry.source_record_id);

  // Re-draining/replaying cannot duplicate the receipt or accounting.
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'purchase_receipt'`).get(env.workspace.workspaceId).n, 1);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_inventory_cost_movements
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 1);
});

test('fulfillment posts AR/revenue/tax and exact weighted-average COGS without changing stock twice', () => {
  const env = setup();
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.product.skuId, amount: '20.00', currency: 'USD' });
  const stock = inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.product.skuId, locationId: env.workspace.main.id, quantity: 100,
    reference: 'OPENING', occurredAt: '2026-01-01',
  });
  costing.receive(env.db, env.workspace.ctx, {
    movementIds: stock.movementIds, unitCostMinor: 800,
    sourceType: 'opening_balance', sourceRecordId: 'opening-stock',
  });
  ledger.post(env.db, env.workspace.ctx, {
    postingDate: '2026-01-01', description: 'Opening inventory', sourceKey: 'opening-stock',
    lines: [
      { accountKey: 'INVENTORY_ASSET', debitMinor: 80_000 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 80_000 },
    ],
  });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Town School', fulfillmentLocationId: env.workspace.main.id,
    discount: '20.00', tax: '38.00',
    lines: [{ skuId: env.product.skuId, quantity: 20 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  order = sales.fulfill(env.db, env.workspace.ctx, order.id, { lines: [{
    lineId: order.lines[0].id, locationId: env.workspace.main.id, quantity: 20,
  }] }, { idempotencyKey: 'accounting-sale-1' });

  assert.equal(order.status, 'FULFILLED');
  const accountingEvent = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled'`)
    .get(env.workspace.workspaceId);
  assert.equal(accountingEvent.status, 'POSTED', accountingEvent.error_message);
  const entry = ledger.getEntry(env.db, env.workspace.workspaceId, accountingEvent.journal_entry_id);
  assert.equal(entry.metadata.grossMinor, 40_000);
  assert.equal(entry.metadata.discountMinor, 2_000);
  assert.equal(entry.metadata.taxMinor, 3_800);
  assert.equal(entry.metadata.revenueMinor, 38_000);
  assert.equal(entry.metadata.cogsMinor, 16_000);
  assert.equal(entry.lines.find((line) => line.account_code === '1100').debit_minor, 41_800);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalUnits, 80);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 64_000);
  const pnl = reports.profitAndLoss(env.db, env.workspace.workspaceId, {
    from: '2026-01-01', to: '2026-12-31',
  });
  assert.equal(pnl.revenueMinor, 38_000);
  assert.equal(pnl.cogsMinor, 16_000);
  assert.equal(pnl.grossProfitMinor, 22_000);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue'`).get(env.workspace.workspaceId).n, 1);
});

test('missing cost evidence becomes reviewable and never invents a journal entry', () => {
  const env = setup();
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.product.skuId, amount: '20.00', currency: 'USD' });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.product.skuId, locationId: env.workspace.main.id, quantity: 1,
  });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Town School', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: env.product.skuId, quantity: 1 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  sales.fulfill(env.db, env.workspace.ctx, order.id, {}, { idempotencyKey: 'uncosted-sale' });
  const accountingEvent = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled'`)
    .get(env.workspace.workspaceId);
  assert.equal(accountingEvent.status, 'NEEDS_REVIEW');
  assert.match(accountingEvent.error_message, /cost was established|inventory movement/i);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 0);
});

test('a direct connector sale and physical return post once from provider evidence', () => {
  const env = setup();
  const opening = inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.product.skuId, locationId: env.workspace.main.id, quantity: 10,
    reference: 'connector-opening', occurredAt: '2026-01-01',
  });
  costing.receive(env.db, env.workspace.ctx, { movementIds: opening.movementIds,
    unitCostMinor: 800, sourceType: 'opening_balance', sourceRecordId: 'connector-opening' });
  ledger.post(env.db, env.workspace.ctx, { postingDate: '2026-01-01',
    description: 'Opening connector stock', sourceKey: 'connector-opening-ledger',
    lines: [{ accountKey: 'INVENTORY_ASSET', debitMinor: 8_000 },
      { accountKey: 'OPENING_BALANCE_EQUITY', creditMinor: 8_000 }] });
  const created = connections.create(env.db, env.workspace.ctx, env.membership, {
    providerType: 'reference_webhook', displayName: 'Test POS', expectedIntervalMinutes: 60,
  });
  const auth = { connectorId: created.connection.id, workspaceId: env.workspace.workspaceId,
    actorId: env.workspace.ownerId, accountId: env.workspace.accountId,
    providerType: created.connection.provider_type, displayName: created.connection.display_name };
  const sale = { eventId: 'direct-sale-1', type: 'sale.completed',
    occurredAt: '2026-01-10T12:00:00.000Z', data: { skuId: env.product.skuId,
      locationId: env.workspace.main.id, quantity: 2, unitPriceMinor: 2_000,
      taxMinor: 200, settlement: 'paid' } };
  assert.equal(ingestion.ingest(env.db, auth, sale).accepted, true);
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  let entries = env.db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'connector_sale'`).all(env.workspace.workspaceId);
  assert.equal(entries.length, 1);
  assert.equal(ledger.getEntry(env.db, env.workspace.workspaceId, entries[0].id).metadata.cogsMinor, 1_600);
  assert.equal(ingestion.ingest(env.db, auth, sale).replayed, true);
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_type = 'connector_sale'`).get(env.workspace.workspaceId).n, 1);

  assert.equal(ingestion.ingest(env.db, auth, { eventId: 'direct-return-1', type: 'return.completed',
    occurredAt: '2026-01-15T12:00:00.000Z', data: { skuId: env.product.skuId,
      locationId: env.workspace.main.id, quantity: 1, originalSaleEventId: 'direct-sale-1',
      revenueMinor: 2_000, taxMinor: 100 } }).accepted, true);
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM accounting_sale_refunds
    WHERE workspace_id = ?`).get(env.workspace.workspaceId).n, 1);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalUnits, 9);
  assert.equal(costing.valuation(env.db, env.workspace.workspaceId).totalCostMinor, 7_200);
  const pnl = reports.profitAndLoss(env.db, env.workspace.workspaceId, {
    from: '2026-01-01', to: '2026-01-31',
  });
  assert.equal(pnl.revenueMinor, 2_000);
  assert.equal(pnl.cogsMinor, 800);
  assert.equal(pnl.grossProfitMinor, 1_200);
});
