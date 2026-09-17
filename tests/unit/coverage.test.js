'use strict';

/**
 * No part of a message disappears.
 *
 * A message with several parts is several goals; each ends in a terminal
 * state — answered, prepared, handed, refused, failed, unavailable, or
 * skipped with the reason — and the chat says how many are settled. A
 * question with three parts, one of which cannot be looked up, answers the
 * two and says so about the third.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const ledger = require('../../src/assistant/ledger');
const turns = require('../../src/assistant/turns');
const semanticQuery = require('../../src/attention/semantic-query');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

function splitting(goals) {
  return { async complete(req) {
    if (req.schemaName === 'assistant_understanding') return { data: { continuesPrevious: false, goals } };
    throw new Error(`no model expected for ${req.schemaName}`);
  } };
}

test('a part left waiting is settled as skipped, with the reason, when the person moves on', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  const app = createApp({ db, env: 'test', sessionSecret: 'coverage' });
  app.locals.aiProvider = splitting([
    { kind: 'change', text: 'move 5 copper elbow from Main Warehouse to Downtown Store' },
    { kind: 'instruction', text: 'reorder copper elbow whenever we drop below 10' },
  ]);
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const ask = await agent.get('/ask');
  const csrf = csrfFrom(ask.text);
  const first = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: 'move 5 copper elbow from Main Warehouse to Downtown Store and reorder copper elbow whenever we drop below 10' });
  assert.match(first.headers.location, /^\/actions\/act_/, first.headers.location);
  let goals = db.prepare('SELECT status FROM assistant_goals ORDER BY rowid').all().map((g) => g.status);
  assert.deepEqual(goals, ['needs_approval', 'pending']);
  // The page says one of two is settled.
  const page = await agent.get('/ask');
  assert.match(page.text, /1 of 2 parts settled/);
  assert.match(page.text, /One more thing from your message/);

  // Moving on to a new message: the waiting part is left undone, on the record.
  const next = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: 'how many copper elbow do we have?' });
  assert.equal(next.status, 303);
  goals = db.prepare('SELECT status, said, provenance FROM assistant_goals ORDER BY rowid').all();
  assert.equal(goals[1].status, 'skipped');
  assert.match(goals[1].said, /Left undone — you moved on to something else/);
  assert.match(goals[1].provenance, /moved_on/);
  const after = await agent.get(next.headers.location);
  assert.match(after.text, /Left undone/);
  assert.doesNotMatch(after.text, /more things? from your message/);
  // And the recap says the message had one of two settled, not "handled".
  const recap = await agent.get('/ask?q=what%20did%20I%20just%20do%3F&recap=1');
  assert.match(recap.text, /2 parts settled|all 2 parts settled/);
});

test('a new conversation and an inventory switch also leave waiting parts undone, said so', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const turn = ledger.openTurn(db, w.ctx, { conversationId: 'c1', channel: 'ask', message: 'a and b', understanding: {}, goals: [{ kind: 'lookup', text: 'a' }, { kind: 'lookup', text: 'b' }] });
  ledger.settle(db, w.ctx, turn.goals[0].id, { status: 'answered', said: 'A.' });
  assert.equal(ledger.turnCoverage(ledger.getTurn(db, w.workspaceId, turn.id)).pending, 1);
  const n = turns.abandon(db, w.ctx, 'c1', 'you switched to another inventory.');
  assert.equal(n, 1);
  const settled = ledger.getTurn(db, w.workspaceId, turn.id);
  assert.equal(settled.goals[1].status, 'skipped');
  assert.match(settled.goals[1].said, /switched to another inventory/);
  assert.equal(ledger.turnComplete(settled), true);
  assert.equal(turns.abandon(db, w.ctx, 'c1', 'again'), 0, 'nothing left to abandon');
});

test('a three-part question answers the parts it can and says which it cannot', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  const part = (question, intent, extra = {}) => ({ question, intent, entityQuery: '', locationQuery: '', windowDays: 30, limit: 25, unsupportedReason: '', recordQuery: null, ...extra });
  const provider = { async complete() { return { data: { decision: 'answer', interpretation: 'three things', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [
    part('how many copper elbow do we have', 'stock_level', { entityQuery: 'Copper Elbow' }),
    part('what is the weather at the warehouse', 'unsupported', { unsupportedReason: 'StockChief does not track the weather.' }),
    part('move 5 of them to the store', 'action'),
  ] } }; } };
  return semanticQuery.ask(db, w.workspaceId, 'how many copper elbow do we have, what is the weather at the warehouse, and move 5 of them to the store', { provider }).then((result) => {
    assert.equal(result.sections.length, 3, JSON.stringify(result).slice(0, 400));
    assert.deepEqual(result.sections.map((s) => s.partState), ['answered', 'unsupported', 'handed']);
    assert.match(result.sections[0].answer, /40/);
    assert.match(result.sections[1].answer, /does not track the weather/);
    assert.match(result.sections[2].answer, /something to do rather than something to look up/);
    assert.match(result.answer, /40/);
    assert.match(result.answer, /weather/);
    assert.equal(result.supported, false, 'not every part was answered, and the whole says so');
    assert.equal(result.isAction, false, 'a mixed message is not handed to the actions page as a whole');
  });
});
