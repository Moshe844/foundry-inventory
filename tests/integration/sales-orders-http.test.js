'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const needsYouInbox = require('../../src/manager/needs-you-inbox');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeVariantItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup(provider = { complete: async () => ({ data: {} }) }) {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Mission 10 Browser Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  const app = createApp({ db, env: 'test', sessionSecret: 'mission-10-http', aiProvider: provider });
  return { db, workspace, membership, item, app };
}

test('Sales UI covers draft → confirm/commit → partial fulfillment → cancellation and Activity', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, { skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 50 });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const form = await agent.get('/sales/new');
  assert.equal(form.status, 200);
  assert.match(plain(form.text), /Customer demand before stock leaves|does not reduce physical stock/i);
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
    _csrf: csrfFrom(form.text), customerName: 'ABC School', skuId: env.item.skuId, quantity: 30,
    orderDate: '2026-08-26', neededBy: '2026-09-01', fulfillmentLocationId: env.workspace.main.id,
  });
  assert.equal(created.status, 303);
  assert.match(created.headers.location, /^\/sales\/orders\/so_/);

  let page = await agent.get(created.headers.location);
  assert.match(plain(page.text), /Nothing is committed yet/);
  const confirmed = await agent.post(`${created.headers.location}/confirm`).type('form')
    .send({ _csrf: csrfFrom(page.text) });
  assert.equal(confirmed.status, 303);
  page = await agent.get(created.headers.location);
  let text = plain(page.text);
  assert.match(page.text, /class="stats-row"/);
  assert.match(page.text, /class="card sales-action-card"/);
  assert.match(text, /30 committed/);
  assert.match(text, /On hand will remain unchanged|physical stock actually leaves/i);

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
    lineId: line.id, locationId: env.workspace.main.id, quantity: 10,
  });
  assert.equal(fulfilled.status, 303);
  page = await agent.get(created.headers.location);
  text = plain(page.text);
  assert.match(text, /partially fulfilled/i);
  assert.match(text, /20 committed/);
  assert.match(text, /10 fulfilled/);

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
  const salesPage = plain((await agent.get('/sales')).text);
  assert.match(salesPage, /0\s+Open customer orders\s+0\s+committed to customer orders\s+0\s+Units waiting for stock/i,
    'cancelled orders must not remain in the live commitment totals');
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

test('Tell Foundry creates, changes, fulfills and cancels the same structured Sales Order', async () => {
  const env = setup(conversationalProvider());
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

test('Tell Foundry shows sales-order variant choices instead of flattening the question into a toast', async () => {
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
  assert.equal(order.status, 'BACKORDERED');
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
  assert.equal(order.status, 'BACKORDERED');
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
  assert.match(plain(form.text), /Do now:.*Set the selling price for Unpriced Scarf/i);
  assert.match(plain(form.text), /Unpriced Scarf.*Price not set/i);
  const rejected = await agent.post('/sales/orders').type('form').send({
    _csrf: csrfFrom(form.text), customerName: 'Test Customer', skuId: unpriced.skuId, quantity: 1,
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
