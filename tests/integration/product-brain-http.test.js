'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, csrfFrom, plain, signIn } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'product-brain-http-contract' });
  return { ...store, workspace, app };
}

test('Take me navigation redirects, verifies arrival, and preserves return context', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email);
  const home = await agent.get('/');
  const sent = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Take me to forecasting',
  });
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.location, '/planning');
  const arrived = await agent.get('/planning');
  assert.equal(arrived.status, 200);
  const text = plain(arrived.text);
  assert.match(text, /StockChief opened the requested place: Planning and forecasts/i);
  assert.match(text, /Back to your question/i);
  assert.match(arrived.text, /href="\/ask\?q=Take%20me%20to%20forecasting"/i);
});

test('Where questions provide one exact destination without requiring the language model', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email);
  const response = await agent.get('/ask?q=Where%20do%20I%20receive%20purchase%20orders');
  assert.equal(response.status, 200);
  assert.match(plain(response.text), /manage this in Purchasing|Open Purchasing/i);
  assert.match(response.text, /href="\/foundry\/navigate\?to=%2Fpurchasing/);
});

test('ordinary owner wording is interpreted into a canonical destination before the general AI path', async () => {
  const { app, workspace } = setup();
  let interpretationCalls = 0;
  app.locals.aiProvider = {
    complete: async (request) => {
      interpretationCalls += 1;
      assert.equal(request.schemaName, 'foundry_product_destination');
      return { data: { destinationId: 'sales', reason: 'The owner wants the customer-order area.' } };
    },
  };
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email);
  const home = await agent.get('/');
  const sent = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text), message: 'Where is the order section?',
  });
  assert.equal(sent.status, 303);
  assert.match(sent.headers.location, /^\/ask\?q=Where%20is%20the%20order%20section/);
  const answer = await agent.get(sent.headers.location);
  assert.equal(answer.status, 200);
  assert.match(plain(answer.text), /manage this in Sales orders/i);
  assert.match(answer.text, /foundry\/navigate\?to=%2Fsales/);
  assert.ok(interpretationCalls >= 1);
});

test('Where questions never expose a destination the signed-in role cannot open', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.staffEmail);
  const response = await agent.get('/ask?q=Where%20is%20accounting');
  assert.equal(response.status, 200);
  assert.match(plain(response.text), /cannot expose|does not include/i);
  assert.doesNotMatch(response.text, /foundry\/navigate\?to=%2Faccounting/);
});

test('legacy and current sales URLs remain compatible', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email);
  assert.equal((await agent.get('/orders')).status, 200);
  assert.equal((await agent.get('/sales')).status, 200);
});
