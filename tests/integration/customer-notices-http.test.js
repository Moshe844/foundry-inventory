'use strict';

/*
 * Shipping notices through the screens.
 *
 * The engine tests prove the words are made only of records. These prove the
 * owner gets the last read of them: nothing reaches a customer without a
 * person pressing send, unless that person has set it otherwise.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const inventory = require('../../src/domain/inventory-engine');
const sales = require('../../src/sales/sales-order-service');
const notices = require('../../src/sales/customer-communications');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Riverside Supply' });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Black Small Shirt', baseCode: 'BLACK-S' });
  prices.setPrice(db, workspace.ctx, { skuId: item.skuId, amount: '25.00', currency: 'USD' });
  const app = createApp({ db, env: 'test', sessionSecret: 'customer-notices' });
  return { db, workspace, item, app };
}

function shippedOrder(env, quantity = 6) {
  const customer = sales.createCustomer(env.db, env.workspace.ctx, {
    name: 'ABC School', email: 'orders@abcschool.test',
  });
  inventory.receive(env.db, env.workspace.ctx, {
    skuId: env.item.skuId, locationId: env.workspace.main.id, quantity: quantity * 3,
  });
  return sales.confirm(env.db, env.workspace.ctx, sales.createOrder(env.db, env.workspace.ctx, {
    customerId: customer.id, lines: [{ skuId: env.item.skuId, quantity }],
  }).id);
}

test('shipping writes the customer a note, shows it in full, and sends nothing on its own', async () => {
  const env = setup();
  const order = shippedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/sales/orders/${order.id}`);
  const started = await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) });
  const url = started.headers.location;

  const packed = await agent.get(url);
  await agent.post(`${url}/packed`).type('form').send({ _csrf: csrfFrom(packed.text) });
  const ready = await agent.get(url);
  const shipped = await agent.post(`${url}/ship`).type('form').send({
    _csrf: csrfFrom(ready.text), trackingNumber: '1Z999AA10123456784', service: 'Ground',
  });
  assert.equal(shipped.status, 303);

  const after = await agent.get(url);
  const text = plain(after.text);
  assert.match(text, /Tell the customer/);
  assert.match(text, /Written, not sent/);
  assert.match(text, /Ready to send to orders@abcschool\.test/);
  assert.match(after.text, /value="Your order SO-1001 has shipped"/,
    'the subject sits in an input, editable before it goes');
  assert.match(text, /Tracking number: 1Z999AA10123456784/);
  assert.match(text, /A note to the customer is written below/,
    'the flash after shipping should say the customer has not been told yet');

  const stored = notices.forOrder(env.db, env.workspace.workspaceId, order.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'PREPARED', 'nothing left the building on its own');
});

test('the owner can rewrite the words, and what they save is what would go', async () => {
  const env = setup();
  const order = shippedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  const url = (await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) })).headers.location;
  page = await agent.get(url);
  await agent.post(`${url}/ship`).type('form').send({ _csrf: csrfFrom(page.text) });

  page = await agent.get(url);
  const message = notices.forOrder(env.db, env.workspace.workspaceId, order.id)[0];
  const saved = await agent.post(`${url}/notice`).type('form').send({
    _csrf: csrfFrom(page.text), messageId: message.id, action: 'save',
    subject: 'Your shirts are on the way', body: 'Hi — I put a sample in the box for you.',
  });
  assert.equal(saved.status, 303);

  const reread = notices.get(env.db, env.workspace.workspaceId, message.id);
  assert.equal(reread.subject, 'Your shirts are on the way');
  assert.match(reread.body, /sample in the box/);
  assert.equal(reread.status, 'PREPARED', 'saving is not sending');
  assert.match(plain((await agent.get(url)).text), /Nothing has been sent/);

  // And starting again restores what the records actually say.
  page = await agent.get(url);
  await agent.post(`${url}/notice`).type('form')
    .send({ _csrf: csrfFrom(page.text), messageId: message.id, action: 'rewrite' });
  assert.match(notices.get(env.db, env.workspace.workspaceId, message.id).body, /Black Small Shirt/);
});

test('with no mailbox connected the page says so instead of offering a dead button', async () => {
  const env = setup();
  const order = shippedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  const url = (await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) })).headers.location;
  page = await agent.get(url);
  await agent.post(`${url}/ship`).type('form').send({ _csrf: csrfFrom(page.text) });

  const text = plain((await agent.get(url)).text);
  assert.match(text, /No mailbox is connected/);
  assert.match(text, /Copy the words above into your own email/);
  assert.doesNotMatch(text, /Send to orders@abcschool\.test/,
    'there is nothing to send through, so nothing offers to');
});

test('the fulfilment page lists customers not yet told, and holds the setting', async () => {
  const env = setup();
  const order = shippedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  const url = (await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) })).headers.location;
  page = await agent.get(url);
  await agent.post(`${url}/ship`).type('form').send({ _csrf: csrfFrom(page.text) });

  const queue = await agent.get('/fulfilment');
  const text = plain(queue.text);
  assert.match(text, /Waiting to be sent/);
  assert.match(text, /1 customer has\s+not been told their order shipped/);
  assert.match(text, /ABC School/);
  assert.match(text, /What customers are told when an order ships/);

  // Asking Foundry to send without naming a mailbox is refused in words.
  const refused = await agent.post('/fulfilment/settings/notices')
    .type('form').send({ _csrf: csrfFrom(queue.text), shippingNotice: 'send' });
  assert.equal(refused.status, 303);
  assert.match(plain((await agent.get('/fulfilment')).text), /Choose which mailbox/);
  assert.equal(notices.policy(env.db, env.workspace.workspaceId).shippingNotice, 'prepare');

  // Turning them off is allowed, and remembered.
  const off = await agent.post('/fulfilment/settings/notices')
    .type('form').send({ _csrf: csrfFrom(queue.text), shippingNotice: 'off' });
  assert.equal(off.status, 303);
  assert.equal(notices.policy(env.db, env.workspace.workspaceId).shippingNotice, 'off');
});

test('a cancelled note stops asking to be sent', async () => {
  const env = setup();
  const order = shippedOrder(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  let page = await agent.get(`/sales/orders/${order.id}`);
  const url = (await agent.post(`/sales/orders/${order.id}/pick`)
    .type('form').send({ _csrf: csrfFrom(page.text) })).headers.location;
  page = await agent.get(url);
  await agent.post(`${url}/ship`).type('form').send({ _csrf: csrfFrom(page.text) });

  const message = notices.forOrder(env.db, env.workspace.workspaceId, order.id)[0];
  page = await agent.get(url);
  await agent.post(`${url}/notice`).type('form')
    .send({ _csrf: csrfFrom(page.text), messageId: message.id, action: 'cancel' });

  assert.equal(notices.get(env.db, env.workspace.workspaceId, message.id).status, 'CANCELLED');
  assert.doesNotMatch(plain((await agent.get('/fulfilment')).text), /Waiting to be sent/);
  assert.match(plain((await agent.get(url)).text), /Not sent/);
});
