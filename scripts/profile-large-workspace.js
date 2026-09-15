'use strict';

const path = require('node:path');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, '..', 'data', 'foundry-inventory.db'), {
  readonly: true,
  fileMustExist: true,
});
db.pragma('query_only = ON');

const workspaceId = process.argv[2];
const itemId = process.argv[3];
if (!workspaceId) throw new Error('Pass a workspace id.');

function timed(label, fn) {
  const started = performance.now();
  let result;
  try {
    result = fn();
  } finally {
    console.log(`${label}: ${(performance.now() - started).toFixed(1)} ms`);
  }
  return result;
}

timed('inventory overview', () => require('../src/domain/inventory-query').overview(db, workspaceId));
timed('recent activity', () => require('../src/domain/activity-service').listActivity(db, workspaceId, { limit: 6 }));
timed('attention list', () => require('../src/attention/attention-engine').listAttention(db, workspaceId, { limit: 20 }));
timed('purchasing brief', () => require('../src/purchasing/brief-lines').purchasingBrief(db, workspaceId));
timed('purchasing brief stored', () => require('../src/purchasing/brief-lines').purchasingBrief(db, workspaceId, { storedOnly: true }));
timed('readiness summary', () => require('../src/manager/readiness').assess(db, workspaceId, { summaryOnly: true }));
const preparedInbox = timed('needs-you inbox', () => require('../src/manager/needs-you-inbox').inbox(db, workspaceId, null, { limit: 6 }));
timed('operator home with prepared inbox', () => require('../src/autopilot/presenter').operatorHome(
  db, workspaceId, { preparedInbox }
));
timed('guidance facts', () => require('../src/manager/guidance').facts(db, workspaceId));
timed('what happens next', () => require('../src/attention/whats-next').build(db, workspaceId));
timed('needs-you count', () => require('../src/attention/needs-you-count').countNeedsYou(db, workspaceId));
timed('home signature', () => {
  const tables = ['domain_events', 'work_items', 'attention_items', 'inventory_investigations', 'purchase_orders', 'sales_orders', 'sales_order_events', 'movements', 'accounting_journal_entries', 'accounting_payments', 'payment_requests'];
  return tables.map((table) => db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS last, COUNT(*) AS total FROM ${table} WHERE workspace_id = ?`).get(workspaceId));
});
timed('accounting dashboard', () => require('../src/accounting/owner-dashboard').ownerDashboard(db, workspaceId, { from: '2026-09-01', to: '2026-09-14', asOf: '2026-09-14' }));
for (const fn of ['customerBalances', 'confirmedOrderBalances', 'supplierBalances']) {
  timed(`accounting ${fn}`, () => require('../src/accounting/owner-dashboard')[fn](db, workspaceId, '2026-09-14'));
}
timed('profit and loss', () => require('../src/accounting/reports').profitAndLoss(db, workspaceId, { from: '2026-09-01', to: '2026-09-14' }));
timed('balance sheet', () => require('../src/accounting/reports').balanceSheet(db, workspaceId, { asOf: '2026-09-14' }));

const inboxService = require('../src/manager/needs-you-inbox');
for (const name of [
  'fromMigrations', 'fromPhysicalEvents', 'fromWorkItems', 'fromInvestigations',
  'fromRepairCases', 'fromAutonomousOperations', 'fromLearning', 'fromTransfers',
  'fromCorrections', 'fromImports', 'fromMailboxInventory', 'fromPolicies',
  'fromAutomationSuggestions', 'fromSalesOrders', 'fromPendingSupplierCommunications',
  'fromConnections', 'fromAccounting', 'fromCountsReturnsAndWaves', 'fromFindings',
  'fromBusinessConsistency',
]) {
  if (typeof inboxService[name] === 'function') timed(`inbox ${name}`, () => inboxService[name](db, workspaceId));
}

if (itemId) {
  const detail = timed('item detail base', () => require('../src/domain/item-service').getItemDetail(db, workspaceId, itemId));
  console.log(`item variants: ${detail.skus.length}`);
  timed('per-variant availability', () => {
    const service = require('../src/sales/sales-order-service');
    for (const sku of detail.skus) service.availabilityForSku(db, workspaceId, sku.id);
  });
  timed('per-variant on-order', () => {
    const service = require('../src/purchasing/position');
    for (const sku of detail.skus) service.onOrderForSku(db, workspaceId, sku.id);
  });
  timed('per-variant prices', () => {
    const service = require('../src/pricing/price-service');
    for (const sku of detail.skus) {
      service.currentForSku(db, workspaceId, sku.id);
      service.purchaseCostForSku(db, workspaceId, sku.id);
    }
  });
  timed('per-variant purchasing', () => {
    const policy = require('../src/purchasing/policy-service');
    const suppliers = require('../src/purchasing/supplier-service');
    for (const sku of detail.skus) {
      policy.effectivePolicy(db, workspaceId, sku.id);
      suppliers.suppliersForSku(db, workspaceId, sku.id);
    }
  });
  if (process.argv.includes('--planning')) timed('per-variant planning', () => {
    const service = require('../src/forecasting/planning-service');
    for (const sku of detail.skus) service.forSku(db, workspaceId, sku.id);
  });
}

db.close();
