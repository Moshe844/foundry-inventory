'use strict';

/**
 * Controlled actions over HTTP.
 *
 * The cases that matter here are the ones a browser causes by itself: a
 * double-clicked approve, a refreshed result page, a replayed POST, and a
 * person without permission going straight at the URL.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const authService = require('../../src/domain/auth-service');
const attention = require('../../src/attention/attention-engine');
const proposals = require('../../src/actions/proposal-service');
const permissions = require('../../src/actions/permissions');
const { createApp } = require('../../src/app');
const {
  makeDatabase, cleanupAll, seedWorkspace, makeVariantItem, csrfFrom, plain, signIn,
} = require('../helpers');
const scenarios = require('../helpers/scenarios');
const { fakeProvider } = require('../helpers/fake-provider');

test.after(cleanupAll);

/** A clothing workspace at the mission's starting numbers. */
function setup({ provider } = {}) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db, { workspaceName: 'Clothing Business' });
  const item = makeVariantItem(store.db, workspace.ctx);
  const navy4 = item.byLabel('Navy / 4');
  engine.receive(store.db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 4 });
  engine.receive(store.db, workspace.ctx, { skuId: navy4.id, locationId: workspace.main.id, quantity: 48 });

  const app = createApp({
    db: store.db,
    env: 'test',
    sessionSecret: 'actions-http-test',
    aiProvider: provider || null,
  });
  return { ...store, workspace, app, item, navy4 };
}

const intentResponse = (over = {}) => ({
  lines: [
    {
      actionType: 'transfer',
      item: "Children's Sweater",
      variant: 'Navy 4',
      lotCode: '',
      serials: [],
      sourceLocation: 'Main Warehouse',
      destinationLocation: 'Downtown Store',
      quantity: 15,
      adjustmentTarget: -1,
      reasonCode: '',
      terminologyKey: '',
      terminologyValue: '',
      productName: '',
      productCode: '',
      variantAxes: '',
      unitLabel: '',
      supplier: '',
      purchaseUnit: '',
      ...over,
    },
  ],
  clarifyingQuestion: '',
  unsupportedReason: '',
});

async function post(agent, path, body, formPath = '/actions') {
  const page = await agent.get(formPath);
  return agent.post(path).type('form').send({ _csrf: csrfFrom(page.text), ...body });
}

function makeProposal(env) {
  const built = proposals.build(env.db, env.workspace.ctx, {
    actionType: 'transfer',
    item: "Children's Sweater",
    variant: 'Navy 4',
    serials: [],
    sourceLocation: 'Main Warehouse',
    destinationLocation: 'Downtown Store',
    quantity: 15,
  });
  assert.ok(built.ok, built.question);
  return proposals.persist(env.db, env.workspace.ctx, built.proposal, { instruction: 'move 15' });
}

const balance = (env, locationId) =>
  repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, locationId);

// --- natural language --------------------------------------------------------

test('a written instruction becomes a preview, not a movement', async () => {
  const env = setup({ provider: fakeProvider(intentResponse()) });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const res = await post(agent, '/actions/ask', { instruction: 'Move 15 Navy 4 from Main Warehouse to Downtown Store' });
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/actions\/act_/);

  const preview = plain((await agent.get(res.headers.location)).text);
  assert.match(preview, /Foundry is ready to transfer/);
  assert.match(preview, /Children's Sweater \/ Navy \/ 4/);
  assert.match(preview, /Main Warehouse\s+stock leaves here\s+48\s+33/);
  assert.match(preview, /Downtown Store\s+stock arrives here\s+4\s+19/);
  assert.match(preview, /unchanged — stock only moves/);
  assert.match(preview, /Approve transfer/);

  // Nothing has moved yet.
  assert.equal(balance(env, env.workspace.main.id), 48);
  assert.equal(balance(env, env.workspace.store.id), 4);
});

test('an unknown transfer destination offers to create it, then previews and verifies the transfer', async () => {
  const env = setup({ provider: fakeProvider(intentResponse({ destinationLocation: 'Overflow Warehouse', quantity: 2 })) });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const asked = await post(agent, '/actions/ask', {
    instruction: 'Move 2 Navy 4 from Main Warehouse to Overflow Warehouse',
  });
  assert.equal(asked.status, 303);
  assert.equal(asked.headers.location, '/actions/location-required');

  const setupPage = await agent.get('/actions/location-required');
  const setupText = plain(setupPage.text);
  assert.match(setupText, /Overflow Warehouse does not exist yet/);
  assert.match(setupText, /New warehouse\s+Overflow Warehouse/);
  assert.match(setupText, /Locations\s+2\s+3/);
  assert.match(setupText, /Stock changed\s+None/);
  assert.match(setupText, /Create location and continue/);
  assert.equal(env.db.prepare(
    'SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND name = ?'
  ).get(env.workspace.workspaceId, 'Overflow Warehouse').n, 0, 'the preview creates nothing');
  assert.equal(balance(env, env.workspace.main.id), 48);

  const continued = await agent.post('/actions/location-required').type('form').send({
    _csrf: csrfFrom(setupPage.text), decision: 'create',
  });
  assert.equal(continued.status, 303);
  assert.match(continued.headers.location, /^\/actions\/act_/);

  const overflow = env.db.prepare(
    'SELECT * FROM locations WHERE workspace_id = ? AND name = ?'
  ).get(env.workspace.workspaceId, 'Overflow Warehouse');
  assert.ok(overflow);
  assert.equal(overflow.kind, 'warehouse');
  assert.equal(balance(env, env.workspace.main.id), 48, 'creating the location must not move stock');
  assert.equal(balance(env, overflow.id), 0);

  const transferPage = await agent.get(continued.headers.location);
  const transferText = plain(transferPage.text);
  assert.match(transferText, /Foundry is ready to transfer/);
  assert.match(transferText, /Main Warehouse\s+stock leaves here\s+48\s+46/);
  assert.match(transferText, /Overflow Warehouse\s+stock arrives here\s+0\s+2/);
  assert.match(transferText, /Total on hand\s+unchanged.+stock only moves\s+52\s+52/);
  assert.match(transferText, /no stock has moved yet/i);

  const approved = await agent.post(continued.headers.location + '/approve').type('form').send({
    _csrf: csrfFrom(transferPage.text),
  });
  assert.equal(approved.status, 303);
  await agent.get(approved.headers.location);

  const result = plain((await agent.get(continued.headers.location)).text);
  assert.match(result, /Verified against your records/);
  assert.match(result, /Main Warehouse\s+48\s+46/);
  assert.match(result, /Overflow Warehouse\s+0\s+2/);
  assert.match(result, /Total on hand\s+52\s+52/);
  assert.equal(balance(env, env.workspace.main.id), 46);
  assert.equal(balance(env, overflow.id), 2);
});

test('an instruction Foundry cannot carry out is refused honestly', async () => {
  const env = setup({
    provider: fakeProvider({
      lines: [],
      clarifyingQuestion: '',
      unsupportedReason: 'Foundry cannot raise purchase orders — it can only move stock you already have.',
    }),
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const res = await post(agent, '/actions/ask', { instruction: 'Order 500 more from the supplier' });
  const page = plain(res.text);
  assert.match(page, /cannot raise purchase orders/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
});

test('an ambiguous instruction asks rather than guesses', async () => {
  const env = setup({
    provider: fakeProvider({
      lines: [],
      clarifyingQuestion: 'Did those 4 units leave the business, or was the count simply wrong?',
      unsupportedReason: '',
    }),
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = plain((await post(agent, '/actions/ask', { instruction: 'take 4 off Downtown' })).text);
  assert.match(page, /Did those 4 units leave the business/);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
});

// --- approval and execution --------------------------------------------------

test('approving carries the action out and reports exactly what changed', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const approved = await post(agent, `/actions/${proposal.proposalId}/approve`, {}, `/actions/${proposal.proposalId}`);
  assert.equal(approved.status, 303);
  await agent.get(approved.headers.location);

  const page = plain((await agent.get(`/actions/${proposal.proposalId}`)).text);
  assert.match(page, /Done/);
  assert.match(page, /Verified against your records/);
  assert.match(page, /Main Warehouse\s+48\s+33/);
  assert.match(page, /Downtown Store\s+4\s+19/);

  assert.equal(balance(env, env.workspace.main.id), 33);
  assert.equal(balance(env, env.workspace.store.id), 19);
  assert.equal(engine.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);
});

test('a double-clicked approval moves stock once', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/actions/${proposal.proposalId}`);
  const token = csrfFrom(page.text);

  // Two approvals fired together, exactly as a double-click produces.
  const [first, second] = await Promise.all([
    agent.post(`/actions/${proposal.proposalId}/approve`).type('form').send({ _csrf: token }),
    agent.post(`/actions/${proposal.proposalId}/approve`).type('form').send({ _csrf: token }),
  ]);
  await agent.get(`/actions/${proposal.proposalId}/run`);
  await agent.get(`/actions/${proposal.proposalId}/run`);

  assert.ok([303, 302].includes(first.status));
  assert.ok([303, 302].includes(second.status));
  assert.equal(balance(env, env.workspace.main.id), 33, 'moved once');
  assert.equal(balance(env, env.workspace.store.id), 19);
  assert.equal(
    env.db.prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'transfer'")
      .get(env.workspace.workspaceId).n,
    2
  );
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_executions').get().n, 1);
});

test('refreshing the result page does not run it again', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  await post(agent, `/actions/${proposal.proposalId}/approve`, {}, `/actions/${proposal.proposalId}`);
  for (let i = 0; i < 4; i += 1) await agent.get(`/actions/${proposal.proposalId}/run`);

  assert.equal(balance(env, env.workspace.main.id), 33);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_executions').get().n, 1);
});

test('a replayed approve POST after execution changes nothing', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const page = await agent.get(`/actions/${proposal.proposalId}`);
  const token = csrfFrom(page.text);
  await agent.post(`/actions/${proposal.proposalId}/approve`).type('form').send({ _csrf: token });
  await agent.get(`/actions/${proposal.proposalId}/run`);

  // The same request, sent again later.
  await agent.post(`/actions/${proposal.proposalId}/approve`).type('form').send({ _csrf: token });
  await agent.get(`/actions/${proposal.proposalId}/run`);

  assert.equal(balance(env, env.workspace.main.id), 33);
  assert.equal(balance(env, env.workspace.store.id), 19);
});

// --- staleness ---------------------------------------------------------------

test('a proposal whose stock has moved is shown as recalculated, not executed', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  engine.issue(env.db, env.workspace.ctx, {
    skuId: env.navy4.id, locationId: env.workspace.main.id, quantity: 17, reasonCode: 'sold',
  });

  const preview = plain((await agent.get(`/actions/${proposal.proposalId}`)).text);
  assert.match(preview, /The stock changed since Foundry worked this out/);
  assert.match(preview, /Main Warehouse\s+stock leaves here\s+31/, 'the current figure is shown');

  const res = await post(agent, `/actions/${proposal.proposalId}/approve`, {}, `/actions/${proposal.proposalId}`);
  assert.equal(res.status, 303);
  const after = plain((await agent.get(`/actions/${proposal.proposalId}`)).text);
  assert.match(after, /changed since/i);

  assert.equal(balance(env, env.workspace.main.id), 31, 'nothing was executed');
  assert.equal(balance(env, env.workspace.store.id), 4);
});

test('the quantity can be changed, and the new one needs approving', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const res = await post(agent, `/actions/${proposal.proposalId}/quantity`, { quantity: '12' }, `/actions/${proposal.proposalId}`);
  assert.equal(res.status, 303);
  const revisedId = res.headers.location.split('/').pop();
  assert.notEqual(revisedId, proposal.proposalId);

  const page = plain((await agent.get(res.headers.location)).text);
  assert.match(page, /Main Warehouse\s+stock leaves here\s+48\s+36/);
  assert.match(page, /Approve transfer/);
  assert.equal(balance(env, env.workspace.main.id), 48, 'still nothing has moved');

  await post(agent, `/actions/${revisedId}/approve`, {}, `/actions/${revisedId}`);
  await agent.get(`/actions/${revisedId}/run`);
  assert.equal(balance(env, env.workspace.main.id), 36);
  assert.equal(balance(env, env.workspace.store.id), 16);
});

// --- permissions -------------------------------------------------------------

test('permission is enforced on the server, not by hiding a button', async () => {
  const env = setup();
  const staffAccountId = env.db
    .prepare('SELECT account_id FROM users WHERE id = ?')
    .get(env.workspace.staffId).account_id;

  const built = proposals.build(env.db, env.workspace.ctx, {
    actionType: 'adjust',
    item: "Children's Sweater",
    variant: 'Navy 4',
    serials: [],
    sourceLocation: 'Main Warehouse',
    adjustmentTarget: 37,
    reasonCode: 'physical_count',
  });
  const proposal = proposals.persist(env.db, env.workspace.ctx, built.proposal, {});

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.staffEmail, 'password123');

  const preview = plain((await agent.get(`/actions/${proposal.proposalId}`)).text);
  assert.match(preview, /do not have permission/);
  assert.ok(!preview.includes('Approve the correction'));

  // Going straight at the URL is refused just the same.
  const res = await post(agent, `/actions/${proposal.proposalId}/approve`, {}, `/actions/${proposal.proposalId}`);
  assert.ok(res.status >= 400 || res.status === 303);
  assert.equal(balance(env, env.workspace.main.id), 48, 'the correction did not happen');
  assert.equal(
    proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId).status,
    'AWAITING_APPROVAL'
  );
});

test('an operator can transfer but not correct', async () => {
  const env = setup();
  const staff = authService.getMembership(
    env.db,
    env.workspace.workspaceId,
    env.db.prepare('SELECT account_id FROM users WHERE id = ?').get(env.workspace.staffId).account_id
  );
  assert.ok(permissions.can(staff, permissions.OPERATE));
  assert.ok(!permissions.can(staff, permissions.ADJUST));

  const proposal = makeProposal(env);
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.staffEmail, 'password123');

  await post(agent, `/actions/${proposal.proposalId}/approve`, {}, `/actions/${proposal.proposalId}`);
  await agent.get(`/actions/${proposal.proposalId}/run`);
  assert.equal(balance(env, env.workspace.main.id), 33);

  // And the ledger names the person who actually approved it.
  const movement = env.db
    .prepare("SELECT * FROM movements WHERE workspace_id = ? AND operation = 'transfer' LIMIT 1")
    .get(env.workspace.workspaceId);
  assert.equal(movement.actor_user_id, env.workspace.staffId);
});

// --- warnings ----------------------------------------------------------------

test('a large removal shows its warning and needs an extra confirmation', async () => {
  const env = setup();
  const built = proposals.build(env.db, env.workspace.ctx, {
    actionType: 'issue',
    item: "Children's Sweater",
    variant: 'Navy 4',
    serials: [],
    sourceLocation: 'Main Warehouse',
    quantity: 47,
    reasonCode: 'sold',
  });
  const proposal = proposals.persist(env.db, env.workspace.ctx, built.proposal, {});

  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);
  const page = await agent.get(`/actions/${proposal.proposalId}`);
  const text = plain(page.text);

  assert.match(text, /97\.9% of the stock available here/);
  assert.match(text, /I have read the warning/);
  assert.match(page.text, /name="acknowledged" required/, 'the extra confirmation is required');
});

// --- from a finding ----------------------------------------------------------

test('a finding offers a review, never a "do it now"', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  scenarios.imbalanceScenario(store.db, workspace);
  attention.evaluate(store.db, workspace.workspaceId, { trigger: 'test' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'attention-action' });

  const finding = attention
    .listAttention(store.db, workspace.workspaceId)
    .find((i) => i.category === 'location_imbalance' || i.relatedCategories.includes('location_imbalance'));

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);

  const detail = plain((await agent.get(`/attention/${finding.attentionId}`)).text);
  assert.match(detail, /Review transfer/);
  assert.ok(!detail.includes('Transfer now'));
  assert.match(detail, /Nothing moves until you approve it/);

  const res = await post(
    agent, `/attention/${finding.attentionId}/action`, {}, `/attention/${finding.attentionId}`
  );
  assert.equal(res.status, 303);
  assert.match(res.headers.location, /^\/actions\/act_/);

  const preview = plain((await agent.get(res.headers.location)).text);
  assert.match(preview, /Foundry is ready to transfer/);
  assert.match(preview, /A Foundry finding/);
});

test('a stockout finding offers no action at all', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  scenarios.stockoutScenario(store.db, workspace);
  attention.evaluate(store.db, workspace.workspaceId, { trigger: 'test' });
  const app = createApp({ db: store.db, env: 'test', sessionSecret: 'attention-noaction' });
  const [finding] = attention.listAttention(store.db, workspace.workspaceId);

  const agent = request.agent(app);
  await signIn(agent, workspace.account.email, workspace.account.password);
  const detail = plain((await agent.get(`/attention/${finding.attentionId}`)).text);

  assert.ok(!detail.includes('Review transfer'));
  assert.match(detail, /draft the purchase order/);
});

// --- access ------------------------------------------------------------------

test('every action route needs a signed-in session', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const anonymous = request.agent(env.app);

  for (const path of ['/actions', `/actions/${proposal.proposalId}`]) {
    const res = await anonymous.get(path);
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /^\/login/);
  }
  await anonymous.post(`/actions/${proposal.proposalId}/approve`).type('form').send({});
  assert.equal(balance(env, env.workspace.main.id), 48);
});

test('a proposal from another inventory is not found over HTTP', async () => {
  const env = setup();
  const proposal = makeProposal(env);
  const other = seedWorkspace(env.db, { workspaceName: 'Elsewhere' });

  const agent = request.agent(env.app);
  await signIn(agent, other.account.email, other.account.password);

  const res = await agent.get(`/actions/${proposal.proposalId}`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/actions');

  await post(agent, `/actions/${proposal.proposalId}/approve`, {}, '/actions');
  assert.equal(balance(env, env.workspace.main.id), 48, 'untouched');
  assert.equal(
    proposals.get(env.db, env.workspace.workspaceId, proposal.proposalId).status,
    'AWAITING_APPROVAL'
  );
});

test('a question can be answered without retyping the instruction', async () => {
  // First the model asks; then, given the answer appended, it resolves.
  const env = setup({
    provider: fakeProvider([
      { lines: [], clarifyingQuestion: 'Did those units leave, or was the count wrong?', unsupportedReason: '' },
      intentResponse(),
    ]),
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const asked = await post(agent, '/actions/ask', { instruction: 'take some off Downtown' });
  const page = plain(asked.text);
  assert.match(page, /Did those units leave/);
  // The question comes with somewhere to answer it.
  assert.match(asked.text, /name="answer"/);
  assert.match(asked.text, /name="original" value="take some off Downtown"/);

  const answered = await agent
    .post('/actions/ask')
    .type('form')
    .send({
      _csrf: csrfFrom(asked.text),
      original: 'take some off Downtown',
      answer: 'they were sold',
    });
  assert.equal(answered.status, 303, 'the answer produced a proposal');
  assert.match(answered.headers.location, /^\/actions\/act_/);

  const proposal = proposals.get(
    env.db,
    env.workspace.workspaceId,
    answered.headers.location.split('/').pop()
  );
  assert.match(proposal.originalInstruction, /take some off Downtown — they were sold/);
});

/**
 * The two boxes look the same to a person, so neither may claim the other's
 * work is impossible. Asking Foundry to move stock from the question page used
 * to answer "Foundry cannot move stock", which is simply untrue.
 */
test('an instruction typed into the question box is handed over, not refused', async () => {
  const env = setup({
    provider: fakeProvider({
      intent: 'action',
      entityQuery: 'banana',
      locationQuery: 'Mornoe',
      windowDays: 30,
      limit: 10,
      unsupportedReason: '',
    }),
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const res = await agent.get('/ask').query({ q: 'Move banana to Mornoe' });
  const page = plain(res.text);

  assert.match(page, /something Foundry can carry out/);
  assert.match(page, /This is a change, not a question/);
  assert.match(page, /Work out this change/);
  assert.ok(!page.includes('cannot move'), 'never claims it is impossible');

  // The hand-off carries the instruction to the action path.
  assert.match(res.text, /action="\/actions\/ask"/);
  assert.match(res.text, /name="instruction" value="Move banana to Mornoe"/);
});

test('a question typed into the action box points back at Ask Foundry', async () => {
  const env = setup({
    provider: fakeProvider({
      lines: [],
      clarifyingQuestion: '',
      unsupportedReason: 'Foundry cannot answer that from this page.',
    }),
  });
  const agent = request.agent(env.app);
  await signIn(agent, env.workspace.account.email, env.workspace.account.password);

  const res = await post(agent, '/actions/ask', { instruction: 'how many navy 4 do we have' });
  const page = plain(res.text);
  assert.match(page, /Foundry can look that up/);
  assert.match(res.text, /href="\/ask\?q=how%20many%20navy%204%20do%20we%20have"/);
});
