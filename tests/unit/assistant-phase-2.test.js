'use strict';

/**
 * One understanding, a ledger of goals, and nothing dropped.
 *
 * A message with several parts becomes several goals from the moment it is
 * understood; the first runs, the rest are offered on every page until they
 * are done or deliberately left; every goal ends in a status the person can
 * read, with what was said and where the answer came from.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const ledger = require('../../src/assistant/ledger');
const understand = require('../../src/assistant/understand');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

function countPlan() {
  return { decision: 'answer', interpretation: 'Count the products', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [{
    question: 'How many products?', intent: 'record_query', entityQuery: '', locationQuery: '', windowDays: 30, limit: 10, unsupportedReason: '', recordQuery: {
      dataset: 'products', entityScope: 'set', fields: [], filters: [{ field: 'active', operator: 'eq', value: 1 }], filterMode: 'all', aggregate: 'count', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25,
    } }] };
}
const actionPlan = { decision: 'action', interpretation: 'Move stock', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [] };

/** Answers the semantic planner only; every other reader is deterministic here. */
const provider = { async complete(r) {
  if (r.schemaName === 'stockchief_semantic_query') {
    const q = JSON.parse(r.prompt).question;
    return { data: /^move\b/i.test(q) ? actionPlan : countPlan() };
  }
  throw new Error(`unexpected model call: ${r.schemaName}`);
} };

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const item = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: item.skuId, locationId: w.main.id, quantity: 40 });
  const app = createApp({ db, env: 'test', sessionSecret: 'phase-2', aiProvider: provider });
  return { db, w, app };
}

test('a message with two parts becomes two goals; the first runs, the second is offered, and both end in the ledger', async () => {
  const { db, w, app } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const form = await agent.get('/ask');
  const message = '1) How many entries do we have? 2) move 2 Copper Elbow from Main Warehouse to Downtown Store';
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(form.text), queryConversation: '1', message });
  assert.equal(posted.status, 303);
  assert.match(posted.headers.location, /^\/ask\?q=How%20many%20entries/, 'the first goal runs on its own');

  const page = await agent.get(posted.headers.location);
  const text = plain(page.text);
  assert.match(text, /1 products match your question/);
  assert.match(text, /One more thing from your message/);
  assert.match(text, /Next: “move 2 Copper Elbow from Main Warehouse to Downtown Store”/);
  assert.match(text, /part 2 of 2/);
  assert.match(text, /Not started yet — it is waiting behind the part before it/);

  const turns = ledger.conversation(db, { workspaceId: w.workspaceId, actorId: w.ownerId }, await conversationIdOf(agent));
  assert.equal(turns.length, 1);
  assert.equal(turns[0].goals.length, 2);
  assert.equal(turns[0].goals[0].status, 'answered');
  assert.equal(turns[0].goals[0].provenance.reads[0].dataset, 'products');
  assert.equal(turns[0].goals[1].status, 'pending');

  // Continue with the second: it is read deterministically and prepared for approval.
  const goalId = turns[0].goals[1].id;
  const continued = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(page.text), queryConversation: '1', assistantGoal: goalId, message: turns[0].goals[1].text });
  assert.equal(continued.status, 303);
  assert.match(continued.headers.location, /^\/actions\/act_/);
  const settled = ledger.getGoal(db, w.workspaceId, goalId);
  assert.equal(settled.status, 'needs_approval');
  assert.match(settled.said, /Prepared for your approval/);
  assert.equal(settled.resultHref, continued.headers.location);

  const after = plain((await agent.get('/ask')).text);
  assert.doesNotMatch(after, /more thing from your message/, 'the queue is empty');
  assert.match(after, /Needs your approval/);
  assert.match(after, /Review and approve/);
});

test('leaving the rest is recorded as left, not lost', async () => {
  const { db, w, app } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const form = await agent.get('/ask');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(form.text), queryConversation: '1',
    message: '1) How many entries do we have? 2) move 2 Copper Elbow from Main Warehouse to Downtown Store; 3) move 1 Copper Elbow from Main Warehouse to Downtown Store' });
  const page = await agent.get(posted.headers.location);
  assert.match(plain(page.text), /2 more things from your message/);
  const left = await agent.post('/ask/leave-the-rest').type('form').send({ _csrf: csrfFrom(page.text), back: '/ask' });
  assert.equal(left.status, 303);
  const after = plain((await agent.get('/ask')).text);
  assert.match(after, /Left 2 parts of your message undone/);
  assert.equal((after.match(/Left undone — you skipped it/g) || []).length, 2);
  const goals = ledger.conversation(db, { workspaceId: w.workspaceId, actorId: w.ownerId }, await conversationIdOf(agent))[0].goals;
  assert.deepEqual(goals.map((g) => g.status), ['answered', 'skipped', 'skipped']);
});

test('a folded sentence is split by one checked model call, and a rephrased split is refused', async () => {
  const split = { async complete() { return { data: { continuesPrevious: false, goals: [
    { kind: 'send', text: 'Draft an email to Acme about PO-1013' }, { kind: 'change', text: 'move 5 Copper Elbow to Downtown Store' }] } }; } };
  const two = await understand.understand('Draft an email to Acme about PO-1013 and then move 5 Copper Elbow to Downtown Store.', { provider: split });
  assert.equal(two.how, 'model');
  assert.deepEqual(two.goals.map((g) => g.kind), ['send', 'change']);
  const rephrased = { async complete() { return { data: { continuesPrevious: false, goals: [{ kind: 'send', text: 'Email Acme' }, { kind: 'change', text: 'Move elbows' }] } }; } };
  const one = await understand.understand('Draft an email to Acme about PO-1013 and then move 5 Copper Elbow to Downtown Store.', { provider: rephrased });
  assert.equal(one.goals.length, 1, 'words the person never used are not carried anywhere');
  const plain1 = await understand.understand('How many Copper Elbow do we have?', { provider: { async complete() { throw new Error('must not be called'); } } });
  assert.equal(plain1.how, 'single');
  assert.equal(plain1.goals[0].kind, 'lookup');
});

test('"that PO" resolves against what the conversation put on the table', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const ctx = { workspaceId: w.workspaceId, actorId: w.ownerId };
  const turn = ledger.openTurn(db, ctx, { conversationId: 'c1', channel: 'tell', message: 'Order 12 Copper Elbow from Acme', goals: [{ kind: 'change', text: 'Order 12 Copper Elbow from Acme' }] });
  ledger.noteReferent(db, ctx, turn.id, { kind: 'purchase_order', refId: 'po_1', label: 'PO-1024', href: '/purchasing/orders/po_1' });
  const referents = ledger.recentReferents(db, ctx, 'c1');
  const resolved = understand.resolveReferents('Approve that PO and email the supplier', referents);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].label, 'PO-1024');
  assert.match(understand.referentNote(resolved), /“that PO” means PO-1024 \(\/purchasing\/orders\/po_1\)/);
  assert.deepEqual(understand.resolveReferents('Approve that PO', ledger.recentReferents(db, ctx, 'other-conversation')), [], 'another conversation has its own table');
});

/** The conversation id lives in the session; read it back through a page that reveals nothing else. */
async function conversationIdOf(agent) {
  // The ledger keys conversations by the session's id; the only way in from
  // outside is the same route the page uses, so read the newest conversation.
  const res = await agent.get('/ask');
  const m = /data-conversation="([^"]+)"/.exec(res.text);
  return m ? m[1] : 'default';
}

test('the keyword fast path stands down when the understanding says the sentence is not about stock', async () => {
  const intentRouter = require('../../src/manager/intent-router');
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  let planned = 0;
  const planner = { async complete() { planned += 1; return { data: { intentClass: 'UNKNOWN', confidence: 'low', reason: 'a communication, not a receipt', resolvedReference: '', clarifyingQuestion: 'What would you like StockChief to do about that email?' } }; } };
  const sentence = 'I received an email from Acme about pricing';
  assert.equal(intentRouter.fallbackClassify(sentence).intentClass, 'INVENTORY_ACTION', 'the keywords alone read it as a receipt of goods');
  const withoutKind = await intentRouter.classify(db, w.ctx, sentence, { provider: planner });
  assert.equal(withoutKind.intentClass, 'INVENTORY_ACTION');
  assert.equal(planned, 0, 'before: the fast path never let a model see it');
  const withKind = await intentRouter.classify(db, w.ctx, sentence, { provider: planner, goalKind: understand.guessKind(sentence) });
  assert.equal(understand.guessKind(sentence), 'communication');
  assert.equal(planned, 1, 'now the planner reads it');
  assert.notEqual(withKind.intentClass, 'INVENTORY_ACTION');
  const stock = 'We received 12 cases of Copper Elbow';
  await intentRouter.classify(db, w.ctx, stock, { provider: planner, goalKind: understand.guessKind(stock) });
  assert.equal(planned, 1, 'a genuine stock report still takes the closed fast path');
});

test('the actions page shows the ledger row its question belongs to', async () => {
  const { db, w, app } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const form = await agent.get('/ask');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(form.text), queryConversation: '1',
    message: '1) How many entries do we have? 2) move 2 Copper Elbow from Main Warehouse to Downtown Store' });
  const page = await agent.get(posted.headers.location);
  const goals = ledger.conversation(db, { workspaceId: w.workspaceId, actorId: w.ownerId }, await conversationIdOf(agent))[0].goals;
  const continued = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(page.text), queryConversation: '1', assistantGoal: goals[1].id, message: goals[1].text });
  const detail = plain((await agent.get(continued.headers.location)).text);
  assert.match(detail, /Needs your approval From your message — part 2 of 2: “move 2 Copper Elbow from Main Warehouse to Downtown Store” See the conversation/);
});
