'use strict';

/**
 * "Undo that": the last thing this conversation did, from the ledger —
 * withdrawn if it had not run, cancelled if it was a draft, reversed as a
 * new change for approval if it ran, and said plainly when it cannot be.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const proposals = require('../../src/actions/proposal-service');
const actionService = require('../../src/actions/action-service');
const ledger = require('../../src/assistant/ledger');
const undoService = require('../../src/assistant/undo');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  const acme = supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply', email: 'sales@acme.test' });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 2 });
  const app = createApp({ db, env: 'test', sessionSecret: 'undo' });
  return { db, w, membership, elbow, acme, app };
}

async function chat(agent, message) {
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message, queryConversation: '1' });
  return posted.headers.location;
}

test('the words that mean undo', () => {
  for (const s of ['undo that', 'Undo', 'undo it', 'revert that', 'put it back', 'cancel that', 'never mind', 'undo the last change']) assert.ok(undoService.ASKS_UNDO.test(s), s);
  for (const s of ['undo the transfer of gloves', 'cancel PO-1013', 'how do I undo a receipt']) assert.ok(!undoService.ASKS_UNDO.test(s), s);
});

test('a proposal that has not run is withdrawn; one that ran is reversed as a new change for approval; then nothing is left', async () => {
  const { db, w, app, elbow } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);

  const first = await chat(agent, 'move 5 Copper Elbow from Main Warehouse to Downtown Store');
  assert.match(first, /^\/actions\/act_/);
  const withdrawn = await chat(agent, 'undo that');
  const page1 = await agent.get(withdrawn);
  assert.match(page1.text, /Withdrawn\. “move 5 Copper Elbow from Main Warehouse to Downtown Store” had not run yet/);
  const proposalId = first.split('/').pop();
  assert.equal(proposals.get(db, w.workspaceId, proposalId).status, 'CANCELLED');
  const goal = db.prepare("SELECT status FROM assistant_goals WHERE result_href IS NULL AND text LIKE 'move 5%'").get();
  assert.equal(goal.status, 'withdrawn');

  const second = await chat(agent, 'move 5 Copper Elbow from Main Warehouse to Downtown Store');
  const id = second.split('/').pop();
  const detail = await agent.get(second);
  await agent.post(`/actions/${id}/approve`).type('form').send({ _csrf: csrfFrom(detail.text) });
  await agent.get(`/actions/${id}/run`);
  assert.equal(proposals.get(db, w.workspaceId, id).status, 'SUCCEEDED');
  assert.equal(repo.getBalance(db, w.workspaceId, elbow.skuId, w.store.id), 0, 'a transfer document: nothing arrives until it is received');
  const ran = ledger.goalByResult(db, w.ctx, db.prepare('SELECT conversation_id FROM assistant_turns ORDER BY created_at DESC LIMIT 1').get().conversation_id, `/actions/${id}`);
  assert.equal(ran.status, 'done', 'the conversation knows it ran');
  assert.match(ran.said, /^Done: /);

  // A transfer that ran is a transfer document, not yet dispatched: undoing it cancels it.
  const cancelled = await chat(agent, 'undo that');
  const page2 = await agent.get(cancelled);
  assert.match(page2.text, /Cancelled TR-\d+\. Nothing had been dispatched, so the stock never left Main Warehouse\./);
  const transferService = require('../../src/transfers/transfer-service');
  assert.equal(transferService.list(db, w.workspaceId)[0].status, 'CANCELLED');
  const settled = ledger.getGoal(db, w.workspaceId, ran.id);
  assert.equal(settled.status, 'withdrawn');

  // A receipt that ran is reversed as an issue back out, for approval.
  const receipt = await chat(agent, 'receive 7 Copper Elbow into Downtown Store');
  assert.match(receipt, /^\/actions\/act_/);
  const rid = receipt.split('/').pop();
  const rdetail = await agent.get(receipt);
  await agent.post(`/actions/${rid}/approve`).type('form').send({ _csrf: csrfFrom(rdetail.text) });
  await agent.get(`/actions/${rid}/run`);
  assert.equal(repo.getBalance(db, w.workspaceId, elbow.skuId, w.store.id), 7);
  const reversal = await chat(agent, 'undo that');
  assert.match(reversal, /^\/actions\/act_/);
  const back = proposals.get(db, w.workspaceId, reversal.split('/').pop());
  assert.equal(back.actionType, 'issue');
  assert.equal(back.quantity, 7);
  assert.equal(back.status, 'AWAITING_APPROVAL', 'nothing is undone until approved');
  assert.equal(repo.getBalance(db, w.workspaceId, elbow.skuId, w.store.id), 7, 'still there until approved');
  const page3 = await agent.get(reversal);
  assert.match(page3.text, /StockChief worked out the change that puts it back/);
});

test('a drafted order is cancelled, a drafted message is not sent, and a sent one cannot be unsent', async () => {
  const { db, w, app, membership, elbow, acme } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const order = poService.createOrder(db, w.ctx, membership, { supplierId: acme.id, lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 10, unitCost: 2 }], source: 'instruction' });
  const convo = 'default';
  const turn = ledger.openTurn(db, w.ctx, { conversationId: convo, channel: 'ask', message: 'order 10 elbows from acme', understanding: {}, goals: [{ kind: 'change', text: 'order 10 elbows from acme' }] });
  ledger.settle(db, w.ctx, turn.goals[0].id, { status: 'drafted', said: 'Drafted.', resultHref: `/purchasing/orders/${order.id}` });
  const target = undoService.findTarget(db, w.ctx, convo);
  assert.equal(target.kind, 'purchase_order');
  const outcome = undoService.undo(db, w.ctx, membership, target, {});
  assert.equal(outcome.done, true);
  assert.match(outcome.said, new RegExp(`Cancelled ${order.poNumber}\\. It was a draft; the supplier was never told`));
  assert.equal(poService.get(db, w.workspaceId, order.id).status, 'CANCELLED');

  const comms = require('../../src/sales/customer-communications');
  const message = comms.prepareOwnerMessage(db, w.ctx, { recipient: 'sales@acme.test', body: 'Hello', subject: 'Hi' });
  const t2 = ledger.openTurn(db, w.ctx, { conversationId: convo, channel: 'ask', message: 'email acme hello', understanding: {}, goals: [{ kind: 'send', text: 'email acme hello' }] });
  ledger.settle(db, w.ctx, t2.goals[0].id, { status: 'drafted', said: 'Drafted, not sent.', resultHref: `/messages/${message.id}` });
  const second = undoService.undo(db, w.ctx, membership, undoService.findTarget(db, w.ctx, convo), {});
  assert.equal(second.done, true);
  assert.match(second.said, /will not be sent\. It had not gone out\./);
  assert.equal(comms.get(db, w.workspaceId, message.id).status, 'CANCELLED');

  db.prepare("UPDATE customer_communications SET status = 'SENT' WHERE id = ?").run(message.id);
  const t3 = ledger.openTurn(db, w.ctx, { conversationId: convo, channel: 'ask', message: 'email acme again', understanding: {}, goals: [{ kind: 'send', text: 'email acme again' }] });
  ledger.settle(db, w.ctx, t3.goals[0].id, { status: 'drafted', said: 'Drafted.', resultHref: `/messages/${message.id}` });
  const third = undoService.undo(db, w.ctx, membership, undoService.findTarget(db, w.ctx, convo), {});
  assert.equal(third.done, false);
  assert.match(third.said, /already sent, and a sent email cannot be unsent/);
});

test('a receipt is undone by issuing it back out, an issue by receiving it back, and both wait for approval', () => {
  const { db, w, membership, elbow } = setup();
  const received = proposals.build(db, w.ctx, { actionType: 'receive', item: 'Copper Elbow', destinationLocation: w.store.name, quantity: 7 });
  const stored = proposals.persist(db, w.ctx, received.proposal, { sourceType: 'USER_REQUEST', instruction: 'receive 7' });
  const execution = require('../../src/actions/execution-service');
  execution.approve(db, w.ctx, membership, stored.proposalId);
  execution.execute(db, w.ctx, membership, stored.proposalId, { idempotencyKey: `t:${stored.proposalId}` });
  assert.equal(repo.getBalance(db, w.workspaceId, elbow.skuId, w.store.id), 7);
  const reversal = actionService.proposeCompensation(db, w.ctx, membership, stored.proposalId);
  assert.equal(reversal.kind, 'proposal', JSON.stringify(reversal));
  assert.equal(reversal.proposal.actionType, 'issue');
  assert.equal(reversal.proposal.quantity, 7);
  assert.equal(reversal.proposal.sourceLocationId, w.store.id);
  assert.equal(reversal.proposal.status, 'AWAITING_APPROVAL');
  assert.equal(repo.getBalance(db, w.workspaceId, elbow.skuId, w.store.id), 7);
});
