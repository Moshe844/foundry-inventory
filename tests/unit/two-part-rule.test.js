'use strict';

/**
 * The owner's own two-part rule, exactly as typed, end to end through the
 * chat: "when Camping Lantern reaches the quantity of 4 you should notify me
 * and when I try to sell more while quantity is still 4 I shouldn't be able
 * to". What happened before this test: the first part became a rule and was
 * approved, but the chat kept saying "needs your approval"; the second part
 * was sent to the question planner, which asked "which product?" — and the
 * block was never set up. A sale went through at 4.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const operatingGuards = require('../../src/domain/operating-guards');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

const MESSAGE = 'I want when Camping Lantern reaches the quantity of 4 you should notify me and when I try to sell more while quantity is still 4 I shouldn\'t be able to';

/* The understanding split, as the model returns it; everything after it is read in code. */
function splitOnly() {
  return {
    async complete(req) {
      if (req.schemaName === 'assistant_understanding') {
        return { data: { continuesPrevious: false, goals: [
          { kind: 'instruction', text: 'when Camping Lantern reaches the quantity of 4 you should notify me' },
          { kind: 'instruction', text: 'when I try to sell more while quantity is still 4 I shouldn\'t be able to' },
        ] } };
      }
      throw new Error(`no model expected for ${req.schemaName}`);
    },
  };
}

test('both parts of a two-part rule are set up, each approved from the chat, and the block then holds', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const lantern = makeQuantityItem(db, w.ctx, { name: 'Camping Lantern', baseCode: 'CL' });
  engine.receive(db, w.ctx, { skuId: lantern.skuId, locationId: w.main.id, quantity: 6 });
  const app = createApp({ db, env: 'test', sessionSecret: 'two-part' });
  app.locals.aiProvider = splitOnly();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const ask = await agent.get('/ask');
  const csrf = csrfFrom(ask.text);

  // Part one: a rule page, from the chat.
  const first = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: MESSAGE });
  assert.match(first.headers.location, /^\/operating-instructions\/oin_/, first.headers.location);
  const rulePage = await agent.get(first.headers.location);
  assert.match(rulePage.text, /Camping Lantern/);
  assert.match(rulePage.text, /One more thing from your message/, 'the second part is offered');
  const ruleId = first.headers.location.split('/').pop();
  const hash = /name="integrityHash" value="([^"]+)"/.exec(rulePage.text)[1];
  const approved = await agent.post(`/operating-instructions/${ruleId}/approve`).type('form').send({ _csrf: csrf, integrityHash: hash });
  assert.equal(approved.headers.location, '/ask', 'approving takes you back to the chat');
  let goals = db.prepare('SELECT position, status, said, text FROM assistant_goals ORDER BY rowid').all();
  assert.equal(goals[0].status, 'done', JSON.stringify(goals));
  assert.match(goals[0].said, /Remembered/);
  assert.equal(goals[1].status, 'pending');
  const back = await agent.get('/ask');
  assert.match(back.text, /Remembered\./);
  assert.match(back.text, /One more thing from your message/);
  const next = /name="assistantGoal" value="([^"]+)"/.exec(back.text)[1];
  const nextText = /name="message" value="([^"]+)"/.exec(back.text)[1];

  // Part two: continued from the chat; it names no product, so it is about the one the message named.
  const second = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', assistantGoal: next, message: nextText });
  assert.match(second.headers.location, /^\/operating-instructions\/oin_/, `second part went to ${second.headers.location}`);
  let blockPage = await agent.get(second.headers.location);
  assert.match(blockPage.text, /Camping Lantern/);
  assert.match(blockPage.text, /below 4/i);
  assert.doesNotMatch(blockPage.text, /Which product/i, 'the product was in the message');
  // One thing was not said: when the block lifts. Asked, with buttons — never assumed.
  assert.match(blockPage.text, /Supplier order placed/);
  const asked = second.headers.location.split('/').pop();
  const answered = await agent.post(`/operating-instructions/${asked}/answer`).type('form').send({ _csrf: csrf, answer: 'on_order' });
  assert.match(answered.headers.location, /^\/operating-instructions\/oin_/);
  blockPage = await agent.get(answered.headers.location);
  assert.doesNotMatch(blockPage.text, /Supplier order placed/, 'answered');
  const blockId = answered.headers.location.split('/').pop();
  const hash2 = /name="integrityHash" value="([^"]+)"/.exec(blockPage.text)[1];
  const approved2 = await agent.post(`/operating-instructions/${blockId}/approve`).type('form').send({ _csrf: csrf, integrityHash: hash2 });
  assert.equal(approved2.headers.location, '/ask');
  goals = db.prepare('SELECT position, status FROM assistant_goals ORDER BY rowid').all();
  assert.deepEqual(goals.map((g) => g.status), ['done', 'done']);
  const finished = await agent.get('/ask');
  assert.doesNotMatch(finished.text, /more things? from your message/);

  // The block holds: selling down to 4 is allowed, selling past it is refused.
  const rules = operatingGuards.list(db, w.workspaceId, { activeOnly: true, skuId: lantern.skuId });
  assert.equal(rules.length, 1, JSON.stringify(rules));
  assert.equal(rules[0].enforcementMode, 'block');
  engine.issue(db, w.ctx, { skuId: lantern.skuId, locationId: w.main.id, quantity: 2, reasonCode: 'sold' });
  assert.throws(() => engine.issue(db, w.ctx, { skuId: lantern.skuId, locationId: w.main.id, quantity: 1, reasonCode: 'sold' }), /The rule blocks any result below 4/);
  // And the reorder flag is on the product.
  const reorder = db.prepare('SELECT reorder_point FROM reorder_policies WHERE sku_id = ?').get(lantern.skuId);
  assert.equal(reorder && reorder.reorder_point, 4);
});
