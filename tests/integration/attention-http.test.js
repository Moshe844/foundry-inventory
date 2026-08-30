'use strict';

/**
 * Mission 3 over HTTP: the briefing, the evidence page, feedback, scoped
 * re-evaluation after a real operation, and Ask Foundry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const attention = require('../../src/attention/attention-engine');
const engine = require('../../src/domain/inventory-engine');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, csrfFrom, plain, signIn } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function setup({ provider, scenario = 'stockout' } = {}) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const built = scenario === 'healthy' ? scenarios.healthyScenario(store.db, workspace) : scenarios.stockoutScenario(store.db, workspace);
  attention.evaluate(store.db, workspace.workspaceId, { trigger: 'setup' });

  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'attention-http-test',
    aiProvider: provider || null,
  });
  return { ...store, workspace, app, scenario: built };
}

async function post(agent, path, body, formPath = '/attention') {
  const page = await agent.get(formPath);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

test('the overview leads with the briefing, not the counters', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get('/overview')).text);
  assert.match(page, /Today's briefing/);
  assert.match(page, /needs your attention/);
  assert.match(page, /Navy Oxford/);
  // The briefing appears before the stock counters.
  assert.ok(page.indexOf("Today's briefing") < page.indexOf('Units on hand'));
});

test('a healthy workspace is told plainly that nothing is wrong', async () => {
  const { app, workspace } = setup({ scenario: 'healthy' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const overview = plain((await agent.get('/overview')).text);
  assert.match(overview, /Nothing in your stock needs attention right now/);
  assert.match(overview, /All clear/);

  const briefing = plain((await agent.get('/attention')).text);
  assert.match(briefing, /Nothing needs your attention/);
  assert.ok(!/urgent/i.test(briefing.split('Nothing needs your attention')[0]), 'no invented alarm');
});

test('the briefing lists findings, most urgent first, each with a reason', async () => {
  const { app, workspace, db } = setup();
  scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'more' });

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const page = plain((await agent.get('/attention')).text);

  assert.match(page, /Needs attention now/);
  assert.match(page, /Navy Oxford/);
  assert.match(page, /Corduroy Cap/);
  assert.ok(page.indexOf('Navy Oxford') < page.indexOf('Corduroy Cap'), 'urgent first');
  assert.match(page, /were issued in the last/, 'the reason is on the card');
  assert.match(page, /Foundry recommends|Worth reviewing/, 'and a suggestion');
});

test('the detail page shows the evidence and separates estimates from measurements', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get(`/attention/${item.attentionId}`)).text);
  assert.match(page, /The evidence/);
  assert.match(page, /Current stock/);
  assert.match(page, /Foundry's working/);
  assert.match(page, /calculated from the measured figures above, not counted/);
  // A stockout has no operation Foundry can take, and it says so rather than
  // inventing a purchase action.
  assert.match(page, /draft the purchase order/);
  assert.match(page, /Detection rules/);
});

test('an evidence page cannot be opened across workspaces', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const other = seedWorkspace(db, { workspaceName: 'Interloper' });

  const agent = request.agent(app);
  await signIn(agent, other.account.email, other.account.password);
  const res = await agent.get(`/attention/${item.attentionId}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/attention');
});

test('acknowledging and dismissing work from the briefing', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  await post(agent, `/attention/${item.attentionId}/acknowledge`, { returnTo: '/attention' });
  assert.equal(attention.getAttention(db, workspace.workspaceId, item.attentionId).status, 'ACKNOWLEDGED');
  assert.match(plain((await agent.get('/attention')).text), /Being handled/);

  await post(agent, `/attention/${item.attentionId}/dismiss`, { returnTo: '/attention' });
  assert.equal(attention.getAttention(db, workspace.workspaceId, item.attentionId).status, 'DISMISSED');

  const open = plain((await agent.get('/attention')).text);
  assert.ok(!open.includes('Navy Oxford'), 'hidden from the open briefing');
  const hidden = plain((await agent.get('/attention?show=resolved')).text);
  assert.match(hidden, /Navy Oxford/);
  assert.match(hidden, /Hidden until/);
});

test('rating an item records it without changing what Foundry checks', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  await post(agent, `/attention/${item.attentionId}/rate`, { verdict: 'not_useful' }, `/attention/${item.attentionId}`);

  const page = plain((await agent.get(`/attention/${item.attentionId}`)).text);
  assert.match(page, /not useful/);
  assert.match(page, /will not quietly change what it checks/);
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1, 'still detected');
});

test('receiving stock resolves the warning without anyone asking', async () => {
  const { app, workspace, db, scenario } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1);

  const itemPage = await agent.get(`/inventory/${scenario.itemId}`);
  await agent
    .post(`/inventory/${scenario.itemId}/receive`)
    .type('form')
    .send({
      _csrf: csrfFrom(itemPage.text),
      skuId: scenario.skuId,
      locationId: workspace.main.id,
      quantity: '400',
      reference: 'PO-1',
    });

  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 0, 're-evaluated after the movement');
  const overview = plain((await agent.get('/overview')).text);
  assert.match(overview, /Nothing in your stock needs attention right now/);
});

test('an operation still succeeds if re-evaluation cannot run', async () => {
  const { app, workspace, db, scenario } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  // Break the interpretation layer only. Mission 1 must not care.
  const original = db.prepare;
  const itemPage = await agent.get(`/inventory/${scenario.itemId}`);
  const token = csrfFrom(itemPage.text);
  db.prepare = function patched(sql) {
    if (/attention_items/.test(sql)) throw new Error('attention layer is down');
    return original.call(this, sql);
  };

  let response;
  try {
    response = await agent
      .post(`/inventory/${scenario.itemId}/receive`)
      .type('form')
      .send({ _csrf: token, skuId: scenario.skuId, locationId: workspace.main.id, quantity: '25' });
  } finally {
    db.prepare = original;
  }

  assert.equal(response.status, 303, 'the receive completed');
  assert.equal(
    db.prepare('SELECT SUM(on_hand) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?').get(workspace.workspaceId, scenario.skuId).n,
    35
  );
  assert.equal(engine.verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('checking again re-runs detection on demand', async () => {
  const { app, workspace, db, scenario } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  engine.receive(db, workspace.ctx, { skuId: scenario.skuId, locationId: workspace.main.id, quantity: 900 });
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1, 'stale until asked');

  const res = await post(agent, '/attention/refresh', {});
  assert.equal(res.status, 303);
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 0);
});

test('Ask Foundry answers from the ledger and shows how it read the question', async () => {
  const provider = fakeProvider({
    intent: 'stock_level',
    entityQuery: 'navy oxford',
    locationQuery: '',
    windowDays: 30,
    limit: 10,
    unsupportedReason: '',
  });
  const { app, workspace } = setup({ provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get('/ask').query({ q: 'How many navy oxfords do we have?' })).text);
  assert.match(page, /How many navy oxfords do we have\?/);
  assert.match(page, /10 units on hand/);
  assert.match(page, /Foundry read this as .stock level./);
  assert.match(page, /changes are approved on the actions page/);
});

test('Ask Foundry says what it cannot do rather than guessing', async () => {
  const provider = fakeProvider({
    intent: 'unsupported',
    entityQuery: '',
    locationQuery: '',
    windowDays: 30,
    limit: 10,
    unsupportedReason: 'Foundry does not know what you paid for stock.',
  });
  const { app, workspace } = setup({ provider });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get('/ask').query({ q: 'What is our margin on these?' })).text);
  assert.match(page, /does not know what you paid/);
  assert.match(page, /Not something Foundry can answer/);
  // A refusal must still leave somewhere to go: the examples chips only showed
  // before a question was asked, so a refused question was a dead end.
  assert.match(page, /Here is what you can ask/);
  assert.match(page, /what Foundry can do today/);
});

test('every attention route needs a signed-in session', async () => {
  const { app, db, workspace } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const anonymous = request.agent(app);

  for (const path of ['/attention', `/attention/${item.attentionId}`, '/ask']) {
    const res = await anonymous.get(path);
    assert.equal(res.status, 302, `${path} must not be public`);
    assert.match(res.headers.location, /^\/login/);
  }

  // A session-less POST is turned away by CSRF before it ever reaches the route.
  const post_ = await anonymous.post(`/attention/${item.attentionId}/dismiss`).type('form').send({});
  assert.ok([302, 303, 403].includes(post_.status), `unexpected ${post_.status}`);
  assert.equal(attention.getAttention(db, workspace.workspaceId, item.attentionId).status, 'OPEN');
});

test('the item page says what Foundry has noticed about that item', async () => {
  const { app, workspace, db, scenario } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get(`/inventory/${scenario.itemId}`)).text);
  assert.match(page, /Running low/);
  assert.match(page, /may run out/);
  assert.match(page, /Why this\?/);
  assert.match(page, /Reorder settings/);
  assert.match(page, /Configure/);

  // A different item says nothing, rather than everything.
  const other = scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'more' });
  const quiet = plain((await agent.get(`/inventory/${other.itemId}`)).text);
  assert.ok(!quiet.includes('may run out'), "another item's finding does not leak here");
  assert.match(quiet, /has not moved/);
});

test('the item page is quiet when there is nothing to say', async () => {
  const { app, workspace, db, scenario } = setup({ scenario: 'healthy' });
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 0);

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const page = plain((await agent.get(`/inventory/${scenario.itemId}`)).text);
  assert.ok(!page.includes('Why this?'), 'no banner where there is no finding');
});

test('a dismissal can be given a duration', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const detail = await agent.get(`/attention/${item.attentionId}`);
  assert.match(plain(detail.text), /for 3 months/, 'the choice is offered');

  await agent
    .post(`/attention/${item.attentionId}/dismiss`)
    .type('form')
    .send({ _csrf: csrfFrom(detail.text), days: '90', returnTo: '/attention' });

  const stored = attention.getAttention(db, workspace.workspaceId, item.attentionId);
  const days = Math.round((new Date(stored.dismissedUntil) - Date.now()) / 86400000);
  assert.ok(days >= 89 && days <= 90, `expected about 90 days, got ${days}`);
});

test('a nonsense duration is refused, and nothing is hidden', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const detail = await agent.get(`/attention/${item.attentionId}`);
  const res = await agent
    .post(`/attention/${item.attentionId}/dismiss`)
    .type('form')
    .send({ _csrf: csrfFrom(detail.text), days: '99999' });

  assert.ok(res.status >= 300, 'refused');
  assert.equal(attention.getAttention(db, workspace.workspaceId, item.attentionId).status, 'OPEN');
});

test('the briefing shows what the team has said about each check', async () => {
  const { app, workspace, db } = setup();
  const [item] = attention.listAttention(db, workspace.workspaceId);
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  // Nothing to show before anyone has said anything.
  assert.ok(!plain((await agent.get('/attention')).text).includes('How Foundry is doing'));

  await post(agent, `/attention/${item.attentionId}/rate`, { verdict: 'not_useful' }, `/attention/${item.attentionId}`);

  const page = plain((await agent.get('/attention')).text);
  assert.match(page, /How Foundry is doing/);
  assert.match(page, /Running low\s+1 not useful/);
  assert.match(page, /does not quietly re-tune/);
});

test('a long briefing is paged, and the counts describe the whole of it', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.configure(db, workspace.workspaceId);
  const itemService = require('../../src/domain/item-service');
  const repo = require('../../src/domain/repository');

  // Thirty separate lines, each left sitting for months.
  for (let i = 0; i < 30; i += 1) {
    const created = itemService.createItem(db, workspace.ctx, {
      name: `Idle Line ${i}`,
      baseCode: `IL-${i}`,
      trackingMode: 'quantity',
    });
    const sku = repo.listSkusForItem(db, workspace.workspaceId, created.itemId)[0];
    scenarios.at(db, workspace.ctx, 200, 'receive', { skuId: sku.id, locationId: workspace.main.id, quantity: 40 });
    scenarios.at(db, workspace.ctx, 170, 'issue', { skuId: sku.id, locationId: workspace.main.id, quantity: 5, reasonCode: 'sold' });
  }
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const app = createApp({ db, env: 'test', sessionSecret: 'paging-test' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const first = plain((await agent.get('/attention')).text);
  assert.match(first, /30 things Foundry thinks you should look at/, 'the count is the whole set');
  assert.match(first, /1–25 of 30/);
  assert.match(first, /Next/);
  assert.ok(!first.includes('Previous'));

  const second = plain((await agent.get('/attention?page=2')).text);
  assert.match(second, /26–30 of 30/);
  assert.match(second, /Previous/);
  assert.ok(!second.includes('Next'));

  // Out-of-range pages clamp rather than showing an empty briefing.
  assert.match(plain((await agent.get('/attention?page=99')).text), /26–30 of 30/);
  assert.match(plain((await agent.get('/attention?page=abc')).text), /1–25 of 30/);
});

test('the nav shows a live count of what is open', async () => {
  const { app, workspace } = setup();
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const html = (await agent.get('/')).text;
  assert.match(html, /nav-count">1</);
});

/**
 * A page someone deliberately clicked must answer them. An empty inventory used
 * to be redirected to Foundry setup, which looked exactly like a broken link:
 * you click "Needs attention" and end up somewhere you did not ask for.
 */
test('an empty inventory gets an answer, not a silent redirect', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Brand New' });
  // Genuinely empty: no locations, no items, no configuration.
  db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  db.prepare('DELETE FROM workspace_configuration WHERE workspace_id = ?').run(workspace.workspaceId);

  const app = createApp({ db, env: 'test', sessionSecret: 'empty-attention' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await agent.get('/attention');
  assert.equal(res.status, 200, 'the page renders rather than redirecting');

  const page = plain(res.text);
  assert.match(page, /There is nothing in this inventory yet/);
  assert.match(page, /Set this inventory up/);
  assert.ok(!page.includes('Nothing in your stock needs attention'), 'empty is not the same as healthy');
});

test('a configured but quiet inventory still says all clear', async () => {
  const { app, workspace } = setup({ scenario: 'healthy' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const res = await agent.get('/attention');
  assert.equal(res.status, 200);
  const page = plain(res.text);
  assert.match(page, /Nothing needs your attention/);
  assert.ok(!page.includes('There is nothing in this inventory yet'));
});

test('learning demand stays contextual and does not become a fake Needs you decision', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  store.db.prepare(
    `INSERT INTO workspace_configuration
       (workspace_id, configured_at, configuration_version, terminology, operational_defaults, inventory_model, updated_at)
     VALUES (?, datetime('now'), 1, '{}', '{}', '{"primaryArchetype":"quantity"}', datetime('now'))`
  ).run(workspace.workspaceId);

  // Stock on hand, no outbound history: nothing is wrong, and Foundry is still
  // missing the operating signal it needs.
  const item = makeQuantityItem(store.db, workspace.ctx);
  engine.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 20 });

  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'agree' });
  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const needsYou = plain((await agent.get('/needs-you')).text);
  const overview = plain((await agent.get('/overview')).text);

  assert.match(needsYou, /Nothing is waiting/);
  assert.match(overview, /All clear/);
  assert.doesNotMatch(needsYou, /Tell Foundry when you sell something/,
    'normal learning guidance belongs on Home, not in the decision inbox');
});
