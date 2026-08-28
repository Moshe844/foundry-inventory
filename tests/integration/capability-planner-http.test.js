'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { makeDatabase, cleanupAll, seedWorkspace, signIn, csrfFrom, makeQuantityItem, plain } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');

test.after(cleanupAll);

test('Tell Foundry routes a new code-change paraphrase through the shared capability plan and preview', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Capability HTTP Co' });
  const item = makeQuantityItem(store.db, workspace.ctx, { name: 'Travel Mug', baseCode: 'TS-100' });
  const provider = fakeProvider((req) => {
    assert.equal(req.schemaName, 'manager_intent');
    return {
      capabilityId: 'catalog.transform-internal-codes', intentClass: 'CATALOG_CHANGE',
      confidence: 'high', goal: 'Change every TS prefix to ME.',
      reason: 'This is an internal catalogue-code transformation.', resolvedReference: '',
      clarifyingQuestion: '', parameters: {
        fromText: 'TS', toText: 'ME', transformMode: 'prefix', documentReference: '',
      },
    };
  });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'capability-http', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const home = await agent.get('/');
  const response = await agent.post('/foundry/tell').type('form').send({
    _csrf: csrfFrom(home.text),
    message: 'Standardize our catalogue: anything starting TS should start ME instead.',
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.location, /^\/catalog-code-changes\/ccp_/);
  const preview = plain((await agent.get(response.headers.location)).text);
  assert.match(preview, /TS-100/);
  assert.match(preview, /ME-100/);
  assert.match(preview, /Nothing has changed yet|Review/i);

  const unchanged = store.db.prepare('SELECT base_code FROM items WHERE id = ?').get(item.itemId);
  assert.equal(unchanged.base_code, 'TS-100', 'the model-selected capability still only creates a preview');
  assert.equal(provider.calls.length, 1, 'one general plan selected the operation');
  store.db.close();
});

