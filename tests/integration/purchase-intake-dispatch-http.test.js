'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const actions = require('../../src/actions/action-service');
const intent = require('../../src/actions/intent-service');
const auth = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const inventory = require('../../src/domain/inventory-engine');
const terms = require('../../src/sales/payment-terms');
const salesIntent = require('../../src/sales/sales-intent');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom, plain } = require('../helpers');
test.after(cleanupAll);
function setup() {
  const { db } = makeDatabase(); const w = seedWorkspace(db);
  const membership = auth.getMembership(db, w.workspaceId, w.accountId);
  const supplier = suppliers.createSupplier(db, w.ctx, membership, { name: 'Fixture Supplier' });
  const item = makeQuantityItem(db, w.ctx, { name: 'Existing fixture part', baseCode: 'OLD-PART' });
  prices.setPrice(db, w.ctx, { skuId: item.skuId, amount: '8.00' });
  inventory.receive(db, w.ctx, { skuId: item.skuId, locationId: w.main.id, quantity: 20 });
  return { db, w, membership, supplier, item };
}
function purchase(code, name, supplier) {
  return { lines: [intent.normaliseLine({ actionType: 'purchase', item: name, supplier, quantity: 6 })], clarifyingQuestion: '', unsupportedReason: '' };
}
function form(e, code, name) {
  return { confirm: 'add_and_draft', name, code, unitLabel: 'piece', trackingMode: 'quantity', supplier: e.supplier.name,
    quantity: '6', unitCost: '3.25', expectedDate: '2026-10-11', destinationLocationId: e.w.main.id, notes: 'Keep the stated delivery instructions.' };
}
function order(e, extra = {}) {
  return sales.confirm(e.db, e.w.ctx, sales.createOrder(e.db, e.w.ctx, {
    customerName: 'Dispatch Fixture', lines: [{ skuId: e.item.skuId, quantity: 2 }], ...extra,
  }).id);
}
test('new-product review preserves grounded purchasing details without inventing missing fields', async () => {
  const e = setup();
  const source = `Buy 6 new couplings SKU NX-Q19 from ${e.supplier.name}, deliver to 7 Example Lane by 10/21/2026. Track quantity.`;
  const parsed = purchase('NX-Q19', 'new couplings', e.supplier.name);
  Object.assign(parsed.lines[0], { purchaseExpectedDate: '2026-10-21', purchaseDateSource: 'by 10/21/2026',
    deliveryInstructions: 'deliver to 7 Example Lane', trackingMode: 'quantity', trackingSource: 'Track quantity' });
  const result = await actions.interpret(e.db, e.w.ctx, e.membership, source, { parsedIntent: parsed, previewOnly: true });
  assert.equal(result.continuation.product.expectedDate, '2026-10-21');
  assert.equal(result.continuation.product.notes, 'deliver to 7 Example Lane');
  assert.equal(result.continuation.product.trackingMode, 'quantity');
  assert.equal(result.continuation.product.unitLabel, '');
  Object.assign(parsed.lines[0], { purchaseDateSource: 'date nobody supplied', deliveryInstructions: 'Invented destination', trackingSource: 'invented tracking' });
  const rejected = await actions.interpret(e.db, e.w.ctx, e.membership, source, { parsedIntent: parsed, previewOnly: true });
  assert.equal(rejected.continuation.product.expectedDate, null);
  assert.equal(rejected.continuation.product.notes, '');
  assert.equal(rejected.continuation.product.trackingMode, '');
});

test('unseen SKU identities offer reviewed catalogue creation and continue to a draft without adding stock', async () => {
  const e = setup();
  for (const [code, name] of [['AB-X73', 'Novel coupling'], ['RP_9/green', 'New fabric accessory']]) {
    const source = `Buy 6 ${name} SKU: ${code} from ${e.supplier.name}`;
    const prepared = await actions.interpret(e.db, e.w.ctx, e.membership, source, { parsedIntent: purchase(code, name, e.supplier.name), previewOnly: true });
    assert.equal(prepared.continuation.kind, 'purchase_new_product');
    assert.equal(prepared.continuation.product.code, code);
    assert.equal(e.db.prepare('SELECT COUNT(*) n FROM skus WHERE code=?').get(code).n, 0);
    const before = e.db.prepare('SELECT COUNT(*) n FROM movements').get().n;
    const result = await actions.continueInterpretation(e.db, e.w.ctx, e.membership, prepared.continuation, form(e, code, name));
    assert.equal(result.kind, 'purchase_order'); assert.equal(result.order.status, 'DRAFT'); assert.equal(result.approvedByConfirmation, false);
    assert.equal(result.order.expectedDate, '2026-10-11'); assert.equal(result.order.destinationLocationId, e.w.main.id);
    assert.equal(result.order.lines[0].quantityUnits, 6); assert.equal(Number(result.order.lines[0].unitCost), 3.25);
    assert.equal(e.db.prepare('SELECT code FROM skus WHERE id=?').get(result.order.lines[0].skuId).code, code);
    assert.equal(e.db.prepare('SELECT COUNT(*) n FROM movements').get().n, before);
    await assert.rejects(actions.continueInterpretation(e.db, e.w.ctx, e.membership, prepared.continuation, form(e, code, name)), /now exists/);
  }
});
test('new-product intake refuses unconfirmed, incomplete and cross-inventory creation', async () => {
  const e = setup(); const code = 'NEW-Q71'; const name = 'Unseen fixture';
  const prepared = await actions.interpret(e.db, e.w.ctx, e.membership, `Buy 6 ${name} SKU ${code} from ${e.supplier.name}`, { parsedIntent: purchase(code, name, e.supplier.name) });
  assert.equal((await actions.continueInterpretation(e.db, e.w.ctx, e.membership, prepared.continuation, 'yes')).kind, 'question');
  await assert.rejects(actions.continueInterpretation(e.db, e.w.ctx, e.membership, prepared.continuation, { ...form(e, code, name), trackingMode: '' }), /tracking method/);
  await assert.rejects(actions.continueInterpretation(e.db, { ...e.w.ctx, workspaceId: 'other-workspace' }, e.membership, prepared.continuation, form(e, code, name)), /different inventory/);
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM skus WHERE code=?').get(code).n, 0);
});
test('browser-facing new-product form is focused, collapsed and resumes safely after a validation error', async () => {
  const e = setup(); const code = 'NEW-HTTP-73'; const name = 'New fixture flange';
  const parsed = purchase(code, name, e.supplier.name);
  parsed.lines = parsed.lines.map(line => ({ ...Object.fromEntries(Object.entries(line).filter(([key]) => key in intent.LINE_SCHEMA.properties)), amount: -1, adjustmentTarget: -1 }));
  const app = createApp({ db: e.db, env: 'test', sessionSecret: 'purchase-intake-http', aiProvider: { complete: async () => ({ data: parsed }) } });
  const agent = request.agent(app); await signIn(agent, e.w.account.email, e.w.account.password);
  const start = await agent.get('/actions');
  const page = await agent.post('/actions/ask').type('form').send({ _csrf: csrfFrom(start.text), instruction: `Buy 6 ${name} SKU ${code} from ${e.supplier.name}` }).expect(200);
  assert.match(plain(page.text), /Buy a new product/); assert.match(plain(page.text), /Adding a catalogue record does not add stock/);
  assert.match(page.text, /<details class="rm-disclose"><summary>See my original request/);
  const continuationId = /name="continuationId" value="([^"]+)"/.exec(page.text)[1];
  const data = { ...form(e, code, name), unitCost: '', answer: 'add_and_draft', continuationId, _csrf: csrfFrom(page.text) };
  const invalid = await agent.post('/actions/ask').type('form').send({ ...data, trackingMode: '' }).expect(303);
  const retained = await agent.get(invalid.headers.location).expect(200); assert.match(retained.text, /value="NEW-HTTP-73"/);
  const drafted = await agent.post('/actions/ask').type('form').send({ ...data, _csrf: csrfFrom(retained.text) }).expect(303);
  assert.match(drafted.headers.location, /^\/purchasing\/orders\/po_/);
  assert.equal(e.db.prepare('SELECT status FROM purchase_orders').get().status, 'DRAFT');
  const story = await agent.get(drafted.headers.location).expect(200);
  assert.match(plain(story.text), /Next: add the missing purchase prices/);
  assert.match(story.text, /Add prices and review my PO/);
});
test('carrier and own-delivery handovers without a destination never issue stock, including the direct fulfillment path', () => {
  const e = setup(); const so = order(e); const box = shipments.startPicking(e.db, e.w.ctx, so.id);
  shipments.markPacked(e.db, e.w.ctx, box.id);
  const before = e.db.prepare('SELECT COUNT(*) n FROM movements').get().n;
  for (const handover of ['CARRIER', 'DELIVERED_BY_US']) assert.throws(() => shipments.ship(e.db, e.w.ctx, box.id, { handover, carrier: 'ups' }), /no delivery address/);
  assert.throws(() => sales.fulfill(e.db, e.w.ctx, so.id), /delivery address/);
  assert.equal(shipments.getShipment(e.db, e.w.workspaceId, box.id).status, 'PACKED');
  assert.equal(e.db.prepare('SELECT COUNT(*) n FROM movements').get().n, before);
});
test('open-box destination entry enables real carrier handover; pickup stays address-free', () => {
  const e = setup(); const so = order(e); const box = shipments.startPicking(e.db, e.w.ctx, so.id);
  shipments.setDestination(e.db, e.w.ctx, box.id, { deliveryMethod: 'SHIP', shippingAddress: '123 Example Road, Albany, NY 12207, US' });
  const shipped = shipments.ship(e.db, e.w.ctx, box.id, { carrier: 'ups', handover: 'CARRIER' });
  assert.equal(shipped.status, 'SHIPPED'); assert.match(shipped.ship_to_address, /Albany/);
  assert.throws(() => shipments.setDestination(e.db, e.w.ctx, box.id, { deliveryMethod: 'PICKUP' }), /completed handover/);
  const pickup = order(e, { deliveryMethod: 'PICKUP' });
  const collected = shipments.ship(e.db, e.w.ctx, shipments.startPicking(e.db, e.w.ctx, pickup.id).id, { handover: 'COLLECTED' });
  assert.equal(collected.handover, 'COLLECTED'); assert.equal(collected.ship_to_address, null);
});
test('direct fulfillment cannot bypass a payment hold and fulfilment surfaces the balance and payment options', async () => {
  const e = setup(); const so = order(e, { deliveryMethod: 'PICKUP' });
  const box = shipments.startPicking(e.db, e.w.ctx, so.id); shipments.markPacked(e.db, e.w.ctx, box.id);
  terms.setTerms(e.db, e.w.ctx, { customerId: so.customer_id, kind: 'BEFORE_FULFILMENT' });
  assert.throws(() => sales.fulfill(e.db, e.w.ctx, so.id), /still owed/);
  assert.throws(() => shipments.ship(e.db, e.w.ctx, box.id, { handover: 'COLLECTED' }), /still owed/);
  const app = createApp({ db: e.db, env: 'test', sessionSecret: 'dispatch-payment' });
  const agent = request.agent(app); await signIn(agent, e.w.account.email, e.w.account.password);
  const page = await agent.get(`/fulfilment/${box.id}`).expect(200);
  assert.match(plain(page.text), /Unpaid.*\$16.00 remaining/is);
  assert.match(plain(page.text), /Payment options: request payment or record money received/);
  const denied = await agent.post(`/fulfilment/${box.id}/ship`).type('form').send({ _csrf: csrfFrom(page.text), handover: 'COLLECTED' }).expect(303);
  assert.match(plain((await agent.get(denied.headers.location)).text), /stays packed until it is paid/);
  assert.equal(shipments.getShipment(e.db, e.w.workspaceId, box.id).status, 'PACKED');
});

test('chat carries explicitly stated delivery details into a draft and refuses invented destinations', async () => {
  const e = setup(); const address = '123 Example Road, Albany, NY 12207, US';
  const source = `Prepare 2 Existing fixture part for Fixture Buyer. Deliver to ${address}. Email buyer@example.test. Show me the draft before confirmation.`;
  const data = { operation: 'create', customerText: 'Fixture Buyer', orderText: '', itemText: 'Existing fixture part', variantText: '', locationText: '', quantity: 2, neededBy: '', reason: '',
    deliveryMethod: 'SHIP', shippingAddress: address, customerEmail: 'buyer@example.test', deliverySource: `Deliver to ${address}` };
  const read = await salesIntent.interpret(e.db, e.w.ctx, source, { provider: { complete: async () => ({ data }) } });
  const result = salesIntent.apply(e.db, e.w.ctx, read, { previewOnly: true });
  assert.equal(result.order.status, 'DRAFT'); assert.equal(result.order.ship_to_address, address);
  assert.equal(result.order.customer.email, 'buyer@example.test'); assert.equal(result.order.totals.allocated, 0);
  const invented = salesIntent.apply(e.db, e.w.ctx, { ...read, customerText: 'Other Fixture Buyer', shippingAddress: '999 Made Up Street' }, { previewOnly: true });
  assert.equal(invented.kind, 'question');
  assert.equal(invented.continuation.field, 'shippingAddress');
  assert.match(invented.question, /delivery address/i);
  assert.equal(e.db.prepare('SELECT COUNT(*) AS count FROM sales_orders').get().count, 1,
    'an incomplete or invented destination must not create another order');
  const pickup = salesIntent.apply(e.db, e.w.ctx, { ...read, customerText: 'Pickup Fixture Buyer', statedAs: 'Prepare 2 Existing fixture part for customer pickup', deliveryMethod: 'PICKUP', deliverySource: 'customer pickup', shippingAddress: '', customerEmail: '' }, { previewOnly: true });
  assert.equal(pickup.order.delivery_method, 'PICKUP'); assert.equal(pickup.order.delivery_decision_required, 0);
});
