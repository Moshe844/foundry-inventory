'use strict';

/*
 * Fulfilment through the screens a person actually uses.
 *
 * The engine tests prove the stock arithmetic. These prove the promise the
 * pages make about it: that a picker is told, in words, that nothing has left
 * stock yet, and that the button which does move stock says so before it is
 * pressed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const inventory = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Fulfilment Browser Co' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  const app = createApp({ db, env: 'test', sessionSecret: 'fulfilment-http' });
  return { db, workspace, item, app };
}

test('the fulfilment queue, a pick list, packing and shipping all work from the browser', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 40,
  });
  const order = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 12 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  // The queue offers the order, and says starting a box moves nothing.
  const queue = await agent.get('/fulfilment');
  assert.equal(queue.status, 200);
  assert.match(plain(queue.text), /ABC School/);
  assert.match(plain(queue.text), /Starting a box does not move stock/i);

  const started = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(queue.text) });
  assert.equal(started.status, 303);
  const shipmentUrl = started.headers.location;
  assert.match(shipmentUrl, /^\/fulfilment\//);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 40,
    'starting a box must not have taken anything off the shelf');

  // The pick list names where to walk and promises the stock is still there.
  const picking = await agent.get(shipmentUrl);
  assert.equal(picking.status, 200);
  const pickText = plain(picking.text);
  assert.match(pickText, /Main Warehouse/);
  assert.match(pickText, /Nothing in this box has left stock yet/i);
  assert.match(pickText, /Black Small Shirt/);

  const packed = await agent.post(`${shipmentUrl}/packed`)
    .type('form').send({ _csrf: csrfFrom(picking.text), packageCount: '2' });
  assert.equal(packed.status, 303);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 40,
    'packing must not have taken anything off the shelf either');

  // The one button that moves stock says so on its face.
  const readyToShip = await agent.get(shipmentUrl);
  const shipText = plain(readyToShip.text);
  assert.match(shipText, /Mark shipped\s*—\s*12 leaves stock/i);
  assert.match(shipText, /This is the step that moves stock/i);

  const shipped = await agent.post(`${shipmentUrl}/ship`).type('form').send({
    _csrf: csrfFrom(readyToShip.text), trackingNumber: '1Z999AA10123456784', service: 'Ground',
  });
  assert.equal(shipped.status, 303);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 28,
    'shipping is where stock leaves');
  assert.equal(sales.getOrder(env.db, env.workspace.workspaceId, order.id).status, 'FULFILLED');

  // The carrier was read off the number nobody was asked to name.
  const gone = await agent.get(shipmentUrl);
  assert.match(plain(gone.text), /UPS/);
  assert.match(gone.text, /https:\/\/www\.ups\.com\/track\?tracknum=1Z999AA10123456784/);

  const delivered = await agent.post(`${shipmentUrl}/delivered`)
    .type('form').send({ _csrf: csrfFrom(gone.text) });
  assert.equal(delivered.status, 303);
  assert.match(plain((await agent.get(shipmentUrl)).text), /Delivered/);
});

test('the sales order names its fulfilment state and links the box that carried it', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const order = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 5 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  assert.equal(page.status, 200);
  assert.match(plain(page.text), /Ready to pick/);
  assert.match(plain(page.text), /Start picking 5 units/);

  const started = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) });
  const shipmentUrl = started.headers.location;

  page = await agent.get(`/sales/orders/${order.id}`);
  assert.match(plain(page.text), /Picking/);
  assert.match(page.text, new RegExp(shipmentUrl), 'the order should link to the box carrying it');
  assert.match(plain(page.text), /SHP-1001/);
});

test('an order with nothing committed says why there is nothing to pick', async () => {
  const env = setup();
  const order = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 4 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/sales/orders/${order.id}`);
  const text = plain(page.text);
  assert.match(text, /Waiting for stock/);
  assert.match(text, /nothing is committed to this order yet/i);
  assert.doesNotMatch(text, /Start picking/, 'there is nothing to pick, so no button offers to');

  // And asking anyway is refused in words, not with a stack trace.
  const refused = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) });
  assert.equal(refused.status, 303);
  assert.match(plain((await agent.get(refused.headers.location)).text), /Nothing is allocated/i);
});

test('an empty fulfilment queue says so rather than showing an empty table', async () => {
  const env = setup();
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const queue = await agent.get('/fulfilment');
  assert.equal(queue.status, 200);
  assert.match(plain(queue.text), /Nothing to pick/);
  assert.doesNotMatch(queue.text, /<tbody>/);
});

test('with a box open, the direct ship form stands down and its route refuses', async () => {
  const env = setup();
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: 20,
  });
  const order = sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerName: 'ABC School', lines: [{ skuId: env.item.skuId, quantity: 6 }],
  }).id);

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  assert.match(plain(page.text), /Record the items as shipped/,
    'with no box open the direct form is the fast path and should be offered');

  await agent.post(`/sales/orders/${order.id}/pick`).type('form').send({ _csrf: csrfFrom(page.text) });

  page = await agent.get(`/sales/orders/${order.id}`);
  assert.doesNotMatch(plain(page.text), /Record the items as shipped/,
    'a box already claims this stock, so the second door closes');
  assert.match(plain(page.text), /already holds 6 units/);

  // The button can still be sitting on a page somebody left open.
  const refused = await agent.post(`/sales/orders/${order.id}/fulfill`).type('form').send({
    _csrf: csrfFrom(page.text), lineId: order.lines[0].id,
    locationId: env.workspace.main.id, quantity: '6',
  });
  assert.equal(refused.status, 303);
  assert.match(refused.headers.location, /^\/fulfilment\//);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.item.skuId, env.workspace.main.id), 20,
    'the refused shortcut must not have issued anything');
  assert.match(plain((await agent.get(refused.headers.location)).text), /is already open on this order/);
});
