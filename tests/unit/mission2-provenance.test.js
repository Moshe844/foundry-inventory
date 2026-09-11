'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');
const auth = require('../../src/domain/auth-service');
const ledger = require('../../src/accounting/ledger');
const payables = require('../../src/accounting/payables');
const payments = require('../../src/accounting/payments');
const suppliers = require('../../src/purchasing/supplier-service');
const purchaseOrders = require('../../src/purchasing/po-service');
const receiving = require('../../src/purchasing/receiving-service');
const prices = require('../../src/pricing/price-service');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const graph = require('../../src/provenance/service');
const presenter = require('../../src/provenance/presenter');
const workItems = require('../../src/autopilot/work-items');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'One Business Story Co' });
  const membership = auth.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Shirt' });
  const supplier = suppliers.createSupplier(db, workspace.ctx, membership, { name: 'ABC Apparel' });
  suppliers.linkItem(db, workspace.ctx, membership, {
    supplierId: supplier.id, skuId: item.skuId, isPreferred: true,
    purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 10,
  });
  return { db, workspace, membership, item, supplier };
}

function purchaseAndReceive(env, quantity = 20) {
  let order = purchaseOrders.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantityUnits: quantity }],
  });
  order = purchaseOrders.approve(env.db, env.workspace.ctx, env.membership, order.id);
  const receipt = receiving.receive(env.db, env.workspace.ctx, env.membership, order.id, {
    idempotencyKey: `story-receipt:${order.id}`,
    receivedAt: '2026-02-01',
    lines: [{ lineId: order.lines[0].id, quantityUnits: quantity }],
  });
  return { order, receipt };
}

test('purchase, receipt, supplier bill and payment reconcile as one immutable evidence chain', () => {
  const env = setup();
  const { order, receipt } = purchaseAndReceive(env);
  const draft = payables.createDraft(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, purchaseOrderId: order.id,
    purchaseReceiptId: receipt.receipt.id, supplierInvoiceNumber: 'INV-20',
    issueDate: '2026-02-01', sourceKey: 'story:bill:20',
    lines: [{ description: '20 Black Shirts', quantity: 20, unitCostMinor: 1000,
      skuId: env.item.skuId, purchaseOrderLineId: order.lines[0].id }],
  });
  const bill = payables.open(env.db, env.workspace.ctx, env.membership, draft.bill.id);
  const paid = payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'SUPPLIER_PAYMENT', supplierId: env.supplier.id,
    paymentDate: '2026-02-02', amountMinor: 20_000, sourceKey: 'story:pay:20',
    allocations: [{ billId: bill.id, amountMinor: 20_000 }],
  }).payment;

  const traced = graph.trace(env.db, env.workspace.workspaceId,
    { type: 'purchase_order', id: order.id });
  const edges = new Set(traced.relations.map((row) =>
    `${row.relation_type}:${row.from_type}:${row.to_type}`));
  assert.ok(edges.has('RECEIVED_AS:purchase_order:purchase_receipt'));
  assert.ok(edges.has('CAUSED_MOVEMENT:purchase_receipt_line:inventory_movement'));
  assert.ok(edges.has('BILLED_BY:purchase_receipt:supplier_bill'));
  assert.ok(edges.has('PAID_BY:supplier_bill:payment'));
  assert.ok(edges.has('POSTED_AS:payment:journal_entry'));
  assert.equal(env.db.prepare('SELECT status FROM accounting_supplier_bills WHERE id = ?').get(bill.id).status, 'PAID');
  assert.equal(paid.amount_minor, 20_000);

  const orderNow = purchaseOrders.get(env.db, env.workspace.workspaceId, order.id);
  const receiptNow = receiving.receiptsFor(env.db, env.workspace.workspaceId, order.id);
  const billNow = payables.hydrate(env.db, env.workspace.workspaceId, bill.id);
  const story = presenter.purchaseOrderStory(env.db, env.workspace.workspaceId, orderNow, {
    receipts: receiptNow,
    supplierBills: [billNow],
    billSummary: { paidMinor: 20_000, owedMinor: 0 },
  }, { membership: env.membership });
  const ownerWords = story.ownerSteps.map((step) => `${step.label}: ${step.text}`).join(' ');
  assert.match(ownerWords, /Purchase order: .*ordered 20 units from ABC Apparel for \$200\.00/);
  assert.match(ownerWords, /Inventory received: 20 units were physically received and counted at Main Warehouse/);
  assert.match(ownerWords, /Supplier bill: INV-20 billed \$200\.00 for this purchase/);
  assert.match(ownerWords, /Supplier payment: You paid \$200\.00 and now owe \$0\.00/);
  assert.ok(story.ownerSteps.every((step) => step.complete), 'every displayed purchase step is proven');
  assert.doesNotMatch(ownerWords, /has event|received as|billed by|paid by/i);
  assert.equal(story.ownerSteps.find((step) => step.label === 'Inventory received').href,
    `/purchasing/orders/${order.id}/detail#receipts`);

  const relation = traced.relations[0];
  assert.throws(() => env.db.prepare('UPDATE business_relations SET metadata = ? WHERE id = ?')
    .run('{}', relation.id), /immutable/i);
  assert.throws(() => env.db.prepare('DELETE FROM business_relations WHERE id = ?')
    .run(relation.id), /cannot be deleted/i);
});

test('customer demand, fulfillment, invoice, payment, revenue and exact inventory cost reconcile', () => {
  const env = setup();
  purchaseAndReceive(env, 20);
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.item.skuId, amount: '25.00', currency: 'USD' });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'John Smith', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantity: 10 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  order = sales.fulfill(env.db, env.workspace.ctx, order.id, { lines: [{
    lineId: order.lines[0].id, locationId: env.workspace.main.id, quantity: 10,
  }] }, { idempotencyKey: `story-fulfill:${order.id}` });
  const invoice = env.db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ?`).get(env.workspace.workspaceId, order.id);
  assert.ok(invoice, 'fulfillment created the exact customer invoice');
  const firstReceipt = payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: order.customer.id,
    salesOrderId: order.id, paymentDate: '2026-02-03', amountMinor: 10_000,
    sourceKey: `story-customer-pay-1:${order.id}`,
    allocations: [{ invoiceId: invoice.id, amountMinor: 10_000 }],
  }).payment;
  const finalReceipt = payments.record(env.db, env.workspace.ctx, env.membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: order.customer.id,
    salesOrderId: order.id, paymentDate: '2026-02-04', amountMinor: invoice.total_minor - 10_000,
    sourceKey: `story-customer-pay-2:${order.id}`,
    allocations: [{ invoiceId: invoice.id, amountMinor: invoice.total_minor - 10_000 }],
  }).payment;

  const explanation = presenter.explainWhy(env.db, env.workspace.workspaceId,
    { type: 'sales_order', id: order.id }, { membership: env.membership });
  const edges = new Set(explanation.details.map((row) => `${row.relation}:${row.from.type}:${row.to.type}`));
  assert.ok(edges.has('FULFILLED_BY:sales_order:sales_order_event'));
  assert.ok(edges.has('CAUSED_MOVEMENT:sales_order_event:inventory_movement'));
  assert.ok(edges.has('BILLED_BY:sales_order:customer_invoice'));
  assert.ok(edges.has('PAID_BY:customer_invoice:payment'));
  assert.ok(edges.has('POSTED_AS:sales_order_event:journal_entry'));
  assert.match(explanation.summary, /Customer demand.*Fulfillment.*Customer invoice.*Customer payment.*Revenue and product cost recorded/);
  const journal = env.db.prepare(`SELECT metadata FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_record_type = 'sales_order_event'`).get(env.workspace.workspaceId);
  const amounts = JSON.parse(journal.metadata);
  assert.equal(amounts.revenueMinor, 25_000);
  assert.equal(amounts.cogsMinor, 10_000);

  const ownerStory = presenter.salesOrderStory(env.db, env.workspace.workspaceId, order, {
    money: { currency: 'USD', paidMinor: invoice.total_minor, remainingMinor: 0 },
    customerReceipts: [firstReceipt, finalReceipt],
    accounting: { status: 'POSTED', journal_entry_id: journal.id, outcome: amounts },
  }, { membership: env.membership });
  const paymentSteps = ownerStory.ownerSteps.filter((step) => step.label === 'Customer payment');
  assert.equal(paymentSteps.length, 2, 'each payment has its own evidence step and receipt link');
  assert.match(paymentSteps[0].text, /\$100\.00/);
  assert.match(paymentSteps[1].text, /\$150\.00/);
  assert.equal(paymentSteps[0].href, `/orders/${order.id}/receipt/${firstReceipt.id}`);
  assert.equal(paymentSteps[1].href, `/orders/${order.id}/receipt/${finalReceipt.id}`);
  assert.match(ownerStory.ownerSteps.at(-1).text, /paid \$250\.00 in total and now owes \$0\.00/);
});

test('a shipped box is linked to its exact inventory movement and presented as an owner story', () => {
  const env = setup();
  purchaseAndReceive(env, 10);
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.item.skuId, amount: '25.00', currency: 'USD' });
  let order = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Human Reader', fulfillmentLocationId: env.workspace.main.id,
    deliveryMethod: 'SHIP',
    lines: [{ skuId: env.item.skuId, quantity: 2 }],
  });
  order = sales.confirm(env.db, env.workspace.ctx, order.id);
  let shipment = shipments.startPicking(env.db, env.workspace.ctx, order.id);
  shipment = shipments.markPacked(env.db, env.workspace.ctx, shipment.id);
  shipment = shipments.ship(env.db, env.workspace.ctx, shipment.id);
  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);

  const trace = graph.trace(env.db, env.workspace.workspaceId, { type: 'sales_order', id: order.id });
  const edges = new Set(trace.relations.map((row) =>
    `${row.relation_type}:${row.from_type}:${row.to_type}`));
  assert.ok(edges.has('FULFILLED_BY:sales_order:shipment'));
  assert.ok(edges.has('CAUSED_MOVEMENT:shipment:inventory_movement'));

  const journal = env.db.prepare(`SELECT * FROM accounting_journal_entries
    WHERE workspace_id = ? AND source_record_type = 'sales_order_event'
    ORDER BY created_at DESC LIMIT 1`).get(env.workspace.workspaceId);
  const invoice = env.db.prepare(`SELECT * FROM accounting_customer_invoices
    WHERE workspace_id = ? AND sales_order_id = ?`).get(env.workspace.workspaceId, order.id);
  const story = presenter.salesOrderStory(env.db, env.workspace.workspaceId, order, {
    shipments: [shipment],
    money: { currency: 'USD', paidMinor: 0, remainingMinor: invoice.total_minor },
    accounting: { status: 'POSTED', journal_entry_id: journal.id, outcome: JSON.parse(journal.metadata) },
  }, { membership: env.membership });
  const words = story.ownerSteps.map((step) => step.text).join(' ');
  assert.match(words, /Human Reader ordered 2 units/);
  assert.match(words, /reserved 2 units from Main Warehouse/);
  assert.match(words, /moved 2 units from Main Warehouse out of on-hand stock/);
  assert.match(words, /\$50\.00 sale.*\$20\.00 product cost.*\$30\.00 gross profit/);
  assert.match(words, /still owes \$50\.00/);
  assert.doesNotMatch(words, /has event|fulfilled by fulfilled|posted to accounting as/);
});

test('a real customer shortage connects through Foundry supply work to receipt and fulfillment', () => {
  const env = setup();
  purchaseAndReceive(env, 12);
  prices.setPrice(env.db, env.workspace.ctx, { skuId: env.item.skuId, amount: '25.00', currency: 'USD' });
  let sale = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Demand Customer', fulfillmentLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantity: 20 }],
  });
  sale = sales.confirm(env.db, env.workspace.ctx, sale.id);
  assert.equal(sale.totals.backordered, 8);
  const trigger = env.db.prepare(`SELECT de.* FROM domain_events de
    JOIN sales_order_events se ON se.id = de.source_record_id
    WHERE de.workspace_id = ? AND se.sales_order_id = ? AND de.event_type = 'sales_order.confirmed'
    ORDER BY de.created_at DESC LIMIT 1`).get(env.workspace.workspaceId, sale.id);
  assert.ok(trigger);
  const work = workItems.upsert(env.db, env.workspace.workspaceId, {
    triggerEventId: trigger.id, category: 'replenishment_plan', source: 'replenishment',
    sourceEvidence: [
      { label: 'On hand', value: 12 },
      { label: 'Committed to customer orders', value: 12 },
      { label: 'Shortfall', value: 8 },
    ],
    affectedEntities: { skuId: env.item.skuId, displayName: 'Black Shirt' },
    recommendedAction: { actionType: 'replenishment_plan', orderUnits: 8 },
    executionStatus: workItems.STATUS.COMPLETED, verificationStatus: 'VERIFIED',
    approvalRequirement: 'REQUIRED', idempotencyKey: `story-shortage:${sale.id}`,
  }).item;
  let supply = purchaseOrders.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, destinationLocationId: env.workspace.main.id,
    source: 'foundry_recommendation', sourceDetail: { workItemId: work.id,
      customerDemand: [{ orderId: sale.id, orderNumber: sale.order_number,
        customerName: sale.customer.name, skuId: env.item.skuId,
        displayName: 'Black Shirt', waitingQuantity: 8 }] },
    lines: [{ skuId: env.item.skuId, quantityUnits: 8 }],
  });
  supply = purchaseOrders.approve(env.db, env.workspace.ctx, env.membership, supply.id);
  const supplied = receiving.receive(env.db, env.workspace.ctx, env.membership, supply.id, {
    idempotencyKey: `story-supply-receipt:${supply.id}`,
    lines: [{ lineId: supply.lines[0].id, quantityUnits: 8 }],
  });
  sales.reconcileForSkus(env.db, env.workspace.ctx, [env.item.skuId], {
    triggerEventId: env.db.prepare(`SELECT id FROM domain_events WHERE workspace_id = ?
      AND source_record_type = 'purchase_order_receipt' AND source_record_id = ?`)
      .get(env.workspace.workspaceId, supplied.receipt.id).id,
  });
  sale = sales.getOrder(env.db, env.workspace.workspaceId, sale.id);
  assert.equal(sale.totals.backordered, 0);
  const linkedStory = presenter.salesOrderStory(env.db, env.workspace.workspaceId, sale, {
    shipments: [], customerReceipts: [],
    money: { currency: 'USD', paidMinor: 0, remainingMinor: 0 },
  }, { membership: env.membership });
  const linkedWords = linkedStory.ownerSteps.map((step) => `${step.label}: ${step.text}`).join(' ');
  assert.match(linkedWords, /Stock reserved: Foundry reserved 12 units.*8 units were still waiting for stock/);
  assert.match(linkedWords, /Supply arranged: .*ordered 8 units of Black Shirt from ABC Apparel.*linked to the 8 units this customer was waiting for/);
  assert.match(linkedWords, /Stock arrived: 8 units were physically received/);
  assert.match(linkedWords, /Reservation rechecked: .*no longer short/);
  sales.fulfill(env.db, env.workspace.ctx, sale.id, { lines: sale.lines[0].allocations.map((allocation) => ({
    lineId: sale.lines[0].id, locationId: allocation.location_id, quantity: allocation.quantity,
  })) }, { idempotencyKey: `story-shortage-fulfill:${sale.id}` });

  const traced = graph.trace(env.db, env.workspace.workspaceId, { type: 'sales_order', id: sale.id });
  const nodes = new Set(traced.relations.flatMap((row) => [row.from_type, row.to_type]));
  assert.ok(nodes.has('work_item'), 'the shortage decision is in the same story');
  assert.ok(nodes.has('purchase_order'), 'the resulting supply order is in the same story');
  assert.ok(nodes.has('purchase_receipt'), 'the supply arrival is in the same story');
  assert.ok(nodes.has('inventory_movement'), 'exact inbound and outbound stock evidence is in the story');
  assert.ok(nodes.has('customer_invoice'), 'fulfillment reaches revenue/receivable in the same story');
  const why = presenter.explainWhy(env.db, env.workspace.workspaceId,
    { type: 'purchase_order', id: supply.id }, { membership: env.membership });
  assert.match(why.why, /On hand 12.*Committed to customer orders 12.*Shortfall 8/);
});

test('unprovable history stays unknown and tenant/accounting permissions filter the graph', () => {
  const env = setup();
  const first = purchaseAndReceive(env, 2);
  const second = purchaseAndReceive(env, 3);
  const trace = graph.trace(env.db, env.workspace.workspaceId,
    { type: 'purchase_order', id: first.order.id });
  assert.equal(trace.relations.some((row) => row.from_id === second.order.id || row.to_id === second.order.id), false,
    'similar nearby activity is not linked by time, supplier, SKU or amount');

  const story = presenter.forRecord(env.db, env.workspace.workspaceId,
    { type: 'purchase_order', id: first.order.id }, { membership: { role: 'staff', permissions: null } });
  assert.equal(story.details.some((row) => ['supplier_bill','payment','journal_entry'].includes(row.from.type)
    || ['supplier_bill','payment','journal_entry'].includes(row.to.type)), false);

  const unsupportedClaim = purchaseOrders.createOrder(env.db, env.workspace.ctx, env.membership, {
    supplierId: env.supplier.id, destinationLocationId: env.workspace.main.id,
    lines: [{ skuId: env.item.skuId, quantityUnits: 1 }],
  });
  env.db.prepare("UPDATE purchase_orders SET status = 'RECEIVED' WHERE id = ?").run(unsupportedClaim.id);
  const unknown = presenter.forRecord(env.db, env.workspace.workspaceId,
    { type: 'purchase_order', id: unsupportedClaim.id }, { membership: env.membership });
  assert.ok(unknown.unknown.some((line) => /Inventory received.*not linked by available evidence/.test(line)),
    'a historical state with no provable source remains explicitly unknown');
});
