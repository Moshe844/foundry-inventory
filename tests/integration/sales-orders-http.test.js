'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const shipments = require('../../src/sales/shipment-service');
const prices = require('../../src/pricing/price-service');
const needsYouInbox = require('../../src/manager/needs-you-inbox');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeVariantItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

// The books open the day the test runs; a date before that is refused, so fixtures are dated today.
const TODAY = new Date().toISOString().slice(0, 10);

function setup(provider = { complete: async () => ({ data: {} }) }) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Mission 10 Browser Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  const app = createApp({ db, env: 'test', sessionSecret: 'mission-10-http', aiProvider: provider });
  return { db, workspace, membership, item, app };
}

test('a pickup order stays pickup on the visible pick list', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 5,
  });
  const customer = sales.createCustomer(env.db, env.workspace.ctx, {
    name: 'Pickup Customer', shippingAddress: '123 Old Delivery Road',
  });
  const order = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerId: customer.id, deliveryMethod: 'PICKUP',
    lines: [{ skuId: env.item.skuId, quantity: 2 }],
  }).id);
  const box = shipments.startPicking(env.db, env.workspace.ctx, order.id);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/fulfilment/${box.id}`).expect(200);
  const text = plain(page.text);
  assert.match(text, /Customer pickup.*No carrier, shipping label, or delivery address is needed/is);
  assert.match(text, /on the shelf.*until you confirm the customer collected it/is);
  assert.match(text, /Customer collected it.*2 leaves stock/is);
  assert.doesNotMatch(text, /123 Old Delivery Road|Get carrier rates|Where it is going/i);

  shipments.ship(env.db, env.workspace.ctx, box.id, { handover: 'COLLECTED' });
  const story = plain((await agent.get(`/sales/orders/${order.id}`)).text);
  assert.match(story, /Collected — \$[\d,.]+ still owed/i);
  assert.match(story, /The customer collected everything on this order/i);
  assert.doesNotMatch(story, /Shipped — \$[\d,.]+ still owed/i);
  const list = plain((await agent.get('/orders')).text);
  assert.match(list, /0 open.*1 collected/i);
  assert.match(list, /2 units collected/i);
  assert.doesNotMatch(list, /1 shipped|2 units shipped/i);
  env.db.close();
});

test('Sales UI covers draft → confirm/commit → partial fulfillment → cancellation and Activity', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 50 });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/sales/new');
  assert.equal(form.status, 200);
  assert.match(plain(form.text), /customer demand before stock leaves/i);
  assert.match(form.text, /class="card form-card"/);
  assert.match(form.text, /class="form-grid"/);
  const styles = await agent.get('/app.css');
  assert.equal(styles.status, 200);
  assert.match(styles.text, /\.form-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles.text, /\.form-grid\s*>\s*\.field--full\s*\{\s*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(styles.text, /\.stats-row\s*\{[^}]*display:\s*grid/s);
  assert.match(styles.text, /\.sales-action-card\s*\{[^}]*padding:/s);
  assert.match(styles.text, /\.list-row\s*\{[^}]*padding:/s);
  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'ABC School', deliveryMethod: 'PICKUP', skuId: env.item.skuId, quantity: 30,
    orderDate: '2026-08-26', neededBy: '2026-09-01', fulfillmentLocationId: env.workspace.main.id,
  });
  assert.equal(created.status, 303);
  assert.match(created.headers.location, /^\/sales\/orders\/so_/);

  let page = await agent.get(created.headers.location);
  const createdOrderId = created.headers.location.split('/').pop();
  assert.match(page.text, new RegExp(`href="/orders/${createdOrderId}/detail\\?open=fulfilment#fulfilment"`),
    'Open the working detail goes to the dedicated operational page');
  assert.match(plain(page.text), /Show order history/i,
    'the transaction timeline is available without overwhelming the primary order state');
  const workingDetail = await agent.get(`/orders/${createdOrderId}/detail`);
  assert.equal(workingDetail.status, 200);
  assert.match(plain(workingDetail.text), /Customer order.*SO-1001.*ABC School/i);
  assert.match(plain(page.text), /Do this next.*Confirm this order and reserve stock/i);
  const confirmed = await agent.post(`${created.headers.location}/confirm`).type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(confirmed.status, 303);
  page = await agent.get(created.headers.location);
  let text = plain(page.text);
  assert.match(page.text, /class="stats-row"/);
  assert.match(page.text, /class="card sales-action-card sales-primary-action"/);
  assert.match(text, /Do this next.*Record what physically left/i);
  assert.match(page.text, /<details class="card advanced-settings sales-secondary-actions"/);
  assert.match(text, /30 committed/);
  assert.match(text, /Only use this when the items physically leave.*reduce on-hand once/i);
  assert.match(text, /Planned: Collected by the customer.*came from the delivery choice on the order/i);
  assert.match(page.text, /value="COLLECTED" required checked/,
    'a pickup order carries its delivery choice into fulfilment');

  const createdCustomer = sales.listCustomers(env.db, env.workspace.workspaceId)[0];
  let customerPage = await agent.get(`/sales/customers/${createdCustomer.id}`);
  assert.equal(customerPage.status, 200);
  const customerUpdated = await agent.post(`/sales/customers/${createdCustomer.id}`).type('form').send({
    _csrf: csrfFrom(customerPage.text), name: 'ABC School', company: 'ABC Education',
    email: 'stock@abc.example', phone: '555-0100', shippingAddress: 'Receiving dock 2', notes: 'Call before delivery',
  });
  assert.equal(customerUpdated.status, 303);
  customerPage = await agent.get(`/sales/customers/${createdCustomer.id}`);
  assert.equal(sales.getCustomer(env.db, env.workspace.workspaceId, createdCustomer.id).company, 'ABC Education');
  assert.match(customerPage.text, /value="ABC Education"/);
  assert.match(plain(customerPage.text), /SO-1001/);

  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  const line = order.lines[0];
  const fulfilled = await agent.post(`${created.headers.location}/fulfill`).type('form').send({
    _csrf: csrfFrom(page.text), idempotencyKey: `browser-partial:${order.id}`,
    lineId: line.id, locationId: env.workspace.main.id, quantity: 10, handover: 'COLLECTED',
  });
  assert.equal(fulfilled.status, 303);
  page = await agent.get(created.headers.location);
  text = plain(page.text);
  assert.match(text, /partly shipped|partly fulfilled|partly gone/i);
  assert.match(text, /20 committed/);
  // The stat is labelled 'shipped' now: the word an owner uses, without the
  // 'fulfilled (shipped)' gloss that was explaining StockChief's vocabulary to them.
  assert.match(text, /10 collected/);

  const itemPage = plain((await agent.get(`/inventory/${env.item.itemId}`)).text);
  assert.match(itemPage, /40\s+units on hand/i);
  assert.match(itemPage, /20\s+committed to customer orders/i);
  assert.match(itemPage, /20\s+units available/i);
  assert.match(itemPage, /0\s+on order from suppliers/i);

  const cancelled = await agent.post(`${created.headers.location}/cancel`).type('form').send({
    _csrf: csrfFrom(page.text), reason: 'Customer changed plans.',
  });
  assert.equal(cancelled.status, 303);
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, order.id).totals.backordered, 0,
    'cancelled units are no longer waiting for stock');
  const activity = plain((await agent.get('/activity?stream=sales')).text);
  assert.match(activity, /confirmed and stock allocated/i);
  assert.match(activity, /partly fulfilled/i);
  assert.match(activity, /cancelled and commitments released/i);
  /*
   * The same guarantee, in the vocabulary the page now uses.
   *
   * This used to read the three-figure strip at the top — open orders,
   * committed, waiting for stock — which was replaced by a sentence saying
   * whether anything needs a person. The engine-level assertion above still
   * proves the commitment was released; this proves the page agrees, which is
   * what it was always really for.
   */
  const salesPage = plain((await agent.get('/orders')).text);
  assert.match(salesPage, /Nothing is waiting on you/i,
    'a cancelled order leaves nothing waiting for anybody');
  assert.match(salesPage, /Cancelled/,
    'and it is still listed, saying what became of it');
  env.db.close();
});

test('the short manual flow can reserve an order or complete an in-stock sale in one submission', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let form = await agent.get('/sales/new').expect(200);
  const reserved = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Reserved Customer', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 5, nextStep: 'confirm',
  }).expect(303);
  let order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.status, 'CONFIRMED');
  assert.equal(order.totals.allocated, 5);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'issue'")
    .get(env.workspace.workspaceId).n, 0, 'reserving an order does not remove stock');
  assert.match(plain((await agent.get(reserved.headers.location)).text), /Record what physically left/i);

  form = await agent.get('/sales/new').expect(200);
  const completed = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Counter Sale Customer', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 3, nextStep: 'fulfill',
  }).expect(303);
  order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.status, 'FULFILLED');
  assert.equal(order.totals.fulfilled, 3);
  assert.equal(env.db.prepare("SELECT SUM(-quantity_delta) AS n FROM movements WHERE workspace_id = ? AND operation = 'issue'")
    .get(env.workspace.workspaceId).n, 3, 'the completed-sale choice removes stock exactly once');
  assert.match(plain((await agent.get(completed.headers.location)).text), /(Shipped|Gone|Collected|Delivered).*Accounting/i);
  env.db.close();
});

function conversationalProvider() {
  return { complete: async (request) => {
    if (request.schemaName === 'manager_intent') return { data: {
      capabilityId: 'sales.manage-orders', intentClass: 'SALES_ORDER', confidence: 'high',
      goal: 'Manage the named customer order.', reason: 'This is customer committed demand.',
      resolvedReference: '', clarifyingQuestion: '',
      parameters: { fromText: '', toText: '', transformMode: '', documentReference: '' },
    } };
    if (request.schemaName === 'sales_order_intent') {
      const prompt = request.prompt;
      const operation = /Add another/i.test(prompt) ? 'add'
        : /Ship 4/i.test(prompt) ? 'fulfill'
          : /cancelled their order/i.test(prompt) ? 'cancel_order' : 'create';
      return { data: {
        operation, customerText: 'ABC School', orderText: '', itemText: operation === 'cancel_order' ? '' : 'Black Small Shirt',
        variantText: '', locationText: operation === 'fulfill' ? 'Main Warehouse' : '',
        quantity: operation === 'create' ? 10 : operation === 'add' ? 5 : operation === 'fulfill' ? 4 : -1,
        neededBy: '', reason: 'The owner stated the customer-order change.',
      } };
    }
    return { data: {} };
  } };
}

test('Tell StockChief creates, changes, fulfills and cancels the same structured Sales Order', async () => {
  const env = setup(conversationalProvider());
  sales.createCustomer(env.db, env.workspace.ctx, { name: 'ABC School', shippingAddress: '123 Example Road, Albany, NY 12207, US' });
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 30 });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  async function tell(message) {
    const home = await agent.get('/');
    return agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message });
  }
  let response = await tell('ABC School ordered 10 Black Small Shirt.');
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/sales\/orders\/so_/);
  let [order] = sales.listOrders(env.db, env.workspace.workspaceId);
  assert.equal(order.totals.allocated, 10);

  response = await tell("Add another 5 Black Small Shirt to ABC School's order.");
  assert.equal(response.headers.location, `/sales/orders/${order.id}`);
  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.deepEqual(order.totals, { ordered: 15, fulfilled: 0, allocated: 15, backordered: 0 });

  response = await tell("Ship 4 of ABC School's Black Small Shirt from Main Warehouse.");
  assert.equal(response.headers.location, `/sales/orders/${order.id}`);
  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(order.totals.fulfilled, 4);
  assert.equal(order.totals.allocated, 11);

  response = await tell('ABC School cancelled their order.');
  assert.equal(response.headers.location, `/sales/orders/${order.id}`);
  order = sales.getOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.totals.allocated, 0);
  env.db.close();
});

test('Tell StockChief completes a named whole order immediately without AI routing or a false Sales redirect', async () => {
  const provider = { complete: async () => {
    throw new Error('The exact whole-order command must not wait for an AI provider.');
  } };
  const env = setup(provider);
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const draft = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Hendel', deliveryMethod: 'PICKUP', lines: [{ skuId: env.item.skuId, quantity: 8 }], requirePrices: true,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Can you complete the sales order for Hendel',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/sales/orders/${draft.id}`,
    'a completed command returns to the exact order, never the empty Sales list');
  const order = sales.getOrder(env.db, env.workspace.workspaceId, draft.id);
  assert.equal(order.status, 'FULFILLED');
  assert.deepEqual(order.totals, { ordered: 8, fulfilled: 8, allocated: 0, backordered: 0 });
  assert.equal(env.db.prepare(`SELECT SUM(-quantity_delta) AS n FROM movements
    WHERE workspace_id = ? AND operation = 'issue' AND reference = ?`)
    .get(env.workspace.workspaceId, draft.order_number).n, 8);
  const routed = env.db.prepare(`SELECT status, routed_to, related_record_id FROM manager_intents
    WHERE workspace_id = ? AND stated_as = ? ORDER BY created_at DESC LIMIT 1`)
    .get(env.workspace.workspaceId, 'Can you complete the sales order for Hendel');
  assert.deepEqual(routed, { status: 'ROUTED', routed_to: 'sales_order', related_record_id: draft.id });
  assert.match(plain((await agent.get(response.headers.location)).text), /(Shipped|Gone|Collected|Delivered).*Accounting/i);
  env.db.close();
});

test('Tell StockChief keeps an unfillable whole order on its exact page and ships nothing', async () => {
  const env = setup({ complete: async () => { throw new Error('AI should not be called.'); } });
  const draft = sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'Hendel', deliveryMethod: 'PICKUP', lines: [{ skuId: env.item.skuId, quantity: 8 }], requirePrices: true,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Please finish the customer order for Hendel.',
  });

  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/sales/orders/${draft.id}`);
  const order = sales.getOrder(env.db, env.workspace.workspaceId, draft.id);
  assert.equal(order.status, 'BACKORDERED');
  assert.equal(order.totals.fulfilled, 0);
  assert.equal(env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'issue'")
    .get(env.workspace.workspaceId).n, 0);
  const page = plain((await agent.get(response.headers.location)).text);
  assert.match(page, /cannot be completed yet.*8 unit\(s\) are not available/i);
  assert.match(page, /nothing was shipped/i);
  env.db.close();
});

test('Tell StockChief shows sales-order variant choices instead of flattening the question into a toast', async () => {
  const provider = { complete: async (request) => {
    if (request.schemaName === 'manager_intent') return { data: {
      capabilityId: 'sales.manage-orders', intentClass: 'SALES_ORDER', confidence: 'high',
      goal: 'Record customer demand.', reason: 'The customer placed an order.', resolvedReference: '',
      clarifyingQuestion: '', parameters: { fromText: '', toText: '', transformMode: '', documentReference: '' },
    } };
    if (request.schemaName === 'sales_order_intent') return { data: {
      operation: 'create', customerText: 'ABC School', orderText: '', itemText: 'Zip Hoodie - Navy',
      variantText: '', locationText: '', quantity: 2, neededBy: '', reason: 'Customer order.',
    } };
    return { data: {} };
  } };
  const env = setup(provider);
  const hoodie = makeVariantItem(env.db, env.workspace.ctx, {
    name: 'Zip Hoodie - Navy', options: [{ name: 'Size', values: 'Small, Medium' }],
  });
  for (const sku of hoodie.skus) prices.setPrice(env.db, env.workspace.ctx,
    { skuId: sku.id, amount: '42.00', currency: 'USD' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const asked = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'ABC School ordered 2 Zip Hoodie - Navy.',
  });
  assert.equal(asked.status, 303);
  assert.equal(asked.headers.location, '/actions');
  const choices = await agent.get('/actions');
  assert.match(plain(choices.text), /Which size of Zip Hoodie - Navy do you mean\?/);
  assert.match(choices.text, /name="answer" value="Small"/);
  assert.match(choices.text, /name="answer" value="Medium"/);
  assert.doesNotMatch(choices.text, /flash[^>]*>[^<]*Which size/i);

  const continued = await agent.post('/sales/clarify').type('form').send({
    _csrf: csrfFrom(choices.text), original: 'ABC School ordered 2 Zip Hoodie - Navy.', answer: 'Small',
  });
  assert.equal(continued.status, 303);
  assert.match(continued.headers.location, /^\/sales\/orders\/so_/);
  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.delivery_decision_required, 1, 'choosing a variant does not answer the missing delivery decision');
  assert.match(order.lines[0].displayName, /Small/);
  assert.equal(order.lines[0].unit_price_minor, 4200);
  env.db.close();
});

test('a missing selling price becomes an answerable step and cannot create an incomplete customer order', async () => {
  const provider = { complete: async (request) => {
    if (request.schemaName === 'manager_intent') return { data: {
      capabilityId: 'sales.manage-orders', intentClass: 'SALES_ORDER', confidence: 'high', goal: 'Record order.',
      reason: 'Customer order.', resolvedReference: '', clarifyingQuestion: '',
      parameters: { fromText: '', toText: '', transformMode: '', documentReference: '' },
    } };
    if (request.schemaName === 'sales_order_intent') return { data: {
      operation: 'create', customerText: 'North School', orderText: '', itemText: 'Unpriced Cap',
      variantText: '', locationText: '', quantity: 3, neededBy: '', reason: 'Customer order.',
    } };
    return { data: {} };
  } };
  const env = setup(provider);
  const cap = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Unpriced Cap', baseCode: 'CAP-UNPRICED' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const home = await agent.get('/');
  const asked = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'North School ordered 3 Unpriced Cap.',
  });
  assert.equal(asked.headers.location, '/actions');
  assert.equal(sales.listOrders(env.db, env.workspace.workspaceId).length, 0,
    'a question must not leave a price-less draft behind');
  const question = await agent.get('/actions');
  assert.match(plain(question.text), /does not have a selling price.*What price should this customer order use/i);
  assert.match(question.text, /action="\/sales\/clarify"/);

  const priced = await agent.post('/sales/clarify').type('form').send({
    _csrf: csrfFrom(question.text), original: 'North School ordered 3 Unpriced Cap.', answer: '32.50',
  });
  assert.match(priced.headers.location, /^\/sales\/orders\/so_/);
  const [order] = sales.listOrders(env.db, env.workspace.workspaceId);
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.delivery_decision_required, 1, 'a price answer is not a delivery address or pickup decision');
  assert.equal(order.lines[0].unit_price_minor, 3250);
  assert.equal(prices.currentForSku(env.db, env.workspace.workspaceId, cap.skuId).isSet, false,
    'an order-specific answer must not silently rewrite the inventory catalogue price');
  env.db.close();
});

test('the manual Sales Order form refuses a blank price and explains the correction inline', async () => {
  const env = setup();
  const unpriced = makeQuantityItem(env.db, env.workspace.ctx, { name: 'Unpriced Scarf', baseCode: 'SCARF-NO-PRICE' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const form = await agent.get('/sales/new');
  assert.match(plain(form.text), /Every customer order needs a price/i);
  assert.match(plain(form.text), /Order price.*only if the product has no selling price/i,
    'the correction is in the order flow instead of a competing setup banner');
  assert.doesNotMatch(plain(form.text), /Do now:.*Set the selling price/i);
  assert.match(plain(form.text), /Unpriced Scarf.*Price not set/i);
  const rejected = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Test Customer', deliveryMethod: 'PICKUP', skuId: unpriced.skuId, quantity: 1,
    orderDate: '2026-08-30', currency: 'USD',
  });
  assert.equal(rejected.status, 400);
  assert.match(plain(rejected.text), /This order is not ready.*does not have a selling price/i);
  assert.equal(sales.listOrders(env.db, env.workspace.workspaceId).length, 0);
  env.db.close();
});

test('the global Needs you badge includes every customer order waiting for stock', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  for (const customerName of ['ABC School', 'Northside School']) {
    const order = sales.createOrder(env.db, env.workspace.ctx, {
      customerName,
      orderDate: '2026-08-27',
      lines: [{ skuId: env.item.skuId, quantity: 3 }],
    });
    sales.confirm(env.db, env.workspace.ctx, order.id, { idempotencyKey: `badge:${order.id}` });
  }

  const inbox = needsYouInbox.inbox(env.db, env.workspace.workspaceId);
  assert.equal(inbox.filter((entry) => entry.kind === 'sales_order').length, 2);
  const page = await agent.get('/sales');
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`nav-count">${inbox.length}<`));
  env.db.close();
});

test('manual orders reveal available stock before submission and shortage decisions open a real resolution', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 3,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/orders/new').expect(200);
  assert.match(plain(form.text), /Black Small Shirt.*3 available now/i,
    'the product choice says how many units are actually free');
  assert.match(form.text, /id="order-stock-check"[^>]*aria-live="polite"/);
  assert.match(form.text, /This order is.*over the available stock/,
    'the browser has an explicit live warning for an excessive quantity');
  assert.match(form.text, /Create order —.*will wait for stock/,
    'the primary action itself changes before an owner accepts a backorder');

  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Too Many Co', deliveryMethod: 'PICKUP',
    skuId: env.item.skuId, quantity: 8, nextStep: 'confirm',
  }).expect(303);
  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.deepEqual(order.totals, { ordered: 8, fulfilled: 0, allocated: 3, backordered: 5 });

  const decision = needsYouInbox.inbox(env.db, env.workspace.workspaceId)
    .find((entry) => entry.id.startsWith(`sales-order:${order.id}:`));
  assert.ok(decision);
  assert.equal(decision.href, `/purchasing/supplier-for/${env.item.skuId}`);

  const target = await agent.get(decision.href).expect(200);
  assert.match(plain(target.text), /Who do you buy Black Small Shirt from/i,
    'the Needs You action lands on the exact information that can unblock replenishment');

  const orderPage = await agent.get(created.headers.location).expect(200);
  assert.match(orderPage.text, /id="stock-shortage"/);
  assert.match(plain(orderPage.text), /Cover the 5 missing units.*Add a supplier for this product/i,
    'the order page also provides a direct way out instead of linking back to Needs You');
  env.db.close();
});


/**
 * A page must not reassure somebody that nothing moved while recording that
 * something moved.
 *
 * Found walking the customer-order scenario. The shortfall notice was written
 * for the moment an order is confirmed — "StockChief found only N units available
 * to reserve. No on-hand stock changed and nothing was shipped" — and then
 * re-rendered unchanged after a shipment. Shipping 34 of 50 left the page
 * saying "nothing was shipped" directly beneath "34 fulfilled (shipped)",
 * under a flash reading "SO-1001 was partly fulfilled".
 */
test('a partly shipped order does not claim nothing was shipped', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 34,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/sales/new');
  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Riverside Builders', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 50, orderDate: '2026-08-31', fulfillmentLocationId: env.workspace.main.id,
  });
  let page = await agent.get(created.headers.location);
  await agent.post(`${created.headers.location}/confirm`).type('form')
    .send({ _csrf: csrfFrom(page.text) });

  page = await agent.get(created.headers.location);
  assert.match(plain(page.text), /16 units still short/i);
  assert.match(plain(page.text), /nothing was shipped/i, 'true while nothing has shipped');

  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  const line = order.lines[0];
  await agent.post(`${created.headers.location}/fulfill`).type('form').send({
    _csrf: csrfFrom(page.text), idempotencyKey: `short-ship:${order.id}`,
    lineId: line.id, locationId: env.workspace.main.id, quantity: 34, handover: 'COLLECTED',
  });

  const after = plain((await agent.get(created.headers.location)).text);
  assert.match(after, /still short/i, 'the shortfall is still stated');
  assert.doesNotMatch(after, /nothing was shipped/i,
    'because something was shipped, and the same page says so');
  assert.match(after, /34 units collected/, 'it says how much actually went and matches the explicit pickup choice');
});

/**
 * Stock that arrives after an order is confirmed can be committed to it.
 *
 * Allocation ran once, at confirmation, and never again — so a delivery could
 * land against the exact shortfall an order was waiting for and the order could
 * not take it. Sixty units in the store room, an order short sixteen, and the
 * only options on the page were to add more demand or cancel. Needs you sent
 * the reader there, which made it a loop into a dead end.
 *
 * StockChief still does not do it by itself: holding stock for one customer takes
 * it from the next person who asks, so it is offered and not done.
 */
test('stock arriving after confirmation can be committed, without moving any of it', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 10,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/sales/new');
  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Riverside Builders', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 30, orderDate: '2026-08-31', fulfillmentLocationId: env.workspace.main.id,
  });
  let page = await agent.get(created.headers.location);
  await agent.post(`${created.headers.location}/confirm`).type('form').send({ _csrf: csrfFrom(page.text) });

  let order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.totals.allocated, 10);
  assert.equal(order.totals.backordered, 20);

  // Nothing free, so nothing to offer and nothing to commit.
  page = await agent.get(created.headers.location);
  assert.doesNotMatch(plain(page.text), /Reserve the stock that is now available/);

  // A delivery lands.
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 12,
  });
  page = await agent.get(created.headers.location);
  assert.match(plain(page.text), /Reserve the stock that is now available/);
  assert.match(plain(page.text), /Reserve 12 for Riverside Builders/);

  const onHandBefore = sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId).onHand;
  const committed = await agent.post(`${created.headers.location}/allocate`).type('form')
    .send({ _csrf: csrfFrom(page.text), idempotencyKey: 'commit-once' });
  assert.equal(committed.status, 303);

  order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.totals.allocated, 22, 'the twelve that arrived are now held');
  assert.equal(order.totals.backordered, 8, 'and the rest is still short');

  const after = sales.availabilityForSku(env.db, env.workspace.workspaceId, env.item.skuId);
  assert.equal(after.onHand, onHandBefore, 'committing is a promise about stock, not a movement of it');
  assert.equal(after.available, 0, 'but none of it is free any more');

  // Committing again commits nothing: the shortfall is real but the stock is not.
  const again = await agent.post(`${created.headers.location}/allocate`).type('form')
    .send({ _csrf: csrfFrom((await agent.get(created.headers.location)).text), idempotencyKey: 'commit-twice' });
  assert.equal(again.status, 303);
  order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.totals.allocated, 22, 'never more than is on the shelf');
  assert.ok(order.totals.allocated <= after.onHand, 'and never more than exists');
});

test('a draft order is told to be confirmed rather than silently holding stock', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/sales/new');
  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Draft Co', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 5, orderDate: '2026-08-31', fulfillmentLocationId: env.workspace.main.id,
  });
  const page = await agent.get(created.headers.location);
  await agent.post(`${created.headers.location}/allocate`).type('form').send({ _csrf: csrfFrom(page.text) });

  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.totals.allocated, 0, 'a draft holds nothing');
  assert.match(plain((await agent.get(created.headers.location)).text), /Confirm the order first/);
});

/**
 * What the customer owes, on the order they owe it for.
 *
 * The order page carried quantities and no money at all — ordered, committed,
 * short, shipped — and nothing about whether it had been paid for. The invoice
 * already knew, and is linked to the order; the page simply never asked.
 *
 * It appears once there is an invoice. Before that nothing is owed, and a row
 * of zeroes would read as a debt of nothing.
 */
test('an order with an invoice shows what was invoiced, paid and still owed', async () => {
  const env = setup();
  const ledger = require('../../src/accounting/ledger');
  const receivables = require('../../src/accounting/receivables');
  const payments = require('../../src/accounting/payments');
  const membership = authService.getMembership(env.db, env.workspace.workspaceId, env.workspace.accountId);
  ledger.configure(env.db, env.workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40,
  });

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const form = await agent.get('/sales/new');
  const created = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'ABC School', deliveryMethod: 'PICKUP', skuId: env.item.skuId,
    quantity: 40, orderDate: '2026-09-01', fulfillmentLocationId: env.workspace.main.id,
  });

  // Before an invoice exists nothing is owed, and a row of zeroes would read
  // as a debt of nothing.
  const before = plain((await agent.get(created.headers.location)).text);
  assert.doesNotMatch(before, /still owed/, 'no money section before there is an invoice');

  const order = sales.listOrders(env.db, env.workspace.workspaceId)[0];
  const draft = receivables.createDraft(env.db, env.workspace.ctx, membership, {
    customerId: order.customer.id, salesOrderId: order.id,
    issueDate: '2026-09-01', dueDate: '2026-09-30', sourceKey: 'invoice:so-money',
    lines: [{ description: 'Black Small Shirt', quantity: 40, unitPriceMinor: 2_500 }],
  });
  const invoice = receivables.open(env.db, env.workspace.ctx, membership, draft.invoice.id);
  assert.equal(invoice.total_minor, 100_000);

  let text = plain((await agent.get(created.headers.location)).text);
  assert.match(text, /\$1,000\.00 invoiced/, 'the amount invoiced appears on the order');
  assert.match(text, /still owed/);
  assert.match(text, /Unpaid/, 'and its state in a word an owner uses');

  payments.record(env.db, env.workspace.ctx, membership, {
    direction: 'CUSTOMER_RECEIPT', customerId: order.customer.id,
    paymentDate: TODAY, amountMinor: 50_000, sourceKey: 'receipt:1',
    allocations: [{ invoiceId: invoice.id, amountMinor: 50_000 }],
  });

  text = plain((await agent.get(created.headers.location)).text);
  assert.match(text, /Partly paid/, 'half paid is neither unpaid nor paid');
  assert.match(text, /\$500\.00 paid/, 'and both halves are shown');
  env.db.close();
});

/*
 * Asking for an order is a conversation, not a form.
 *
 * "Can you create a customer order for Marlow?" names a customer and nothing
 * else. StockChief answers from its own records: it notices the customer is not
 * on file and offers to create them, then offers what is actually available to
 * place, then asks how many — and only then creates and confirms the order.
 * The provider here throws, so every step is the deterministic path; the model
 * can only make it smoother, never a requirement.
 */
test('asking for a customer order walks through customer, product and quantity from real records', async () => {
  const env = setup({ complete: async () => { throw new Error('offline'); } });
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 12 });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const original = 'Can you create a customer order for Marlow?';

  const home = await agent.get('/');
  let response = await agent.post('/foundry/tell').type('form')
    .send({ _csrf: csrfFrom(home.text), message: original });
  assert.equal(response.headers.location, '/actions', 'a request for an order is a conversation, not a question page');

  let page = await agent.get('/actions');
  assert.match(plain(page.text), /“Marlow” is not a customer on file yet\. Create them and carry on/);
  assert.match(page.text, /name="answer" value="create"/);
  assert.match(page.text, /name="answer" value="choose"/);

  response = await agent.post('/sales/clarify').type('form')
    .send({ _csrf: csrfFrom(page.text), original, answer: 'create' });
  page = await agent.get('/actions');
  assert.match(plain(page.text), /what would you like to place for Marlow\?/);
  assert.match(plain(page.text), /Black Small Shirt — 12 units available/, 'the choices say what is actually available');

  response = await agent.post('/sales/clarify').type('form')
    .send({ _csrf: csrfFrom(page.text), original, answer: env.item.skuId });
  page = await agent.get('/actions');
  assert.match(plain(page.text), /How many Black Small Shirt for Marlow\? 12 available right now\./);

  response = await agent.post('/sales/clarify').type('form')
    .send({ _csrf: csrfFrom(page.text), original, answer: '4' });
  assert.match(response.headers.location, /^\/sales\/orders\/so_/);
  const [order] = sales.listOrders(env.db, env.workspace.workspaceId);
  assert.equal(order.customer.name, 'Marlow');
  assert.equal(order.status, 'DRAFT');
  assert.equal(order.delivery_decision_required, 1, 'the next step collects a delivery address or explicit pickup choice');
  assert.equal(order.totals.ordered, 4);
  assert.equal(order.totals.allocated, 0);
  assert.equal(sales.listCustomers(env.db, env.workspace.workspaceId).length, 1, 'the customer was created once');
  env.db.close();
});

test('a near miss on the customer name is offered back rather than duplicated', async () => {
  const env = setup({ complete: async () => { throw new Error('offline'); } });
  sales.createCustomer(env.db, env.workspace.ctx, { name: 'Marlow & Co.' });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const original = 'Please create a customer order for Marlow';
  const home = await agent.get('/');
  await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: original });
  let page = await agent.get('/actions');
  assert.match(plain(page.text), /no customer called “Marlow” on file\. Did you mean/);
  assert.match(page.text, /name="answer" value="Marlow &amp; Co\."/);
  assert.match(page.text, /value="__create__:Marlow"/);
  await agent.post('/sales/clarify').type('form')
    .send({ _csrf: csrfFrom(page.text), original, answer: 'Marlow & Co.' });
  page = await agent.get('/actions');
  assert.match(plain(page.text), /what would you like to place for Marlow & Co\.\?/);
  assert.equal(sales.listCustomers(env.db, env.workspace.workspaceId).length, 1, 'no second Marlow was created');
  env.db.close();
});
