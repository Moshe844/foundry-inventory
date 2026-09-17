'use strict';

/**
 * Phase 4 of the assistant reliability programme: a message StockChief
 * writes is written from verified facts and never sent from chat (F10),
 * "how do I …" gets steps composed from the product brain (G3), and a
 * general question is answered as general knowledge and labelled as such.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const poService = require('../../src/purchasing/po-service');
const outbound = require('../../src/actions/outbound-message');
const mailDraft = require('../../src/assistant/mail-draft');
const general = require('../../src/assistant/general-knowledge');
const howTo = require('../../src/product-brain/how-to');
const navigation = require('../../src/product-brain/navigation');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const lakeside = supplierService.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles', email: 'orders@lakeside.test' });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 3 });
  const po = poService.createOrder(db, w.ctx, membership, { supplierId: lakeside.id, expectedDate: '2026-09-20', lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 27, unitCost: 3 }], source: 'test' });
  poService.approve(db, w.ctx, membership, po.id);
  return { db, w, membership, elbow, lakeside, po };
}

// F10
test('dictated words are kept exactly; a purpose is written up', () => {
  assert.equal(mailDraft.wantsComposition('email Lakeside saying we received the order, thanks', 'we received the order, thanks'), false);
  assert.equal(mailDraft.wantsComposition('email Lakeside and ask for a price list', 'ask for a price list'), true);
  assert.equal(mailDraft.wantsComposition('ask Lakeside when PO-1010 will arrive', 'when PO-1010 will arrive'), true);
  assert.equal(mailDraft.wantsComposition('send Lakeside an email', ''), true);
});

test('the facts are the recipient\'s own records, and a draft that uses anything else is not shown', async () => {
  const { db, w, lakeside, po } = setup();
  const recipient = { kind: 'supplier', id: lakeside.id, name: lakeside.name, email: 'orders@lakeside.test' };
  const facts = mailDraft.gatherFacts(db, w.ctx, recipient);
  const text = facts.map((f) => f.text).join('\n');
  assert.match(text, new RegExp(`Purchase order ${po.poNumber}: placed with them`));
  assert.match(text, /27 Copper Elbow; 27 units still to arrive; expected by 2026-09-20/);
  assert.doesNotMatch(text, /PO-9999/);
  assert.deepEqual(mailDraft.unsupported(`Order ${po.poNumber} was due 2026-09-20 and 27 units are outstanding.`, facts), []);
  assert.deepEqual(mailDraft.unsupported(`Order PO-9999 was due 2026-10-01, 40 units.`, facts).sort(), ['2026-10-01', '40', 'po-9999']);
  assert.deepEqual(mailDraft.unsupported('We have two orders open.', facts), [], 'a small count is not a fact');

  let calls = 0;
  const inventing = { async complete() { calls += 1; return { data: { subject: 'PO-9999', body: 'Please confirm order PO-9999 for 40 units due 2026-10-01.', factsUsed: [1], couldNotWrite: '' } }; } };
  const refused = await mailDraft.compose(db, w.ctx, { recipient, purpose: 'ask when it will arrive', instruction: 'ask Lakeside when it will arrive' }, { provider: inventing });
  assert.equal(refused.ok, false);
  assert.equal(calls, 2, 'one retry, then it stops');
  assert.match(refused.question, /could not write that without adding details that are not in your records \(po-9999, [\d-]+, [\d-]+\)/);

  const honest = { async complete() { return { data: { subject: `When will ${po.poNumber} arrive?`, body: `Hi Lakeside Textiles,\nCould you confirm when ${po.poNumber} (27 Copper Elbow, expected by 2026-09-20) will arrive?\nThanks,\nOlive Owner`, factsUsed: [2, 4], couldNotWrite: '' } }; } };
  const draft = await mailDraft.compose(db, w.ctx, { recipient, purpose: 'ask when it will arrive', instruction: 'ask Lakeside when it will arrive' }, { provider: honest });
  assert.equal(draft.ok, true);
  assert.equal(draft.factsUsed.length, 2);
  assert.match(draft.factsUsed[1].text, /Purchase order/);
});

test('a composed draft is written to the message record, shown with its facts, and never sent', async () => {
  const { db, w, lakeside, po } = setup();
  const provider = { async complete(r) {
    if (r.schemaName === 'assistant_mail_draft') return { data: { subject: 'Price list', body: `Hi Lakeside Textiles,\nCould you send us your current price list? Our open order is ${po.poNumber}.\nThanks,\nOlive Owner`, factsUsed: [2, 4], couldNotWrite: '' } };
    return { data: { lines: [{ actionType: 'send_message', item: '', variant: '', sourceText: 'email Lakeside and ask for a price list', lotCode: '', serials: [], sourceLocation: '', destinationLocation: '', quantity: -1, adjustmentTarget: -1, reasonCode: '', terminologyKey: '', terminologyValue: '', productName: '', productCode: '', variantAxes: '', unitLabel: '', kitComponents: [], supplier: '', purchaseUnit: '', amount: -1, reference: '', recipient: 'Lakeside', messageBody: 'ask for a price list' }], clarifyingQuestion: '', unsupportedReason: '' } };
  } };
  const result = await outbound.prepareOrCompose(db, w.ctx, { recipientText: 'Lakeside', body: 'ask for a price list', instruction: 'email Lakeside and ask for a price list' }, { provider });
  assert.equal(result.kind, 'message_draft');
  assert.equal(result.composed, true);
  assert.equal(result.mailbox, 'none', 'no mailbox: the draft is still written');
  const message = outbound.record(db, w.ctx, result);
  assert.equal(message.status, 'PREPARED');
  assert.equal(message.messageKind, 'assistant_draft');
  const kept = db.prepare('SELECT facts, facts_used FROM assistant_draft_facts WHERE message_id = ?').get(message.id);
  assert.ok(kept, 'the facts are kept beside the message');
  assert.equal(JSON.parse(kept.facts_used).length, 2);
  void lakeside;

  const app = createApp({ db, env: 'test', sessionSecret: 'phase4', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const page = await agent.get(`/messages/${message.id}`);
  assert.match(page.text, /StockChief wrote this from your records for what you asked/);
  assert.match(page.text, /What this draft is based on/);
  assert.match(page.text, /● Purchase order/);
  assert.match(page.text, /No mailbox is connected/);
  assert.doesNotMatch(page.text, /name="action" value="send"/, 'nothing to send it from, no send button');
  assert.equal(db.prepare('SELECT status FROM customer_communications WHERE id = ?').get(message.id).status, 'PREPARED');
});

// G3
test('"How do I create a purchase order?" gets the steps, from the brain, without a model', () => {
  const { db, w, membership } = setup();
  const result = navigation.resolve(db, w.workspaceId, membership, 'How do I create a purchase order?');
  assert.ok(result && result.howTo, JSON.stringify(result));
  assert.match(result.answer, /^How to create a purchase order:\n1\. Tell StockChief: Type “order 12 Copper Elbow from Acme”/);
  assert.match(result.answer, /2\. Or by hand: Purchasing → Write a purchase order/);
  assert.match(result.answer, /3\. You need: “Prepare purchase orders” to make changes, and “See suppliers and purchase orders” to see it\. You have that\./);
  assert.match(result.answer, /4\. What happens after: Nothing is ordered until you approve the draft/);
  assert.equal(result.href, '/purchasing');
  assert.equal(howTo.topic('how do i receive a delivery').id, 'receive');
  assert.equal(howTo.topic('what is the process to count stock').id, 'count');
  assert.equal(howTo.topic('how do I invite my accountant').id, 'people');
  assert.equal(howTo.topic('how do i set up a reorder point').id, 'rule');
  assert.equal(navigation.resolve(db, w.workspaceId, membership, 'how many copper elbow do we have'), null, 'a question about stock is not a how-to');
});

// General knowledge
test('a general question is answered as general knowledge, labelled, and never answered with a lookup question', async () => {
  const { db, w } = setup();
  assert.equal(general.looksGeneral(db, w.workspaceId, 'what does FIFO mean?'), true);
  assert.equal(general.looksGeneral(db, w.workspaceId, 'whats a sensible safety stock for a product that sells 60 a month?'), true);
  assert.equal(general.looksGeneral(db, w.workspaceId, 'what is the stock of copper elbow'), false, 'a named product is the records');
  assert.equal(general.looksGeneral(db, w.workspaceId, 'what is my inventory worth'), false);
  const provider = { async complete(r) {
    if (r.schemaName === 'assistant_general_knowledge') {
      assert.doesNotMatch(r.prompt, /Copper Elbow|Lakeside/, 'no record values reach a general-knowledge prompt');
      return { data: { answer: 'FIFO stands for first in, first out: the oldest stock is used or sold first.', needsRecords: false } };
    }
    throw new Error(`unexpected model call ${r.schemaName}`);
  } };
  const planner = require('../../src/attention/query-planner');
  const result = await planner.ask(db, w.workspaceId, 'what does FIFO mean?', { provider });
  assert.equal(result.general, true);
  assert.equal(result.plan.intent, 'general_knowledge');
  assert.match(result.answer, /^FIFO stands for first in, first out/);

  const app = createApp({ db, env: 'test', sessionSecret: 'phase4', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'what does FIFO mean?', queryConversation: '1' });
  const page = await agent.get(posted.headers.location);
  assert.match(page.text, /General knowledge — not read from your records/);
  assert.doesNotMatch(page.text, /How StockChief read this/);
  const goal = db.prepare('SELECT status, provenance FROM assistant_goals ORDER BY created_at DESC LIMIT 1').get();
  assert.equal(goal.status, 'answered');
  assert.equal(JSON.parse(goal.provenance).general, true);
});
