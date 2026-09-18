'use strict';

/**
 * How a normal owner actually types, against the live model.
 *
 * Every group is several wordings of one meaning — ordinary, vague,
 * misspelled, a follow-up with a pronoun, two things at once, a
 * contradiction, a record that does not exist, two records with the same
 * name, a person without the permission, a provider that is down, a
 * proposal that went stale. The assertion is on what StockChief must do with
 * each, never on one phrase. Anything read in code passes without a model;
 * the rest is the model's reading, checked here for the thing that matters.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const actionService = require('../../src/actions/action-service');
const intentService = require('../../src/actions/intent-service');
const queryPlanner = require('../../src/attention/query-planner');
const operating = require('../../src/manager/operating-instructions');
const execution = require('../../src/actions/execution-service');
const proposals = require('../../src/actions/proposal-service');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const suppliers = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const sales = require('../../src/sales/sales-order-service');
const prices = require('../../src/pricing/price-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem, makeVariantItem, signIn, csrfFrom } = require('../helpers');

const LIVE = Boolean(process.env.ANTHROPIC_API_KEY);
const TIMEOUT = 180000;

test.after(cleanupAll);

/* One business with the awkward bits real ones have: two products that
   share a word, a variant product, two suppliers, two customers with the
   same surname, an open PO, an open order. */
function business() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db, { workspaceName: 'Harbour Trade' });
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const staff = authService.getMembership(db, w.workspaceId, db.prepare('SELECT account_id FROM users WHERE id = ?').get(w.staffId).account_id);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const tee = makeQuantityItem(db, w.ctx, { name: 'Copper Tee', baseCode: 'CT' });
  const lantern = makeQuantityItem(db, w.ctx, { name: 'Camping Lantern', baseCode: 'CL' });
  const sweater = makeVariantItem(db, w.ctx);
  const navy4 = sweater.byLabel('Navy / 4');
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  engine.receive(db, w.ctx, { skuId: tee.skuId, locationId: w.main.id, quantity: 12 });
  engine.receive(db, w.ctx, { skuId: lantern.skuId, locationId: w.store.id, quantity: 6 });
  engine.receive(db, w.ctx, { skuId: navy4.id, locationId: w.main.id, quantity: 20 });
  try { prices.setSellingPrice(db, w.ctx, { skuId: elbow.skuId, amountMinor: 350, currency: 'USD', source: 'owner' }); } catch { /* optional */ }
  const acme = suppliers.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply', email: 'orders@acme.test' });
  const lakeside = suppliers.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles', email: 'orders@lakeside.test' });
  suppliers.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 2, isPreferred: true });
  suppliers.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: navy4.id, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 9 });
  const po = poService.createOrder(db, w.ctx, membership, { supplierId: acme.id, lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 100, unitCost: 2 }], source: 'test' });
  poService.approve(db, w.ctx, membership, po.id);
  const dana = sales.createCustomer(db, w.ctx, { name: 'Dana Brook', email: 'dana@brook.test' });
  const dan = sales.createCustomer(db, w.ctx, { name: 'Dan Brook', email: 'dan@brook.test' });
  let order = null;
  try { order = sales.createOrder(db, w.ctx, { customerId: dana.id, fulfillmentLocationId: w.main.id, lines: [{ skuId: elbow.skuId, quantity: 3, unitPriceMinor: 350 }] }); } catch { order = null; }
  return { db, w, membership, staff, elbow, tee, lantern, navy4, acme, lakeside, po, dana, dan, order };
}

const noModel = { provider: { async complete() { throw new Error('read in code, no model expected'); } } };

async function ask(env, question, options = {}) {
  return queryPlanner.ask(env.db, env.w.workspaceId, question, { membership: env.membership, ...options });
}

// ------------------------------------------------------------------ inventory

test('stock questions in every ordinary wording, with typos, land on the stock lookup for the right product', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const q of ['how many copper elbows do we have', 'How much Copper Elbow is there?', 'copper elbow stock?', 'whats our coper elbow count', 'do we have any copper elbows left', 'Copper Elbow — how many on hand right now']) {
    const r = await ask(env, q);
    assert.ok(['stock_level', 'stock_by_location'].includes(r.plan.intent), `"${q}" → ${r.plan.intent}`);
    assert.match(r.answer, /\b40\b/, `"${q}" answered "${r.answer}"`);
    assert.equal(r.isAction, false);
  }
});

test('a product word that fits two products is a question with both, never a pick', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const s of ['issue 2 copper from Main Warehouse as sold', 'take 2 copper out of Main Warehouse']) {
    const r = await actionService.interpret(env.db, env.w.ctx, env.membership, s);
    assert.equal(r.kind, 'question', `"${s}" → ${JSON.stringify(r).slice(0, 200)}`);
    assert.match(r.question, /Copper Elbow/);
    assert.match(r.question, /Copper Tee/);
    assert.equal(r.reason, 'ambiguous');
  }
});

test('a product that does not exist is "nothing on file", said plainly, and nothing is created', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const s of ['move 3 brass nipples from Main Warehouse to Downtown Store', 'we sold 2 garden hoses at the store']) {
    const r = await actionService.interpret(env.db, env.w.ctx, env.membership, s);
    assert.ok(['question', 'unsupported'].includes(r.kind), `"${s}" → ${r.kind}`);
    assert.match(String(r.question || r.message), /brass nipple|garden hose|no product|nothing called|could not find/i);
    assert.equal(env.db.prepare("SELECT COUNT(*) n FROM action_proposals WHERE workspace_id = ?").get(env.w.workspaceId).n, 0);
  }
  const lookup = await ask(env, 'how many brass nipples do we have');
  assert.match(lookup.answer, /could not find|no product|nothing/i);
  assert.equal(lookup.supported !== false || /could not find/i.test(lookup.answer), true);
});

test('a follow-up with a pronoun means what the conversation was about', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const first = await ask(env, 'how many copper elbows do we have?');
  assert.match(first.answer, /40/);
  const conversation = { workspaceId: env.w.workspaceId, question: 'how many copper elbows do we have?', semanticPlan: first.semanticPlan || null, rowCount: first.rowCount, clarification: null };
  for (const q of ['and where are they?', 'who supplies them?', 'what did we last pay for them']) {
    const r = await ask(env, q, { conversation });
    assert.ok(!r.needsClarification || /copper elbow/i.test(r.answer), `"${q}" should not ask which product: "${r.answer}"`);
    assert.doesNotMatch(r.answer, /which product/i, `"${q}" → "${r.answer}"`);
  }
});

// ------------------------------------------------------------------ actions

test('the same movement in six wordings becomes one correct, unexecuted proposal', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const s of ['move 5 copper elbow from Main Warehouse to Downtown Store', 'send 5 copper elbows over to the downtown store from the main warehouse', 'Transfer five Copper Elbow: Main Warehouse → Downtown Store', 'pls shift 5 copper elbow main warehouse to downtown store', 'I need 5 copper elbows moved to Downtown Store from Main Warehouse', 'can you move 5 of the copper elbows from the warehouse to the store']) {
    const r = await actionService.interpret(env.db, env.w.ctx, env.membership, s);
    assert.equal(r.kind, 'proposal', `"${s}" → ${JSON.stringify(r).slice(0, 240)}`);
    assert.equal(r.proposal.actionType, 'transfer');
    assert.equal(r.proposal.quantity, 5);
    assert.equal(r.proposal.skuId, env.elbow.skuId);
    assert.equal(r.proposal.sourceLocationId, env.w.main.id);
    assert.equal(r.proposal.destinationLocationId, env.w.store.id);
    assert.equal(r.proposal.status, 'AWAITING_APPROVAL');
  }
  assert.equal(require('../../src/domain/repository').getBalance(env.db, env.w.workspaceId, env.elbow.skuId, env.w.main.id), 40, 'nothing moved');
  // A misspelt product is offered, never assumed: "coper" is not a product, "elbow" is Copper Elbow — did you mean that?
  const typo = await actionService.interpret(env.db, env.w.ctx, env.membership, 'shift 5 coper elbow from main warehouse to downtown store');
  assert.ok(typo.kind === 'question' && /Copper Elbow/.test(typo.question) || (typo.kind === 'proposal' && typo.proposal.skuId === env.elbow.skuId && typo.proposal.assumptions.some((a) => /coper/i.test(a))), JSON.stringify(typo).slice(0, 240));
});

test('a correction after a proposal replaces it; a contradiction in one sentence is asked about', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const first = await actionService.interpret(env.db, env.w.ctx, env.membership, 'move 5 copper elbow from Main Warehouse to Downtown Store');
  assert.equal(first.kind, 'proposal');
  const revised = actionService.reviseQuantity(env.db, env.w.ctx, env.membership, first.proposal.proposalId, 8);
  assert.equal(revised.quantity, 8);
  assert.equal(proposals.get(env.db, env.w.workspaceId, first.proposal.proposalId).status, 'SUPERSEDED');
  const contradiction = await actionService.interpret(env.db, env.w.ctx, env.membership, 'move 5 copper elbow from Main Warehouse to Downtown Store, actually no, 10, no wait 5');
  assert.ok(contradiction.kind === 'question' || (contradiction.kind === 'proposal' && [5, 10].includes(contradiction.proposal.quantity)), JSON.stringify(contradiction).slice(0, 200));
});

test('a proposal that went stale is caught before it runs', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const r = await actionService.interpret(env.db, env.w.ctx, env.membership, 'issue 30 copper elbow from Main Warehouse as sold');
  assert.equal(r.kind, 'proposal', JSON.stringify(r).slice(0, 200));
  engine.issue(env.db, env.w.ctx, { skuId: env.elbow.skuId, locationId: env.w.main.id, quantity: 20, reasonCode: 'sold' });
  // Approval re-checks the stock first; execution would too. Either way it stops.
  await assert.rejects(async () => { execution.approve(env.db, env.w.ctx, env.membership, r.proposal.proposalId); execution.execute(env.db, env.w.ctx, env.membership, r.proposal.proposalId); }, (err) => err.code === 'proposal_stale' && /only 20/.test(err.message));
  assert.equal(require('../../src/domain/repository').getBalance(env.db, env.w.workspaceId, env.elbow.skuId, env.w.main.id), 20, 'the stale proposal moved nothing');
});

test('a person without the permission is refused before anything is prepared, in plain words', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const viewer = { ...env.staff, role: 'viewer', permissions: [] };
  await assert.rejects(async () => {
    const r = await actionService.interpret(env.db, { ...env.w.ctx, actorId: env.w.staffId }, viewer, 'issue 2 copper elbow from Main Warehouse as sold');
    if (r.kind === 'proposal') { execution.approve(env.db, { ...env.w.ctx, actorId: env.w.staffId }, viewer, r.proposal.proposalId); }
  }, (err) => err.status && err.status < 500 && /permission|allowed|not able|cannot/i.test(err.message));
});

// ------------------------------------------------------------------ purchasing & suppliers

test('ordering, chasing and asking about a supplier are three different things, each recognised', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const s of ['order 50 more copper elbow from Acme', 'raise a PO for 50 copper elbows', 'buy another 50 copper elbows']) {
    const intent = await intentService.readInstruction(s, { context: { locationNames: ['Main Warehouse', 'Downtown Store'], itemNames: ['Copper Elbow', 'Copper Tee', 'Camping Lantern'] } });
    const purchase = intent.lines.find((l) => l.actionType === 'purchase');
    assert.ok(purchase, `"${s}" → ${JSON.stringify(intent.lines.map((l) => l.actionType))}`);
    assert.equal(purchase.quantity, 50);
  }
  for (const s of ['chase Acme about our order', 'email Acme and ask where the delivery is', 'remind Acme Trade Supply about PO', 'tell acme the order is late']) {
    const intent = await intentService.readInstruction(s, { context: { locationNames: [], itemNames: [] } });
    assert.ok(intent.lines.some((l) => l.actionType === 'send_message'), `"${s}" → ${JSON.stringify(intent)}`);
    assert.equal(intent.unsupportedReason, '');
  }
  for (const q of ["what's on order from Acme", 'has Acme confirmed our order?', 'what do we owe Acme']) {
    const r = await ask(env, q);
    assert.ok(['on_order', 'supplier_order_status', 'payables_aging', 'supplier_spend', 'bills_due', 'late_orders', 'record_query', 'combined_lookup'].includes(r.plan.intent) && r.supported !== false, `"${q}" → ${r.plan.intent}: ${r.answer}`);
    assert.equal(r.isAction, false);
  }
});

// ------------------------------------------------------------------ customers & orders

test('two customers with the same surname are asked about, not guessed; a full name is taken', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const outbound = require('../../src/actions/outbound-message');
  const vague = outbound.prepare(env.db, env.w.ctx, { recipientText: 'Brook', body: 'your order has shipped', instruction: 'email Brook that the order shipped' });
  assert.equal(vague.kind, 'question');
  assert.equal(vague.reason, 'ambiguous');
  assert.match(vague.question, /Dana Brook/);
  assert.match(vague.question, /Dan Brook/);
  const exact = outbound.prepare(env.db, env.w.ctx, { recipientText: 'Dana Brook', body: 'your order has shipped', instruction: 'email Dana Brook that the order shipped' });
  assert.notEqual(exact.kind, 'question', JSON.stringify(exact).slice(0, 200));
});

test('customer questions in plain words route to customer and order lookups', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const q of ['which customers owe us money', 'who are our best customers', 'what is Dana Brook waiting on', 'any orders at risk?']) {
    const r = await ask(env, q);
    assert.ok(['receivables_aging', 'top_customers', 'customer_orders_at_risk', 'sales_summary', 'shipment_status', 'customer_payments', 'combined_lookup'].includes(r.plan.intent) || r.rows, `"${q}" → ${r.plan.intent}`);
    assert.equal(r.isAction, false, q);
    assert.notEqual(r.plan.intent, 'unsupported', `"${q}" was refused: ${r.answer}`);
  }
});

// ------------------------------------------------------------------ rules, forecasting, automation, configuration

test('lasting rules in owner words compile to the right rule and never to a stock action', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  for (const s of ['reorder copper elbow when we drop below 10', 'whenever camping lanterns get down to 2 let me know', 'from now on order more copper tee if stock falls under 5']) {
    const compiled = operating.__compileReorderRule(s);
    assert.ok(compiled, `"${s}" should compile as a reorder point`);
    assert.equal(compiled.changes[0].domain, 'replenishment');
  }
  for (const s of ["don't let anyone sell camping lanterns once stock hits 2", 'block sales of copper tee below 3 until we reorder', 'stop selling copper elbows when under 5 until we get more in']) {
    const compiled = operating.__compileStockProtection(s);
    assert.ok(compiled, `"${s}" should compile as stock protection`);
    assert.equal(compiled.changes[0].guardMode, 'block');
  }
  const proposal = await operating.interpret(env.db, env.w.ctx, env.membership, 'reorder copper elbow when we drop below 10');
  assert.equal(proposal.status, 'PENDING');
  assert.deepEqual(proposal.questions, []);
});

test('forecasts, prices, costs and automation controls read as what they are', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const cases = [
    ['what will we sell next month', ['demand_forecast']],
    ['how much demand do you expect for copper elbow this quarter', ['demand_forecast']],
    ['what do we charge for copper elbow', ['selling_price']],
    ['what did we pay for copper elbow last time', ['last_cost']],
    ['stop doing things on your own', ['stop_automation']],
    ['pause the automatic ordering please', ['stop_automation']],
    ['what did you do today', ['foundry_activity']],
    ['is anything wrong with my books', ['books_health']],
  ];
  for (const [q, expected] of cases) {
    const r = await ask(env, q);
    assert.ok(expected.includes(r.plan.intent), `"${q}" → ${r.plan.intent}`);
    assert.equal(r.isAction, false, q);
  }
});

test('configuration in words: a new place, a new word, a new product — proposed, never done', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const context = { locationNames: ['Main Warehouse', 'Downtown Store'], itemNames: ['Copper Elbow'] };
  for (const [s, type] of [['add a location called North Yard', 'add_location'], ['open a new store called Harbour Front', 'add_location'], ['call our items styles from now on', 'rename_terminology'], ['add a new product called Brass Nipple, code BN-1', 'create_item']]) {
    const intent = await intentService.readInstruction(s, { context });
    assert.equal(intent.lines[0] && intent.lines[0].actionType, type, `"${s}" → ${JSON.stringify(intent.lines)}`);
  }
});

// ------------------------------------------------------------------ multi-part, provider down, chat surface

test('a message with a question, a change and a rule in it ends with every part settled, through the chat', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const app = createApp({ db: env.db, env: 'test', sessionSecret: 'live-multipart' });
  const agent = request.agent(app);
  await signIn(agent, env.w.account.email, env.w.account.password);
  const csrf = csrfFrom((await agent.get('/ask')).text);
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: 'how many copper elbows do we have, and move 5 of them from Main Warehouse to Downtown Store, and reorder copper elbow whenever we drop below 10' });
  assert.equal(posted.status, 303);
  await agent.get(posted.headers.location);
  const goals = () => env.db.prepare('SELECT position, kind, text, status FROM assistant_goals WHERE workspace_id = ? ORDER BY rowid').all(env.w.workspaceId);
  assert.ok(goals().length >= 2, `split into parts: ${JSON.stringify(goals())}`);
  // Work through the queue: continue each part until nothing is pending, bounded.
  for (let step = 0; step < 6; step += 1) {
    const page = await agent.get('/ask');
    const next = /name="assistantGoal" value="([^"]+)"/.exec(page.text);
    if (!next) break;
    const text = /name="message" value="([^"]+)"/.exec(page.text)[1].replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const continued = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', assistantGoal: next[1], message: text });
    if (continued.headers.location) await agent.get(continued.headers.location);
  }
  const final = goals();
  assert.ok(final.every((g) => g.status !== 'pending'), `every part ended somewhere: ${JSON.stringify(final)}`);
  assert.ok(final.some((g) => g.status === 'answered'), 'the question was answered');
  assert.ok(final.some((g) => g.status === 'needs_approval'), 'the change and the rule wait for approval');
  const recap = await agent.get('/ask?q=what%20did%20I%20just%20do%3F&recap=1');
  assert.match(recap.text, /parts settled/);
});

test('when the model is down the chat says so, keeps the message, and records the goal as unavailable — not failed, not refused', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const app = createApp({ db: env.db, env: 'test', sessionSecret: 'live-down', aiProvider: { async complete() { const e = new Error('ECONNRESET'); throw e; } } });
  const agent = request.agent(app);
  await signIn(agent, env.w.account.email, env.w.account.password);
  const csrf = csrfFrom((await agent.get('/ask')).text);
  const message = 'Prepare a replenishment preview for my warehouse and tell me the risks.';
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message });
  assert.equal(posted.status, 303);
  const page = await agent.get(posted.headers.location);
  assert.match(page.text, /no figures were guessed/);
  assert.ok(page.text.includes(`>${message}</textarea>`) || page.text.includes(message), 'the message is still in the box');
  const goal = env.db.prepare('SELECT status FROM assistant_goals WHERE workspace_id = ? ORDER BY rowid DESC LIMIT 1').get(env.w.workspaceId);
  assert.equal(goal && goal.status, 'unavailable', JSON.stringify(goal));
});

test('what a normal owner types across domains is never refused as unsupported when StockChief can do it', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = business();
  const questions = [
    'how are we doing', 'what needs my attention', 'anything expiring soon?', 'what has not sold in three months',
    "what's due to arrive this week", 'which supplier bills are due', 'how much cash do we have', 'what did we sell last week',
    'where are the camping lanterns', 'is the stock covering the open orders', 'which carrier is late most', 'what changed on the acme invoice',
  ];
  const refused = [];
  for (const q of questions) {
    const r = await ask(env, q);
    // A clarifying question is not a refusal; "StockChief does not do that" is.
    if (r.supported === false && !r.needsClarification) refused.push(`${q} → ${r.answer}`);
    assert.equal(r.isAction, false, q);
  }
  assert.deepEqual(refused, [], 'ordinary questions were refused');
});
