'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const ledger = require('../../src/accounting/ledger');
const operationalAccounting = require('../../src/accounting/operational-adapter');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const receivingService = require('../../src/purchasing/receiving-service');
const inventory = require('../../src/domain/inventory-engine');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const { newId, nowIso } = require('../../src/lib/util');
const authService = require('../../src/domain/auth-service');
const reactions = require('../../src/manager/reactions');
const { makeApp, cleanupAll, seedWorkspace, signIn, plain, csrfFrom, makeQuantityItem } = require('../helpers');

test.after(cleanupAll);

async function setup() {
  const env = makeApp();
  const workspace = seedWorkspace(env.db, { workspaceName: 'Accounting Web Co' });
  const agent = request.agent(env.app);
  await signIn(agent, workspace.account.email);
  return { ...env, workspace, agent,
    membership: authService.getMembership(env.db, workspace.workspaceId, workspace.accountId) };
}

function receivedBeforeAccounting(env, {
  quantity = 20, unitCost = 6.5, occurredAt = '2026-08-30T12:00:00.000Z', product: suppliedProduct = null,
} = {}) {
  const product = suppliedProduct || makeQuantityItem(env.db, env.workspace.ctx, { name: 'Verified Cost Shirt' });
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'Verified Supply', email: 'orders@verified.example', currency: 'USD',
  });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: product.skuId, supplierSku: 'VERIFY-SHIRT',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: unitCost,
  });
  let order = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: product.skuId, quantityUnits: quantity, unitCost }],
  });
  order = poService.approve(env.db, env.workspace.ctx, env.membership, order.id);
  const movement = inventory.receive(env.db, env.workspace.ctx, {
    skuId: product.skuId, locationId: env.workspace.main.id, quantity,
    reference: order.po_number, occurredAt,
  });
  const receiptId = newId('porc'); const now = nowIso();
  env.db.prepare(`INSERT INTO purchase_order_receipts
    (id, workspace_id, purchase_order_id, idempotency_key, received_by_user_id,
     received_at, movement_group_ids, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)`)
    .run(receiptId, env.workspace.workspaceId, order.id, `pre-accounting:${receiptId}`,
      env.workspace.ownerId, occurredAt, JSON.stringify([movement.groupId]), now);
  env.db.prepare(`INSERT INTO purchase_order_receipt_lines
    (id, workspace_id, receipt_id, purchase_order_line_id, sku_id, location_id,
     quantity_units, serials, movement_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`)
    .run(newId('porcl'), env.workspace.workspaceId, receiptId, order.lines[0].id,
      product.skuId, env.workspace.main.id, quantity, JSON.stringify(movement.movementIds), now);
  return { product, supplier, purchaseOrder: order, movement };
}

test('Accounting starts with automatic posting and keeps opening amounts in a separate migration path', async () => {
  const env = await setup();
  const page = await env.agent.get('/accounting').expect(200);
  const text = plain(page.text);
  assert.match(text, /Foundry.*A Keeper product.*Accounting Web Co.*Your business right now.*Up to date/i);
  assert.match(text, /Customers owe you.*You owe suppliers.*Customer cash received.*Cash paid to suppliers.*Inventory you own/i);
  assert.match(text, /What that means.*Show me the accounting details.*Where the product cost went.*What updates automatically/i);
  assert.doesNotMatch(text, /Every product currently in inventory|complete on-hand list/i);
  assert.match(text, /Orders, history, and accountant reports.*source records or formal reports/i);
  assert.match(page.text, /aria-current="page"[^>]*>[\s\S]*Accounting/);
  assert.equal(ledger.settings(env.db, env.workspace.workspaceId).enabled, true);
  const migration = await env.agent.get('/accounting/migration').expect(200);
  assert.match(plain(migration.text), /Accounting is already working automatically.*One-time migration only.*Migration step 1 of 3.*Migration step 2 of 3.*Migration step 3 of 3/i);
  assert.match(text, /No completed customer sale is recorded yet.*Cost of products still in stock.*0 units you still own/i);
});

test('the missing-cost action opens a focused product-cost screen instead of the full migration form', async () => {
  const env = await setup();
  const product = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Older stock without cost' });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: product.skuId, locationId: env.workspace.main.id, quantity: 8, reasonCode: 'opening',
  });

  const accountingPage = await env.agent.get('/accounting').expect(200);
  assert.match(accountingPage.text,
    /href="\/accounting\/migration\?focus=inventory-cost#inventory-costs"[^>]*>Add the missing cost/i);
  const focused = plain((await env.agent
    .get('/accounting/migration?focus=inventory-cost#inventory-costs').expect(200)).text);
  assert.match(focused, /Add the missing inventory cost.*Older stock without cost.*8.*Review these inventory costs/i);
  assert.doesNotMatch(focused, /Cash and bank accounts.*Customers owe you.*You owe suppliers/i);
});

test('Foundry automatically applies the proven PO portion when older stock has mixed cost evidence', async () => {
  const env = await setup();
  const product = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Mixed evidence shirt' });
  inventory.receive(env.db, env.workspace.ctx, { skuId: product.skuId,
    locationId: env.workspace.main.id, quantity: 80, reasonCode: 'opening',
    occurredAt: '2026-08-20T12:00:00.000Z' });
  inventory.issue(env.db, env.workspace.ctx, { skuId: product.skuId,
    locationId: env.workspace.main.id, quantity: 25, reasonCode: 'sold',
    occurredAt: '2026-08-21T12:00:00.000Z' });
  receivedBeforeAccounting(env, { product, quantity: 36, unitCost: 5,
    occurredAt: '2026-08-22T12:00:00.000Z' });

  const page = plain((await env.agent.get('/accounting').expect(200)).text);
  assert.match(page, /Inventory you own.*\$180\.00 recorded.*91 units physically in stock; cost is missing for 55/i);
  assert.match(page, /I need the original purchase cost for 55 units/i);
  const balance = env.db.prepare(`SELECT quantity_units,total_cost_minor
    FROM accounting_inventory_cost_balances WHERE workspace_id=? AND sku_id=? AND location_id=?`)
    .get(env.workspace.workspaceId, product.skuId, env.workspace.main.id);
  assert.deepEqual(balance, { quantity_units: 36, total_cost_minor: 18000 });
});

test('automatic setup carries forward exact PO receipt costs and a shipped Sales Order posts without manual amounts', async () => {
  const env = await setup();
  const stock = receivedBeforeAccounting(env, { quantity: 20, unitCost: 6.5 });
  prices.setPrice(env.db, env.workspace.ctx, { skuId: stock.product.skuId, amount: '10.00', currency: 'USD' });
  const setupPage = await env.agent.get('/accounting').expect(200);
  await env.agent.post('/accounting/setup/start').type('form').send({
    _csrf: csrfFrom(setupPage.text), startDate: '2026-08-31', currency: 'USD',
  }).expect(303);
  const openingCost = env.db.prepare(`SELECT * FROM accounting_inventory_cost_balances
    WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`)
    .get(env.workspace.workspaceId, stock.product.skuId, env.workspace.main.id);
  assert.equal(openingCost.quantity_units, 20);
  assert.equal(openingCost.total_cost_minor, 13_000);

  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Clear Workflow Customer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: stock.product.skuId, quantity: 7 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  order = sales.fulfill(env.db, env.workspace.ctx, order.id, {}, { idempotencyKey: 'verified-auto-sale' });
  const accounting = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled' ORDER BY created_at DESC LIMIT 1`)
    .get(env.workspace.workspaceId);
  assert.equal(accounting.status, 'POSTED', accounting.error_message || accounting.outcome);
  const entry = ledger.getEntry(env.db, env.workspace.workspaceId, accounting.journal_entry_id);
  assert.equal(entry.metadata.revenueMinor, 7_000);
  assert.equal(entry.metadata.cogsMinor, 4_550);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue'`).get(env.workspace.workspaceId).n, 1);
  const orderPage = await env.agent.get(`/sales/orders/${order.id}`).expect(200);
  assert.match(plain(orderPage.text), /Shipped.*Accounting updated automatically.*Revenue, the customer receivable, product cost, and inventory value/i);
  const dashboard = await env.agent.get('/accounting').expect(200);
  const dashboardText = plain(dashboard.text);
  assert.match(dashboardText, /No cash profit is proven yet.*Customers still owe you \$70\.00/i);
  assert.match(dashboardText, /Product cost recorded from later receipts.*\$130\.00.*Cost of products already sold.*\$45\.50/i);
  assert.match(dashboardText, /Cost of products still in stock.*\$84\.50.*13 units you still own/i);
  assert.match(dashboardText, /Customer sales completed.*\$70\.00.*Customer cash actually received.*\$0\.00.*Customers still need to pay you.*\$70\.00/i);
  assert.match(dashboardText, /Total cash paid out.*\$0\.00.*Cash paid specifically to suppliers.*\$0\.00/i);
  assert.match(dashboardText, /All recorded inventory cost.*\$130\.00.*Minus product cost already sold.*\$45\.50.*Product cost still in your inventory.*\$84\.50/i);
  assert.doesNotMatch(dashboardText, /Every product currently in inventory|If all current stock sells|Potential gross profit/i);
});

test('a legacy workspace automatically recovers exact PO cost evidence and never ships twice', async () => {
  const env = await setup();
  const stock = receivedBeforeAccounting(env, { quantity: 20, unitCost: 6.5 });
  prices.setPrice(env.db, env.workspace.ctx, { skuId: stock.product.skuId, amount: '10.00', currency: 'USD' });
  // Simulate a workspace activated before the verified-cost carry-forward fix.
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-08-31', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Legacy Review Customer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: stock.product.skuId, quantity: 7 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  order = sales.fulfill(env.db, env.workspace.ctx, order.id, {}, { idempotencyKey: 'verified-review-sale' });
  const review = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled' ORDER BY created_at DESC LIMIT 1`)
    .get(env.workspace.workspaceId);
  assert.equal(review.status, 'POSTED', review.error_message);
  const issueCount = env.db.prepare(`SELECT COUNT(*) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue'`).get(env.workspace.workspaceId).n;
  const entry = ledger.getEntry(env.db, env.workspace.workspaceId, review.journal_entry_id);
  assert.equal(entry.metadata.revenueMinor, 7_000);
  assert.equal(entry.metadata.cogsMinor, 4_550);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue'`).get(env.workspace.workspaceId).n, issueCount);
});

test('same-day verified receipt cost survives earlier legacy issues and the next sale posts automatically', async () => {
  const env = await setup();
  const stock = receivedBeforeAccounting(env, {
    quantity: 26, unitCost: 6.5, occurredAt: '2026-08-31T23:41:33.905Z',
  });
  prices.setPrice(env.db, env.workspace.ctx, {
    skuId: stock.product.skuId, amount: '18.99', currency: 'USD',
  });
  // This reproduces the live legacy sequence: Accounting was configured after
  // the PO receipt, and an older direct issue occurred before this Sales Order.
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-08-31', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  inventory.issue(env.db, env.workspace.ctx, {
    skuId: stock.product.skuId, locationId: env.workspace.main.id, quantity: 15,
    reasonCode: 'sold', occurredAt: '2026-08-31T23:52:48.427Z',
  });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Hendel', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: stock.product.skuId, quantity: 8 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  order = sales.fulfill(env.db, env.workspace.ctx, order.id, {}, {
    idempotencyKey: 'same-day-verified-cost-sale',
  });

  assert.equal(order.status, 'FULFILLED');
  const accounting = env.db.prepare(`SELECT * FROM accounting_event_inbox
    WHERE workspace_id = ? AND event_type = 'sales_order.fulfilled' ORDER BY created_at DESC LIMIT 1`)
    .get(env.workspace.workspaceId);
  assert.equal(accounting.status, 'POSTED', accounting.error_message);
  const entry = ledger.getEntry(env.db, env.workspace.workspaceId, accounting.journal_entry_id);
  assert.equal(entry.metadata.revenueMinor, 15_192);
  assert.equal(entry.metadata.cogsMinor, 5_200);
  const valuation = require('../../src/accounting/costing').valuation(env.db, env.workspace.workspaceId);
  assert.equal(valuation.totalUnits, 3);
  assert.equal(valuation.totalCostMinor, 1_950);
  assert.equal(env.db.prepare(`SELECT COUNT(*) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue'`).get(env.workspace.workspaceId).n, 2,
  'cost recovery and retry never move inventory again');

  const invoiceBefore = env.db.prepare(`SELECT id, subtotal_minor, total_minor, balance_minor
    FROM accounting_customer_invoices WHERE workspace_id = ? AND sales_order_id = ?`)
    .get(env.workspace.workspaceId, order.id);
  const linesBefore = env.db.prepare(`SELECT COUNT(*) AS n, SUM(quantity) AS units
    FROM accounting_customer_invoice_lines WHERE workspace_id = ? AND invoice_id = ?`)
    .get(env.workspace.workspaceId, invoiceBefore.id);
  const recognitionBefore = env.db.prepare(`SELECT fulfilled_units, gross_minor, net_receivable_minor
    FROM accounting_sales_recognition WHERE workspace_id = ? AND sales_order_id = ?`)
    .get(env.workspace.workspaceId, order.id);

  const replay = operationalAccounting.retry(env.db, env.workspace.workspaceId,
    accounting.domain_event_id);
  assert.equal(replay.status, 'POSTED');
  assert.equal(replay.outcome.replayed, true);
  assert.deepEqual(env.db.prepare(`SELECT id, subtotal_minor, total_minor, balance_minor
    FROM accounting_customer_invoices WHERE workspace_id = ? AND sales_order_id = ?`)
    .get(env.workspace.workspaceId, order.id), invoiceBefore);
  assert.deepEqual(env.db.prepare(`SELECT COUNT(*) AS n, SUM(quantity) AS units
    FROM accounting_customer_invoice_lines WHERE workspace_id = ? AND invoice_id = ?`)
    .get(env.workspace.workspaceId, invoiceBefore.id), linesBefore);
  assert.deepEqual(env.db.prepare(`SELECT fulfilled_units, gross_minor, net_receivable_minor
    FROM accounting_sales_recognition WHERE workspace_id = ? AND sales_order_id = ?`)
    .get(env.workspace.workspaceId, order.id), recognitionBefore);
  const balancedSummary = plain((await env.agent.get('/accounting').expect(200)).text);
  assert.match(balancedSummary, /Product cost recorded from later receipts.*\$169\.00/i);
  assert.match(balancedSummary, /Cost removed through earlier inventory activity.*\$97\.50/i);
  assert.match(balancedSummary, /All recorded inventory cost.*\$169\.00.*Minus product cost already sold.*\$52\.00.*Minus earlier inventory reductions.*\$97\.50.*Product cost still in your inventory.*\$19\.50/i);
});

test('all core reports and ledger drill-down render from posted entries', async () => {
  const env = await setup();
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const entry = ledger.post(env.db, env.workspace.ctx, {
    postingDate: '2026-01-01', description: 'Opening cash', sourceKey: 'http-opening',
    lines: [
      { accountKey: 'CASH', debitMinor: 10_000 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 10_000 },
    ],
  }).entry;
  for (const path of ['profit-and-loss', 'balance-sheet', 'cash-flow', 'trial-balance', 'general-ledger', 'inventory-valuation']) {
    const page = await env.agent.get(`/accounting/reports/${path}`).expect(200);
    assert.match(plain(page.text), /Ledger-backed report/i);
  }
  const detail = await env.agent.get(`/accounting/entries/${entry.id}`).expect(200);
  assert.match(plain(detail.text), /Posted journal entry.*Opening cash.*Debits?|Debit.*Credit.*Why this exists/i);
});

test('the complete accounting workspace is reachable and explains each control', async () => {
  const env = await setup();
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  ledger.post(env.db, env.workspace.ctx, {
    postingDate: '2026-01-01', description: 'Opening cash', sourceKey: 'workspace-opening',
    lines: [{ accountKey: 'CASH', debitMinor: 1000 },
      { accountKey: 'OWNERS_EQUITY', creditMinor: 1000 }],
  });
  const pages = [
    ['/accounting/transactions', /audit trail, not a routine data-entry screen/i],
    ['/accounting/chart', /control accounts are protected/i],
    ['/accounting/periods', /Closing locks the period/i],
    ['/accounting/banking', /bank activity proves money movement/i],
    ['/accounting/receivables/new', /Payment remains separate/i],
    ['/accounting/payables/new', /never changes physical inventory/i],
    ['/accounting/adjustments/new', /cannot be edited or deleted/i],
    ['/accounting/tax', /does not file or remit taxes/i],
  ];
  for (const [path, expected] of pages) {
    const page = await env.agent.get(path).expect(200);
    assert.match(plain(page.text), expected);
  }
});

test('routine accounting pages lead owners back to source workflows and progressively disclose manual fallbacks', async () => {
  const env = await setup();
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const receivablesPage = await env.agent.get('/accounting/receivables').expect(200);
  assert.match(plain(receivablesPage.text), /Create in Sales.*Invoices normally start with the customer order.*Manual exception/i);
  assert.match(receivablesPage.text, /href="\/sales\/new"/);
  const payablesPage = await env.agent.get('/accounting/payables').expect(200);
  assert.match(plain(payablesPage.text), /Open Purchasing.*Bills normally start with the supplier invoice or purchasing record.*Mission 13.*Manual exception/i);
  assert.match(payablesPage.text, /href="\/purchasing\/orders"/);
  const bankingPage = await env.agent.get('/accounting/banking').expect(200);
  assert.match(plain(bankingPage.text), /should not re-enter an amount.*Manual statement entry.*fallback/i);
});

test('an accountant can view books but a normal staff membership has no accounting access', async () => {
  const env = await setup();
  authService.createTeamMember(env.db, env.workspace.ctx, env.membership, {
    name: 'Ada Accountant', email: 'ada.books@example.test', password: 'accounting-password', role: 'accountant',
  });
  const accountant = request.agent(env.app);
  await signIn(accountant, 'ada.books@example.test', 'accounting-password');
  await accountant.get('/accounting').expect(200);
  const staff = request.agent(env.app);
  await signIn(staff, env.workspace.staffEmail);
  await staff.get('/accounting').expect(403);
});

test('owner accounting UI carries exact PO and Sales evidence through partial payments, refunds, credits, and drill-downs', async () => {
  const env = await setup();
  ledger.configure(env.db, env.workspace.ctx, env.membership, {
    startDate: '2026-09-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const product = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Owner Evidence Shirt' });
  prices.setPrice(env.db, env.workspace.ctx, { skuId: product.skuId, amount: '20.00', currency: 'USD' });
  const supplier = supplierService.createSupplier(env.db, env.workspace.ctx, env.membership, {
    name: 'Owner Evidence Supply', email: 'orders@owner-evidence.example', currency: 'USD',
  });
  supplierService.linkItem(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, skuId: product.skuId, supplierSku: 'OWNER-EVIDENCE-1',
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10,
  });
  let purchaseOrder = poService.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: product.skuId, quantityUnits: 10, unitCost: 10 }],
  });
  purchaseOrder = poService.approve(env.db, env.workspace.ctx, env.membership, purchaseOrder.id);
  receivingService.receive(env.db, env.workspace.ctx, env.membership, purchaseOrder.id, {
    idempotencyKey: 'owner-ui-receipt',
    lines: [{ lineId: purchaseOrder.lines[0].id, quantityUnits: 10 }],
  });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);

  const billForm = await env.agent
    .get(`/accounting/payables/new?purchaseOrderId=${purchaseOrder.id}`).expect(200);
  const billFormText = plain(billForm.text);
  assert.match(billFormText, new RegExp(`${purchaseOrder.poNumber}.*Owner Evidence Shirt.*10 units.*10\\.00`, 'i'));
  await env.agent.post('/accounting/payables').type('form').send({
    _csrf: csrfFrom(billForm.text), counterpartyId: supplier.id,
    purchaseOrderId: purchaseOrder.id, documentNumber: 'OE-INV-1', issueDate: '2026-09-01',
    description: 'Owner Evidence Shirt', quantity: '10', unitAmount: '10.00',
    skuId: product.skuId, purchaseOrderLineId: purchaseOrder.lines[0].id,
    paymentStatus: 'partially_paid', paymentAmount: '40.00', paymentDate: '2026-09-01',
    paymentReference: 'CHECK-40',
  }).expect(303);
  let bill = env.db.prepare(`SELECT * FROM accounting_supplier_bills
    WHERE workspace_id = ? AND supplier_invoice_number = 'OE-INV-1'`)
    .get(env.workspace.workspaceId);
  assert.equal(bill.status, 'PARTIALLY_PAID');
  assert.equal(bill.balance_minor, 6_000);

  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Owner Evidence Customer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: product.skuId, quantity: 5 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  sales.fulfill(env.db, env.workspace.ctx, order.id, {}, { idempotencyKey: 'owner-ui-sale' });
  reactions.drainWorkspace(env.db, env.workspace.workspaceId);
  let invoice = env.db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ?`).get(env.workspace.workspaceId, order.id);

  const ownerPage = await env.agent.get('/accounting?period=all_time').expect(200);
  const ownerText = plain(ownerPage.text);
  assert.match(ownerText, /Your business right now.*Customers owe you.*You owe suppliers.*Customer cash received.*Cash paid to suppliers.*Inventory you own/i);
  assert.match(ownerText, /Show what was bought.*Owner Evidence Shirt.*10.*\$10\.00.*\$100\.00/i);
  assert.match(ownerText, /Show what was sold.*Owner Evidence Shirt.*5.*\$20\.00.*Recorded cost \$50\.00.*Gross profit \$50\.00/i);
  assert.match(ownerText, /Show what I own.*5 units.*\$10\.00.*\$50\.00/i);

  await env.agent.post(`/accounting/receivables/${invoice.id}/payment`).type('form').send({
    _csrf: csrfFrom(ownerPage.text), paymentDate: '2026-09-01', amount: '40.00',
    reference: 'CUSTOMER-40', idempotencyKey: 'owner-ui-customer-partial', returnTo: '/accounting#customers',
  }).expect(303);
  invoice = env.db.prepare('SELECT * FROM accounting_customer_invoices WHERE id = ?').get(invoice.id);
  assert.equal(invoice.status, 'PARTIALLY_PAID');
  assert.equal(invoice.balance_minor, 6_000);

  const creditForm = await env.agent.get(`/accounting/supplier-credits/new?billId=${bill.id}`).expect(200);
  await env.agent.post('/accounting/supplier-credits').type('form').send({
    _csrf: csrfFrom(creditForm.text), billId: bill.id, amount: '5.00', creditDate: '2026-09-01',
    creditNumber: 'OE-CM-1', reason: 'Supplier allowance',
  }).expect(303);
  bill = env.db.prepare('SELECT * FROM accounting_supplier_bills WHERE id = ?').get(bill.id);
  assert.equal(bill.balance_minor, 5_500);

  const refundForm = await env.agent.get(`/accounting/refunds/new?invoiceId=${invoice.id}`).expect(200);
  const entryId = refundForm.text.match(/name="originalJournalEntryId" value="([^"]+)"/)[1];
  await env.agent.post('/accounting/refunds').type('form').send({
    _csrf: csrfFrom(refundForm.text), invoiceId: invoice.id, originalJournalEntryId: entryId,
    amount: '10.00', refundDate: '2026-09-01', refundFrom: 'cash', reference: 'Customer courtesy refund',
  }).expect(303);
  const finalPage = plain((await env.agent.get('/accounting?period=all_time').expect(200)).text);
  assert.match(finalPage, /Partially credited.*\$55\.00 owed.*OE-CM-1.*Supplier allowance/i);
  assert.match(finalPage, /Partially refunded.*\$60\.00 owed.*\$10\.00 refunded.*inventory unchanged/i);
});
