'use strict';

/**
 * Seven states, never interchangeable.
 *
 * understood and supported · understood but missing information · ambiguous
 * · unsupported · lookup failed · no matching records · provider unavailable.
 * Each is driven through the real surfaces with a fake provider where one is
 * needed, and the ledger status, its reason and the label a person reads
 * are asserted to be the ones for that state and no other.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const actionService = require('../../src/actions/action-service');
const ledger = require('../../src/assistant/ledger');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

const noModel = { provider: { async complete() { throw new Error('no model expected'); } } };

function shop() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const tee = makeQuantityItem(db, w.ctx, { name: 'Copper Tee', baseCode: 'CT' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  engine.receive(db, w.ctx, { skuId: tee.skuId, locationId: w.main.id, quantity: 12 });
  return { db, w, membership, elbow, tee };
}

test('the labels for the seven states are distinct', () => {
  const labels = [
    ledger.statusLabelFor('answered', {}), ledger.statusLabelFor('clarify', { reason: 'missing' }), ledger.statusLabelFor('clarify', { reason: 'ambiguous' }),
    ledger.statusLabelFor('refused', {}), ledger.statusLabelFor('failed', { reason: 'lookup_failed' }), ledger.statusLabelFor('answered', { reason: 'no_match' }),
    ledger.statusLabelFor('unavailable', {}),
  ].map((l) => l.label);
  assert.equal(new Set(labels).size, labels.length, JSON.stringify(labels));
  assert.match(ledger.statusLabelFor('unavailable', {}).label, /could not be reached/);
  assert.match(ledger.statusLabelFor('failed', { reason: 'lookup_failed' }).label, /lookup itself failed/);
  assert.match(ledger.statusLabelFor('answered', { reason: 'no_match' }).label, /nothing on file/);
});

test('an action question says whether something is missing, ambiguous, or nothing on file', async () => {
  const env = shop();
  const ambiguous = await actionService.interpret(env.db, env.w.ctx, env.membership, 'issue 2 copper from Main Warehouse as sold', noModel);
  assert.equal(ambiguous.kind, 'question');
  assert.equal(ambiguous.reason, 'ambiguous');
  assert.match(ambiguous.question, /Copper Elbow/);
  assert.match(ambiguous.question, /Copper Tee/);
  const none = await actionService.interpret(env.db, env.w.ctx, env.membership, 'move 3 brass nipple from Main Warehouse to Downtown Store', noModel);
  assert.equal(none.kind, 'question');
  assert.equal(none.reason, 'no_match', JSON.stringify(none).slice(0, 200));
  const missing = await actionService.interpret(env.db, env.w.ctx, env.membership, 'email the supplier about the delay', noModel);
  assert.equal(missing.kind, 'question');
  assert.equal(missing.reason, 'missing', JSON.stringify(missing).slice(0, 200));
});

test('through the chat: ambiguous, missing, no-match, unavailable and answered land as five different ledger states', async () => {
  const env = shop();
  const app = createApp({ db: env.db, env: 'test', sessionSecret: 'seven' });
  const agent = request.agent(app);
  await signIn(agent, env.w.account.email, env.w.account.password);
  const csrf = csrfFrom((await agent.get('/ask')).text);
  const send = async (message) => {
    const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message });
    if (posted.headers.location) await agent.get(posted.headers.location);
    return env.db.prepare('SELECT status, provenance, said FROM assistant_goals ORDER BY rowid DESC LIMIT 1').get();
  };
  const ambiguous = await send('issue 2 copper from Main Warehouse as sold');
  assert.equal(ambiguous.status, 'clarify');
  assert.match(ambiguous.provenance, /"reason":"ambiguous"/);
  const none = await send('move 3 brass nipple from Main Warehouse to Downtown Store');
  assert.equal(none.status, 'clarify');
  assert.match(none.provenance, /"reason":"no_match"/);
  const missing = await send('email the supplier about the delay');
  assert.equal(missing.status, 'clarify');
  assert.match(missing.provenance, /"reason":"missing"/);
  const answered = await send('how many copper elbow do we have');
  assert.equal(answered.status, 'answered');
  assert.doesNotMatch(answered.provenance, /no_match/);
  const nothing = await send('how many garden hoses do we have');
  assert.equal(nothing.status, 'answered', JSON.stringify(nothing));
  assert.match(nothing.provenance, /"reason":"no_match"/);

  // The model goes away.
  app.locals.aiProvider = require('../../src/assistant/calls').observed({ async complete() { throw new Error('ECONNRESET'); } });
  const down = await send('Prepare a replenishment preview for my warehouse and tell me the risks.');
  assert.equal(down.status, 'unavailable', JSON.stringify(down));
  assert.match(down.said, /no figures were guessed/);
  const page = await agent.get('/ask');
  assert.match(page.text, /could not be reached, try again/);
  assert.match(page.text, /more than one fits/);
  assert.match(page.text, /nothing on file by that name/);
  assert.match(page.text, /something was not said/);
});
