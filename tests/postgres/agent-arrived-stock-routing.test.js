'use strict';

process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const assistant = require('../../src/assistant/postgres-service');
const agent = require('../../src/sales/agent-arrived-stock');
const catalog = require('../../src/domain/postgres-catalog-service');
const locations = require('../../src/domain/postgres-location-service');
const receipts = require('../../src/accounting/postgres-stock-receipt');
const kits = require('../../src/domain/postgres-kit-service');
const rotation = require('../../src/operations/postgres-stock-rotation');
const modes = require('../../src/autopilot/job-modes');
const autopilot = require('../../src/autopilot/postgres-service');
const action = 'sales_order.reserve_arrived';

async function fixture(t, plan = 'pro') {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t, { units: 1 });
  const { db, ctx, workflows } = f;
  await f.subscribe(plan);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1", [f.owner.accountId]);
  await autopilot.setMode(db, ctx, { role: 'owner' }, 'POLICY_AUTOMATED');
  await modes.save(db, ctx, 48, { mode: 'routine', revision: 0 });
  const warehouse = await locations.createLocation(db, ctx, { name: 'Annex dispatch', kind: 'warehouse' });
  async function item(code, options = {}) {
    return (await catalog.createItem(db, ctx, { name: code, baseCode: code, trackingMode: 'quantity', ...options })).skuIds[0];
  }
  async function order(lines, location = null) {
    const draft = await workflows.createSalesOrder(db, ctx, {
      customerId: 'fixture-customer', deliveryMethod: 'PICKUP', fulfillmentLocationId: location, idempotencyKey: randomUUID(),
      lines: lines.map(line => ({ unitPriceMinor: 1000, ...line })),
    });
    const current = await workflows.confirmSalesOrder(db, ctx, draft.salesOrderId, { idempotencyKey: randomUUID() });
    return { ...draft, ...current };
  }
  const receive = (skuId, quantity, locationId, reference, extra = {}) =>
    receipts.receive(db, ctx, { skuId, locationId, quantity, unitCost: '1.00', reference, idempotencyKey: randomUUID(), ...extra });
  async function prepare(order) {
    const result = await assistant.prepareAction(db, ctx, 'Reserve arrived stock', { action, recordReference: order.salesOrderId });
    return { ...result, proposal: await assistant.getProposal(db, ctx.workspaceId, result.proposal.id) };
  }
  const current = order => rotation.allocations(db, ctx, order.salesOrderId);
  const effects = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM movements WHERE workspace_id=$1) movements,
    (SELECT count(*)::int FROM sales_shipments WHERE workspace_id=$1) shipments,
    (SELECT count(*)::int FROM accounting_customer_invoices WHERE workspace_id=$1) invoices,
    (SELECT count(*)::int FROM accounting_payments WHERE workspace_id=$1) payments,
    (SELECT sum(total_cost_minor)::text FROM accounting_inventory_cost_balances WHERE workspace_id=$1) inventory_value`, [ctx.workspaceId])).rows[0];
  return { ...f, warehouse, item, order, receive, prepare, current, effects };
}

test('actual posted receipts fill a partially shipped order at two dispatch sites without shipping again', { timeout: 240000 }, async t => {
  const f = await fixture(t);
  const { db, ctx, location, warehouse } = f;
  const sku = await f.item('SHEET-M', { unitLabel: 'm', quantityPrecision: 3, quantityIncrement: '0.125' });
  await f.receive(sku, '0.375', location.id, 'initial stock');
  const order = await f.order([{ skuId: sku, quantity: '1.25' }]);
  assert.equal(order.status, 'BACKORDERED');
  await f.workflows.fulfillSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: randomUUID(),
    lines: [{ lineId: order.lineIds[0], locationId: location.id, quantity: '0.375' }] });
  await assert.rejects(f.prepare(order), /No eligible costed receipt/);
  const first = await f.receive(sku, '0.5', location.id, 'MAIN-ARRIVAL');
  const po = await f.workflows.createPurchaseOrder(db, ctx, { supplierId: 'fixture-supplier', destinationLocationId: warehouse.id,
    idempotencyKey: randomUUID(), lines: [{ skuId: sku, quantityPurchaseUnits: '0.75', unitCost: '1.00' }] });
  await f.workflows.approvePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
  await f.workflows.placePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID() });
  const second = await f.workflows.receivePurchaseOrder(db, ctx, po.purchaseOrderId, { idempotencyKey: randomUUID(),
    reference: 'ANNEX-ARRIVAL', lines: [{ lineId: po.lineIds[0], locationId: warehouse.id, quantity: '0.375' }] });
  assert.equal(second.status, 'PARTIALLY_RECEIVED');
  const before = await f.effects();
  const pending = await f.prepare(order);
  assert.deepEqual(new Set(pending.proposal.payload.quantities.flatMap(q => q.arrivals.map(a => a.movementId))),
    new Set([first.movementId, second.lines[0].movementId]));
  const queue = require('../../src/operations/postgres-job-queue');
  const handlers = require('../../src/operations/postgres-runtime-handlers').create();
  const routingKind = 'sales_order.route-receipt.v1';
  const job = await queue.processOne(db, handlers, { owner: 'arrival-test-worker', kinds: [routingKind] });
  assert.equal(job?.status, 'COMPLETED', JSON.stringify(job?.lastError));
  assert.equal(job.result.reserved, 1);
  assert.deepEqual(Object.fromEntries((await f.current(order)).map(a => [a.location_id, Number(a.quantity)])),
    { [location.id]: 0.5, [warehouse.id]: 0.375 });
  assert.deepEqual(await f.effects(), before);
  const replay = await queue.processOne(db, handlers, { owner: 'arrival-test-worker', kinds: [routingKind] });
  assert.equal(replay?.status, 'COMPLETED');
  assert.equal(replay.result.reserved, 0);
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 0);
  await assert.rejects(assistant.executeProposal(db, ctx, pending.proposal.id), /No eligible costed receipt|changed/);
  const row = (await db.query('SELECT status,fulfillment_location_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, order.salesOrderId])).rows[0];
  assert.deepEqual(row, { status: 'PARTIALLY_FULFILLED', fulfillment_location_id: null });
  await f.workflows.fulfillSalesOrder(db, ctx, order.salesOrderId, { idempotencyKey: randomUUID(),
    lines: [{ lineId: order.lineIds[0], locationId: warehouse.id, quantity: '0.375' },
      { lineId: order.lineIds[0], locationId: location.id, quantity: '0.5' }] });
  assert.equal((await f.current(order)).length, 0);
  const complete = (await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2', [ctx.workspaceId, order.salesOrderId])).rows[0];
  assert.equal(complete.status, 'FULFILLED');

  await f.subscribe('growth');
  const next = await f.order([{ skuId: sku, quantity: '0.875' }]);
  await f.receive(sku, '0.5', location.id, 'GROWTH-EXAMPLE-MAIN');
  await f.receive(sku, '0.375', warehouse.id, 'GROWTH-EXAMPLE-ANNEX');
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 0);
  const training = require('../../src/autopilot/draft-authority');
  const example = await f.prepare(next);
  await assert.rejects(training.save(db, ctx, example.proposal.id, { mode: 'save', revision: 0, maximum: '10.00' }), /complete|reviewed/i);
  await assistant.executeProposal(db, ctx, example.proposal.id);
  await training.save(db, ctx, example.proposal.id, { mode: 'save', revision: 0, maximum: '10.00' });
  const taught = await f.order([{ skuId: sku, quantity: '0.875' }]);
  await f.receive(sku, '0.5', location.id, 'GROWTH-REPEAT-MAIN');
  await f.receive(sku, '0.375', warehouse.id, 'GROWTH-REPEAT-ANNEX');
  const beforeTaught = await f.effects();
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 1);
  assert.equal((await f.current(taught)).length, 2);
  assert.deepEqual(await f.effects(), beforeTaught);
});

test('Custom routes measured batches, exact weighted serials and native kit components with receipt provenance', { timeout: 240000 }, async t => {
  const f = await fixture(t, 'enterprise');
  const { db, ctx, location, warehouse } = f;
  const lot = await f.item('ROLL-LOT', { trackingMode: 'lot', unitLabel: 'm', quantityPrecision: 3, quantityIncrement: '0.125' });
  const serial = await f.item('WEIGHED-SERIAL', { trackingMode: 'serial', unitLabel: 'piece',
    secondaryUnitLabel: 'kg', secondaryPrecision: 3, secondaryIncrement: '0.001' });
  const part = await f.item('ARRIVAL-PART', { trackingMode: 'serial' });
  const box = await f.item('ARRIVAL-BOX');
  const kit = await f.item('ARRIVAL-KIT');
  await kits.define(db, ctx, { kitSkuId: kit, components: [{ skuId: part, quantity: 1 }, { skuId: box, quantity: 2 }], stockBasis: 'components' });
  const o = await f.order([{ skuId: lot, quantity: '0.875' }, { skuId: serial, quantity: 2, secondaryQuantity: '5.125' }, { skuId: kit, quantity: 1 }]);
  await f.receive(lot, '0.5', location.id, 'BATCH-IN-1', { lotCode: 'ROLL-A' });
  await f.receive(lot, '0.375', warehouse.id, 'BATCH-IN-2', { lotCode: 'ROLL-B' });
  const unsuitable = await f.receive(serial, 1, location.id, 'WRONG-WEIGHT',
    { serials: ['WRONG-WEIGHT'], serialWeights: { 'WRONG-WEIGHT': '1.000' }, secondaryQuantity: '1.000' });
  const a = await f.receive(serial, 1, location.id, 'WEIGHT-IN-A',
    { serials: ['ACTUAL-A'], serialWeights: { 'ACTUAL-A': '2.001' }, secondaryQuantity: '2.001' });
  const b = await f.receive(serial, 1, warehouse.id, 'WEIGHT-IN-B',
    { serials: ['ACTUAL-B'], serialWeights: { 'ACTUAL-B': '3.124' }, secondaryQuantity: '3.124' });
  const partReceipt = await f.receive(part, 1, location.id, 'KIT-SERIAL', { serials: ['KIT-PART-A'] });
  const before = await f.effects();
  const first = await f.prepare(o);
  assert.match(first.proposal.summary, /Batch ROLL-A/);
  assert.match(first.proposal.summary, /Serial ACTUAL-B/);
  assert.match(first.proposal.summary, /3.124 kg/);
  const page = await f.browser.get('/actions/' + first.proposal.id).expect(200);
  assert.match(page.text, /Serial ACTUAL-B/);
  assert.match(page.text, /Annex dispatch/);
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 1);
  assert.deepEqual(await f.effects(), before);
  const active = await f.current(o);
  assert.deepEqual(active.filter(r => r.sku_id === serial).flatMap(r => r.rotation_selection.map(s => s.serialUnitId)).sort(),
    [a.serialUnitIds[0], b.serialUnitIds[0]].sort());
  assert(!active.some(r => r.rotation_selection.some(s => unsuitable.serialUnitIds.includes(s.serialUnitId))));
  assert.deepEqual(active.filter(r => r.sku_id === lot).map(r => [r.rotation_selection[0].lotCode, Number(r.quantity)]).sort(),
    [['ROLL-A', 0.5], ['ROLL-B', 0.375]]);
  assert.equal(active.filter(r => r.kind === 'kit').length, 1);
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 0);
  await f.receive(box, 2, warehouse.id, 'KIT-BOX-ARRIVAL');
  const beforeBox = await f.effects();
  const last = await f.prepare(o);
  const done = await assistant.executeProposal(db, ctx, last.proposal.id);
  assert.equal(done.result.kitAllocations.length, 1);
  assert.equal(done.result.allocations.length, 0);
  assert.equal((await assistant.executeProposal(db, ctx, last.proposal.id)).replayed, true);
  assert.deepEqual(await f.effects(), beforeBox);
  assert.equal((await f.current(o)).filter(r => r.kind === 'kit').length, 2);
  const status = (await db.query('SELECT status FROM sales_orders WHERE workspace_id=$1 AND id=$2', [ctx.workspaceId, o.salesOrderId])).rows[0];
  assert.equal(status.status, 'CONFIRMED');
  const kitLine = { lineId: o.lineIds[2], locationId: location.id, quantity: 1, kit: true };
  await assert.rejects(f.workflows.fulfillSalesOrder(db, ctx, o.salesOrderId, { idempotencyKey: randomUUID(), lines: [kitLine] }), /exact reserved/);
  const partKey = active.find(r => r.sku_id === part).allocation_id;
  const component = (await db.query('SELECT kit_component_id FROM sales_order_kit_allocations WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId, partKey])).rows[0];
  await f.workflows.fulfillSalesOrder(db, ctx, o.salesOrderId, { idempotencyKey: randomUUID(),
    lines: [{ ...kitLine, componentSelections: { [component.kit_component_id]: { [location.id]: { serialUnitIds: partReceipt.serialUnitIds } } } }] });
  assert.equal((await f.current(o)).filter(r => r.kind === 'kit').length, 0);

  const correctionSku = await f.item('COUNT-CORRECTION');
  const correctedOrder = await f.order([{ skuId: correctionSku, quantity: 2 }], location.id);
  await db.transaction(async c => {
    const adjustment = await require('../../src/domain/postgres-inventory-engine').adjustInTransaction(c, ctx, {
      skuId: correctionSku, locationId: location.id, countedQuantity: 1, reasonCode: 'found', idempotencyKey: randomUUID(),
    });
    await require('../../src/accounting/postgres-costing').receiveInTransaction(c, ctx, {
      movementId: adjustment.movementId, unitCostMinor: 0, sourceType: 'stock_count_adjustment',
    });
  });
  await assert.rejects(f.prepare(correctedOrder), /No eligible costed receipt/);
  const receipt = await f.receive(correctionSku, 1, location.id, 'ACTUAL-RECEIPT-AFTER-COUNT');
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 1);
  const [held] = await f.current(correctedOrder);
  assert.equal(Number(held.quantity), 1);
  assert.equal(held.rotation_selection[0].receiptMovementId, receipt.movementId);
  assert.equal((await agent.run(db, ctx.workspaceId)).reserved, 0);
});
