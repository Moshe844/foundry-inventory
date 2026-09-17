'use strict';

/**
 * Things an owner actually types, each with what came back the first time
 * against the live model, before the fix. Every one is now read in code
 * where it can be, so these run without a model.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const poService = require('../../src/purchasing/po-service');
const supplierService = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const locationService = require('../../src/domain/location-service');
const physicalEvents = require('../../src/manager/physical-events');
const paymentIntent = require('../../src/accounting/payment-intent');
const outbound = require('../../src/actions/outbound-message');
const operating = require('../../src/manager/operating-instructions');
const navigation = require('../../src/product-brain/navigation');
const queryService = require('../../src/attention/query-service');
const intentRouter = require('../../src/manager/intent-router');
const actionService = require('../../src/actions/action-service');
const intentService = require('../../src/actions/intent-service');
const execution = require('../../src/actions/execution-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, makeVariantItem, cleanupAll, signIn, csrfFrom } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  const acme = supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply' });
  const lakeside = supplierService.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles', email: 'orders@lakeside.test' });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 2, isPreferred: true });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 3 });
  const po = poService.createOrder(db, w.ctx, membership, { supplierId: acme.id, lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 240, unitCost: 2 }], source: 'test' });
  poService.approve(db, w.ctx, membership, po.id);
  const po2 = poService.createOrder(db, w.ctx, membership, { supplierId: lakeside.id, lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 12, unitCost: 3 }], source: 'test' });
  poService.approve(db, w.ctx, membership, po2.id);
  const app = createApp({ db, env: 'test', sessionSecret: 'hammer' });
  return { db, w, membership, app, elbow, acme, lakeside, po, po2 };
}

// 19. Before: "could not place it on its own" → Needs you, with the PO named in the sentence.
test('"the acme delivery for PO-… arrived" goes straight to booking in that order', () => {
  const { db, w, po } = setup();
  const event = physicalEvents.record(db, w.ctx, { eventType: 'shipment_arrived', statedAs: `the acme delivery for ${po.poNumber} arrived, all 240 elbows, all good` });
  assert.equal(event.status, 'ROUTED');
  assert.equal(event.matchedEntities.purchaseOrderId, po.id);
  const outcome = physicalEvents.describeOutcome(db, w.workspaceId, event);
  assert.equal(outcome.redirectTo, `/purchasing/orders/${po.id}/receive?event=${event.id}`);
  const byName = physicalEvents.record(db, w.ctx, { eventType: 'shipment_arrived', statedAs: 'the Lakeside delivery arrived' });
  assert.equal(byName.status, 'ROUTED', 'a supplier with exactly one open order is enough');
});

// 21. Before: ran the replenishment planner — "8 pieces of inventory work prepared".
test('"add a new supplier called Bright Tools, email …" fills the supplier form in and saves nothing', async () => {
  const { app, w, db } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const before = db.prepare('SELECT COUNT(*) n FROM action_proposals').get().n;
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'add a new supplier called Bright Tools, email sales@brighttools.com' });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.location, '/suppliers?name=Bright+Tools&email=sales%40brighttools.com#add-supplier');
  const page = await agent.get('/suppliers?name=Bright+Tools&email=sales%40brighttools.com');
  assert.match(page.text, /name="name" required maxlength="160" placeholder="ABC Footwear" value="Bright Tools"/);
  assert.match(page.text, /name="email" maxlength="160" value="sales@brighttools.com"/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM suppliers WHERE name = 'Bright Tools'").get().n, 0, 'nothing is saved until Add is pressed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM action_proposals').get().n, before, 'no replenishment work was prepared from it');
});

// 23. Before: "Which product should StockChief protect … block outgoing stock or only warn you?"
test('"from now on reorder gloves whenever we drop below 20" is a reorder point, read in code', () => {
  const rule = operating.__compileReorderRule('from now on reorder gloves whenever we drop below 20');
  assert.ok(rule);
  assert.equal(rule.changes[0].domain, 'replenishment');
  assert.equal(rule.changes[0].itemText, 'gloves');
  assert.equal(rule.changes[0].reorderPoint, 20);
  assert.equal(operating.__compileReorderRule('block sales of gloves when below 20 until reordered'), null, 'a protection rule is not a reorder point');
});

// 24. Before: "could not find anything matching Lakeside" with three of their orders open.
test('"what\'s on order from Lakeside?" names a supplier, not a product', () => {
  const { db, w, po2 } = setup();
  const result = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'on_order', entityQuery: 'Lakeside' }), { question: 'whats on order from Lakeside?' });
  assert.match(result.answer, /Lakeside Textiles has not (?:yet )?confirmed PO-\d+/);
  assert.match(result.answer, /12 units still to come/);
  assert.equal(result.rows[0].label, po2.poNumber);
});

// 29. Before: "Which product should receive this purchase cost?" — and the reference "oice".
test('"I paid Acme $500 against their invoice" is a payment report, and "invoice" is not a reference', async () => {
  const { db, w } = setup();
  const planner = { async complete() { throw new Error('the closed form must not reach the planner'); } };
  const classified = await intentRouter.classify(db, w.ctx, 'I paid Acme $500 today against their invoice', { provider: planner, goalKind: 'report' });
  assert.equal(classified.intentClass, 'PAYMENT_REPORT');
  assert.equal(paymentIntent.__deterministic('I paid Acme $500 today against their invoice').reference, '');
  assert.equal(paymentIntent.__deterministic('paid $200 on PO-1013').reference, 'PO-1013');
  assert.equal(paymentIntent.__deterministic('paid invoice #4471').reference, '4471');
});

// 31. Before: "no customer or supplier called Acme", then a dead end with no email.
test('"send Acme an email" finds Acme Trade Supply, and says where to add the missing address', () => {
  const { db, w, acme, membership } = setup();
  const prepared = outbound.prepare(db, w.ctx, { recipientText: 'Acme', body: 'When will it ship?', instruction: 'send Acme an email' });
  assert.equal(prepared.kind, 'question');
  assert.match(prepared.question, /no email address on file for Acme Trade Supply/);
  assert.equal(prepared.where.href, `/suppliers/${acme.id}`);
  supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Fasteners' });
  const two = outbound.prepare(db, w.ctx, { recipientText: 'Acme', body: 'x', instruction: 'x' });
  assert.match(two.question, /“Acme” could be Acme (?:Trade Supply|Fasteners) or Acme (?:Trade Supply|Fasteners)\. Which one\?/);
});

// 27. Before: "What would you like to know about copper elbow?"
test('"show me everything about copper elbow" opens the product page, or offers the products that fit', () => {
  const { db, w, membership, elbow } = setup();
  const one = navigation.resolve(db, w.workspaceId, membership, 'show me everything about copper elbow');
  assert.equal(one.kind, 'navigation');
  assert.equal(one.href, `/inventory/${elbow.itemId}`);
  assert.equal(one.navigateNow, true);
  makeQuantityItem(db, w.ctx, { name: '1/2in Copper Elbow', baseCode: 'CE-ALT' });
  const two = navigation.resolve(db, w.workspaceId, membership, 'show me everything about elbow');
  assert.equal(two.kind, 'clarify');
  assert.deepEqual([...two.choices].sort(), ['everything about 1/2in Copper Elbow', 'everything about Copper Elbow']);
});

// 32. Before: "Which Children's Sweater do you mean?" — to a sentence that said "all".
test('"move all the sweaters from the van" moves every variant the van holds, at what it holds', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const van = locationService.createLocation(db, w.ctx, { name: 'Service Van 3', kind: 'truck' });
  const item = makeVariantItem(db, w.ctx);
  engine.receive(db, w.ctx, { skuId: item.byLabel('Navy / 4').id, locationId: van.id, quantity: 3 });
  engine.receive(db, w.ctx, { skuId: item.byLabel('Cream / 5').id, locationId: van.id, quantity: 2 });
  const line = intentService.normaliseLine({ actionType: 'transfer', item: "Children's Sweater", variant: '', sourceLocation: 'Service Van 3', destinationLocation: 'Downtown Store',
    quantity: -1, adjustmentTarget: -1, reasonCode: '', sourceText: 'move all the sweaters from the van to the store' });
  const result = await actionService.interpret(db, w.ctx, membership, 'move all the sweaters from the van to the store', { parsedIntent: { lines: [line], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'plan', JSON.stringify(result).slice(0, 300));
  assert.deepEqual(result.plan.lines.map((p) => p.quantity).sort(), [2, 3]);
});

// 34. Before: "Selling prices is available. You can use it with your current role…" — to a question about gloves.
test('"do we have enough gloves for the winter?" is about gloves, not about a feature, and is answered with what is held', () => {
  const { db, w, membership } = setup();
  const nav = navigation.resolve(db, w.workspaceId, membership, 'do we have enough copper elbow for the winter? we usually sell about 60 a month');
  assert.equal(nav, null, 'the navigation resolver leaves a business question alone');
  const forecast = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'demand_forecast', entityQuery: 'copper elbow', windowDays: 90 }), { question: 'do we have enough copper elbow?' });
  assert.match(forecast.answer, /Copper Elbow: 40 on hand/);
  assert.doesNotMatch(forecast.answer, /most demand for/);
});

// 37. Before: every product's every position, with the van's figure somewhere in the list.
test('"how much is in the van?" is what the van holds, product by product', () => {
  const { db, w } = setup();
  const van = locationService.createLocation(db, w.ctx, { name: 'Service Van 3', kind: 'truck' });
  const pack = makeQuantityItem(db, w.ctx, { name: 'Trail Ration Pack', baseCode: 'TRP' });
  engine.receive(db, w.ctx, { skuId: pack.skuId, locationId: van.id, quantity: 10 });
  const result = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'stock_by_location', entityQuery: '', locationQuery: 'Service Van 3' }), { question: 'how much is in the van' });
  assert.equal(result.answer, 'Service Van 3 holds 10 units across 1 product: 10 Trail Ration Pack.');
});

// 36. Before: "StockChief read that as being about purchasing, but not what to do".
test('"cancel PO-… we don\'t need it" opens the order at its cancel control and cancels nothing', async () => {
  const { app, w, po, db } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: `cancel ${po.poNumber} we dont need it` });
  assert.equal(posted.headers.location, `/purchasing/orders/${po.id}#cancel`);
  assert.notEqual(db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(po.id).status, 'CANCELLED');
});

// 44. Before: read as a stock change, then "Which location?".
test('"we got a return today, 2 … from Marlow, one is damaged" opens the return form filled in', async () => {
  const { app, w } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'we got a return today, 2 copper elbow from Marlow, one is damaged' });
  assert.equal(posted.status, 303);
  assert.match(posted.headers.location, /^\/warehouse\/operations\?returnCustomer=Marlow&returnQuantity=2&returnReason=Damaged&returnProduct=Copper\+Elbow#customer-returns$/);
});

// Round three.
test('"we sold 3 X at the store and 2 Y from the van" is two changes even when the reader returned one', async () => {
  const one = (item, qty, loc) => ({ actionType: 'issue', item, variant: '', sourceText: `we sold ${qty} ${item}`, lotCode: '', serials: [], sourceLocation: loc, destinationLocation: '',
    quantity: qty, adjustmentTarget: -1, reasonCode: 'sold', terminologyKey: '', terminologyValue: '', productName: '', productCode: '', variantAxes: '', unitLabel: '', kitComponents: [], supplier: '', purchaseUnit: '', amount: -1, reference: '', recipient: '', messageBody: '' });
  const provider = { async complete(r) {
    const text = r.prompt.split('Instruction: ')[1] || '';
    if (/sweater.*elbow/s.test(text)) return { data: { lines: [one('Children\'s Sweater', 3, 'Downtown Store')], clarifyingQuestion: '', unsupportedReason: '' } };
    if (/elbow/.test(text)) return { data: { lines: [one('Copper Elbow', 2, 'Service Van 3')], clarifyingQuestion: '', unsupportedReason: '' } };
    return { data: { lines: [one('Children\'s Sweater', 3, 'Downtown Store')], clarifyingQuestion: '', unsupportedReason: '' } };
  } };
  const intent = await intentService.readInstruction('we sold 3 sweater navy 4 at the store and 2 copper elbow from the van', { context: { itemNames: ['Children\'s Sweater', 'Copper Elbow'], locationNames: ['Downtown Store', 'Service Van 3'] }, provider });
  assert.deepEqual(intent.lines.map((l) => [l.item, l.quantity]), [['Children\'s Sweater', 3], ['Copper Elbow', 2]]);
});

test('two questions in one sentence stay one multi-part question', async () => {
  const understand = require('../../src/assistant/understand');
  const split = { async complete() { return { data: { continuesPrevious: false, goals: [{ kind: 'lookup', text: 'how many navy sweaters in size 5 at the store' }, { kind: 'lookup', text: 'how many are on order' }] } }; } };
  const result = await understand.understand('how many navy sweaters in size 5 at the store, and how many are on order', { provider: split });
  assert.equal(result.goals.length, 1);
});

test('"navy sweaters size 5" is Navy / 5, not every navy sweater', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeVariantItem(db, w.ctx);
  const found = queryService.resolveSkus(db, w.workspaceId, 'navy sweaters size 5', 25);
  assert.deepEqual(found.map((s) => s.variant_label), ['Navy / 5']);
});

test('"how much did we sell last week?" is a window and a sum of money; a named supplier gets its own delivery record; "all products" is all of them', () => {
  const { db, w, membership, elbow, acme } = setup();
  const sales = require('../../src/sales/sales-order-service');
  const prices = require('../../src/pricing/price-service');
  prices.setPrice(db, w.ctx, { skuId: elbow.skuId, amountMinor: 250, currency: 'USD', source: 'owner' });
  const customer = sales.createCustomer(db, w.ctx, { name: 'Fresh Cafe' });
  sales.createOrder(db, w.ctx, { customerId: customer.id, lines: [{ skuId: elbow.skuId, quantity: 4 }] });
  const week = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'sales_summary', windowDays: 7 }), { question: 'how much did we sell last week in dollars?' });
  assert.match(week.answer, /In the last 7 days, customers ordered \$10\.00 across 1 order \(4 units\)/);
  const supplier = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'most_reliable_supplier', entityQuery: 'acme' }), { question: 'how long does acme take to deliver?' });
  assert.match(supplier.answer, /^Acme Trade Supply has not delivered an order yet/);
  assert.doesNotMatch(supplier.answer, /Lakeside/);
  void acme;
  const list = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'selling_price', entityQuery: '' }), { question: 'give me a list of all products with their prices' });
  assert.equal(list.answer, 'Copper Elbow is priced at $2.50.');
  makeQuantityItem(db, w.ctx, { name: 'Unpriced Thing', baseCode: 'UP' });
  const two = queryService.execute(db, w.workspaceId, queryService.normalisePlan({ intent: 'selling_price', entityQuery: '' }), { question: 'all products with prices' });
  assert.equal(two.answer, '2 stock lines; 1 has no selling price set yet. Copper Elbow $2.50.');
});

test('"receive 50 trail ration pack into main warehouse at $4.20 each from acme" keeps the cost and names the supplier', async () => {
  const { db, w, membership } = setup();
  const pack = makeQuantityItem(db, w.ctx, { name: 'Trail Ration Pack', baseCode: 'TRP' });
  const intent = await intentService.readInstruction('receive 50 trail ration pack into main warehouse at $4.20 each from acme',
    { context: { itemNames: ['Trail Ration Pack', 'Copper Elbow'], locationNames: ['Main Warehouse', 'Downtown Store'] }, provider: { async complete() { throw new Error('read in code'); } } });
  assert.equal(intent.lines[0].unitCostMinor, 420);
  assert.equal(intent.lines[0].supplier, 'acme');
  const result = await actionService.interpret(db, w.ctx, membership, 'receive 50 trail ration pack into main warehouse at $4.20 each from acme', { parsedIntent: intent });
  assert.equal(result.kind, 'proposal', JSON.stringify(result).slice(0, 200));
  assert.ok(result.proposal.assumptions.some((a) => /\$4\.20 each, will be recorded/.test(a)));
  execution.approve(db, w.ctx, membership, result.proposal.proposalId);
  execution.execute(db, w.ctx, membership, result.proposal.proposalId);
  const cost = db.prepare('SELECT amount_minor FROM sku_purchase_costs WHERE sku_id = ? ORDER BY rowid DESC LIMIT 1').get(pack.skuId);
  assert.equal(cost.amount_minor, 420);
});

test('"rename downtown store to city store" opens the location\'s edit form with the new name, renaming nothing', async () => {
  const { app, w, db } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'rename downtown store to City Store' });
  assert.equal(posted.headers.location, `/locations?edit=${w.store.id}&name=City%20Store#modal-location-${w.store.id}`);
  const page = await agent.get(`/locations?edit=${w.store.id}&name=City%20Store`);
  assert.match(page.text, new RegExp(`id="edit-name-${w.store.id}" name="name" value="City Store"`));
  assert.equal(db.prepare('SELECT name FROM locations WHERE id = ?').get(w.store.id).name, 'Downtown Store');
});

// Round four: a six-turn conversation.
test('"move 10 of them there" means the product and place the conversation was just about', () => {
  const { resolvePronouns } = require('../../src/assistant/understand');
  const moved = resolvePronouns('move 10 of them there', { product: 'Trail Ration Pack', location: 'Downtown Store' });
  assert.equal(moved.text, 'move 10 Trail Ration Pack to Downtown Store');
  assert.deepEqual(moved.swaps.map((s) => s.word), ['them', 'there']);
  assert.equal(resolvePronouns('how many are there', { product: 'Trail Ration Pack', location: 'Downtown Store' }).text, 'how many are there', 'a question is left alone');
  assert.equal(resolvePronouns('move 10 of them there', {}).text, 'move 10 of them there', 'nothing to resolve against, nothing changed');
});

test('the ledger knows what the conversation was last about and what was last settled', () => {
  const ledger = require('../../src/assistant/ledger');
  const { db, w } = setup();
  const turn = ledger.openTurn(db, w.ctx, { conversationId: 'c1', channel: 'ask', message: 'and at the store?', understanding: {}, goals: [{ kind: 'lookup', text: 'and at the store?' }] });
  ledger.settle(db, w.ctx, turn.goals[0].id, { status: 'answered', said: 'Downtown Store: 24 on hand.', provenance: { reads: [{ entity: 'Trail Ration Pack', location: 'Downtown Store' }] } });
  assert.deepEqual(ledger.lastSubjects(db, w.ctx, 'c1'), { product: 'Trail Ration Pack', location: 'Downtown Store' });
  const second = ledger.openTurn(db, w.ctx, { conversationId: 'c1', channel: 'ask', message: 'move 10 of them there', understanding: {}, goals: [{ kind: 'change', text: 'move 10 of them there' }] });
  ledger.settle(db, w.ctx, second.goals[0].id, { status: 'needs_approval', resultHref: '/actions/act_1', said: 'Prepared.' });
  assert.equal(ledger.lastSettled(db, w.ctx, 'c1').id, second.goals[0].id);
  assert.ok(ledger.GOAL_STATUSES.includes('replaced'), 'a corrected proposal is recorded as replaced');
});

test('"what did I just do?", "thanks" and "hi" are answered from the ledger, without a model', async () => {
  const { app, w } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const hi = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'hi', queryConversation: '1' });
  const hiPage = await agent.get(hi.headers.location);
  assert.match(hiPage.text, /Hello\. Ask about stock, orders, suppliers or money/);
  assert.doesNotMatch(hiPage.text, /How StockChief read this/, 'a greeting shows no provenance block');
  const recap = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'what did I just do?', queryConversation: '1' });
  assert.match(recap.headers.location, /^\/ask\?q=what%20did%20I%20just%20do%3F&recap=1$/);
  const recapPage = await agent.get(recap.headers.location);
  assert.match(recapPage.text, /Here is what just happened, newest last:/);
  assert.match(recapPage.text, /You said “hi” — answered: Hello\./);
  assert.doesNotMatch(recapPage.text, /You said “what did I just do/, 'the question is not part of its own answer');
  const thanks = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'ok thanks', queryConversation: '1' });
  const thanksPage = await agent.get(thanks.headers.location);
  assert.match(thanksPage.text, /You’re welcome\./);
});

test('"do it" opens the proposal this conversation prepared; it does not run it', async () => {
  const { app, w, db } = setup();
  const proposals = require('../../src/actions/proposal-service');
  const built = proposals.build(db, w.ctx, { actionType: 'transfer', item: 'Copper Elbow', sourceLocation: w.main.name, destinationLocation: w.store.name, quantity: 10 });
  const stored = proposals.persist(db, w.ctx, built.proposal, { sourceType: 'USER_REQUEST', instruction: 'move 10 copper elbow to the store' });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'do it', queryConversation: '1' });
  assert.equal(posted.headers.location, `/actions/${stored.proposalId}`);
  assert.equal(proposals.get(db, w.workspaceId, stored.proposalId).status, 'AWAITING_APPROVAL', 'nothing ran');
  assert.equal(db.prepare('SELECT on_hand FROM balances WHERE sku_id = ? AND location_id = ?').get(built.proposal.skuId, w.main.id).on_hand, 40);
});

test('two good batches: "move 10" takes the earliest to expire and says so, instead of asking', () => {
  const { makeLotItem } = require('../helpers');
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const lot = makeLotItem(db, w.ctx);
  engine.receive(db, w.ctx, { skuId: lot.skuId, locationId: w.main.id, quantity: 60, lotCode: 'L-1', expiresAt: '2026-10-30' });
  engine.receive(db, w.ctx, { skuId: lot.skuId, locationId: w.main.id, quantity: 80, lotCode: 'L-2', expiresAt: '2027-01-15' });
  const proposals = require('../../src/actions/proposal-service');
  const built = proposals.build(db, w.ctx, { actionType: 'transfer', item: 'Trail Ration Pack', sourceLocation: w.main.name, destinationLocation: w.store.name, quantity: 10 });
  assert.ok(built.ok, JSON.stringify(built));
  assert.match(built.proposal.assumptions.join(' '), /Taking it from batch L-1 \(expires 2026-10-30\), the earliest to expire of the 2 batches at Main Warehouse\. Say a batch code if you meant another\./);
});

// Round five.
test('"stop reordering <product>" is a rule about that product, never a pause of everything', () => {
  const { db, w } = setup();
  assert.equal(navigation.mentionsProduct(db, w.workspaceId, 'stop reordering copper elbow'), true);
  assert.equal(navigation.mentionsProduct(db, w.workspaceId, 'stop'), false);
  const importRemovals = require('../../src/manager/import-removals');
  assert.equal(importRemovals.matchesInstruction('delete the Brass Tee product I just added'), false, 'a named product is not an import rollback');
  assert.equal(importRemovals.matchesInstruction('remove the newly added products'), true);
});

test('"add a new product … we buy it at $1.10 and sell at $3.50" is not a price list', () => {
  const priceChanges = require('../../src/pricing/price-changes');
  assert.equal(priceChanges.matchesInstruction('add a new product: Brass Tee 3/4 in, we buy it at $1.10 and sell at $3.50, put 40 in the warehouse'), false);
  assert.equal(priceChanges.matchesInstruction('Add a price for each item'), true);
  assert.equal(priceChanges.matchesInstruction('change the price of trail ration pack to 12.99'), true);
});

test('"lower the price of all the gloves by 10%" is one proposal per priced variant, and the unpriced are said', () => {
  const priceChanges = require('../../src/pricing/price-changes');
  const prices = require('../../src/pricing/price-service');
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const glove = makeVariantItem(db, w.ctx, { name: 'Harbour Work Glove', baseCode: 'HG', options: [{ name: 'Size', values: 'M, L, XL' }] });
  prices.setPrice(db, w.ctx, { skuId: glove.skus[0].id, amount: '10.00', currency: 'USD' });
  prices.setPrice(db, w.ctx, { skuId: glove.skus[1].id, amount: '12.00', currency: 'USD' });
  assert.equal(priceChanges.matchesPercentInstruction('lower the price of all the gloves by 10%'), true);
  assert.equal(priceChanges.matchesPercentInstruction('lower the price of gloves to $5'), false);
  const batch = priceChanges.interpretPercent(db, w.ctx, 'lower the price of all the gloves by 10%');
  assert.equal(batch.proposals.length, 2);
  assert.deepEqual(batch.proposals.map((p) => p.amount_minor).sort((a, b) => a - b), [900, 1080]);
  assert.equal(batch.unpriced, 1);
  assert.equal(batch.direction, -1);
  assert.deepEqual(priceChanges.readPercent('put the price of copper elbow up 20%'), { what: 'copper elbow', pct: 20, direction: 1 });
});

test('"what do we owe Acme?" reads Acme’s bills; "which products are we losing money on?" reads from the bottom', () => {
  const semantic = require('../../src/attention/semantic-query');
  const { db, w } = setup();
  assert.equal(semantic.namesAParty(db, w.workspaceId, 'Acme'), true);
  assert.equal(semantic.namesAParty(db, w.workspaceId, 'copper elbow'), false);
  const losing = queryService.execute(db, w.workspaceId, { intent: 'product_profitability', windowDays: 30, limit: 10 }, { question: 'which products are we losing money on?' });
  assert.match(losing.answer, /Nothing sold with a recorded cost|sold for less than|None of the|financial|No product-level/);
});

test('"how much stock do we have, in dollars" gets both figures; "list the open purchase orders with their totals" lists them', async () => {
  const { db, w, app, po, po2 } = setup();
  const planner = require('../../src/attention/query-planner');
  const worth = await planner.ask(db, w.workspaceId, 'how much stock do we have in total, in dollars', { semantic: false });
  assert.match(worth.answer, /^Two ways to count it\./);
  const open = queryService.execute(db, w.workspaceId, { intent: 'open_purchase_orders', limit: 25 }, {});
  assert.equal(open.rows.length, 2);
  assert.match(open.answer, /^2 open purchase orders, \$516\.00 in all: /);
  assert.ok(open.rows.some((r) => r.label === po.poNumber && r.total === '$480.00'));
  assert.ok(open.rows.some((r) => r.label === po2.poNumber && r.total === '$36.00'));
  assert.equal(navigation.isBusinessDataQuestion('list the open purchase orders with their totals'), true);
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'list the open purchase orders with their totals', queryConversation: '1' });
  const page = await agent.get(posted.headers.location);
  assert.match(page.text, /2 open purchase orders, \$516\.00 in all/);
});

test('"Brass Tee" is not Brass Compression Nut: a word that matches nothing is a question, not a substitution', () => {
  const resolver = require('../../src/actions/resolver');
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Brass Compression Nut 15mm', baseCode: 'BN' });
  const result = resolver.resolveSku(db, w.workspaceId, 'Brass Tee', '');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ambiguous');
  assert.match(result.message, /“Brass Tee” — nothing here is called that\. “tee” is not in any product name; “brass” matches Brass Compression Nut 15mm\. Did you mean that\?/);
  assert.ok(resolver.resolveSku(db, w.workspaceId, 'brass nuts', '').ok, 'a plural of a real word still finds it');
});

test('a count sheet is read in code, every line kept, and a line that already matches is said rather than dropped', async () => {
  const { db, w, elbow } = setup();
  const context = actionService.instructionContext(db, w.workspaceId);
  const sheet = intentService.deterministicCountSheet('we counted the warehouse today: 35 copper elbow, 0 widgets', context);
  assert.ok(sheet, 'read without a model');
  assert.deepEqual(sheet.lines.map((l) => [l.actionType, l.item, l.sourceLocation, l.adjustmentTarget]), [['adjust', 'Copper Elbow', 'Main Warehouse', 35], ['adjust', 'widgets', 'Main Warehouse', 0]]);
  assert.equal(intentService.deterministicCountSheet('move 3 copper elbow from the warehouse to the store', context), null);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  makeQuantityItem(db, w.ctx, { name: 'Solder Wire', baseCode: 'SW' });
  const result = await actionService.interpret(db, w.ctx, membership, 'we counted the warehouse today: 35 copper elbow, 0 solder wire', { provider: { async complete() { throw new Error('no model needed'); } } });
  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.equal(result.proposal.adjustmentTarget, 35);
  assert.equal(result.proposal.skuId, elbow.skuId);
  assert.match(result.proposal.assumptions.join(' '), /One line of what you said already matched the records, so it was left alone: Solder Wire at Main Warehouse is already 0\./);
});

test('answering "which place should it come out of?" settles the goal as prepared, not left waiting', () => {
  // The source question carries no server-held continuation, so the actions
  // page clears it from the session when it renders; the answer still has to
  // settle the goal that asked.
  const ledger = require('../../src/assistant/ledger');
  const turns = require('../../src/assistant/turns');
  const { db, w } = setup();
  const turn = ledger.openTurn(db, w.ctx, { conversationId: 'default', channel: 'ask', message: 'move 10 of them there', understanding: {}, goals: [{ kind: 'change', text: 'move 10 of them there' }] });
  ledger.settle(db, w.ctx, turn.goals[0].id, { status: 'clarify', said: 'Which should it come out of?', resultHref: '/actions', resultLabel: 'Answer the question' });
  const req = { db, ctx: w.ctx, session: { assistantConversationId: 'default' } };
  const redirected = [];
  const res = { redirect: (...args) => redirected.push(args[args.length - 1]) };
  turns.resume(req, res);
  res.redirect(303, '/actions/act_prepared');
  assert.deepEqual(redirected, ['/actions/act_prepared']);
  const settled = ledger.getGoal(db, w.workspaceId, turn.goals[0].id);
  assert.equal(settled.status, 'needs_approval');
  assert.equal(settled.resultHref, '/actions/act_prepared');
});

// 88. Before: "Creating a new customer record is not one of the operations
// listed above" — the reader's aside about its own instructions, shown as a
// refusal.
test('"Can you create a customer? Name: Moshe, email: …" fills the customer form in and saves nothing', async () => {
  const { app, w, db } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'Can you create a customer? Name: Moshe, email: arye6700@gmail.com' });
  assert.equal(posted.status, 303);
  assert.equal(posted.headers.location, '/sales/customers/new?name=Moshe&email=arye6700%40gmail.com');
  const page = await agent.get(posted.headers.location);
  assert.match(page.text, /name="name" value="Moshe"/);
  assert.match(page.text, /name="email" value="arye6700@gmail.com"/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM customers WHERE name = 'Moshe'").get().n, 0, 'nothing is saved until Save is pressed');
  const goal = db.prepare("SELECT status, said FROM assistant_goals ORDER BY rowid DESC LIMIT 1").get();
  assert.equal(goal.status, 'handed');
  assert.match(goal.said, /Opened the new-customer form with “Moshe” \(arye6700@gmail.com\) filled in/);
  // Other phrasings land on the same door; an order for a customer does not.
  const again = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'add a new client called Bright Homes Ltd, phone 555-0100' });
  assert.equal(again.headers.location, '/sales/customers/new?name=Bright+Homes+Ltd&phone=555-0100');
  const order = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'create a customer order for Moshe, 3 copper elbow' });
  assert.notEqual((order.headers.location || '').split('?')[0], '/sales/customers/new');
});

test('a refusal that quotes the reader\'s own instructions is replaced by a plain sentence and the door', async () => {
  const { db, w } = setup();
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const provider = { async complete() { return { data: { lines: [], clarifyingQuestion: '', unsupportedReason: 'Creating a new customer record is not one of the operations listed above.' } }; } };
  const result = await actionService.interpret(db, w.ctx, membership, 'please make me a customer file for Dana', { provider });
  assert.equal(result.kind, 'unsupported');
  assert.doesNotMatch(result.message, /listed above|operations/i);
  assert.match(result.message, /cannot do that from a sentence yet/);
  assert.deepEqual(result.where, { href: '/sales/customers/new', label: 'Add a customer' });
});

// 89. "Once done I should be back at the chat."
test('saving the form StockChief handed you to brings you back to the chat, with the goal done', async () => {
  const { app, w, db } = setup();
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const ask = await agent.get('/ask');
  const csrf = csrfFrom(ask.text);
  const handed = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: 'add a customer called Dana Brook, email dana@brook.test' });
  assert.equal(handed.headers.location, '/sales/customers/new?name=Dana+Brook&email=dana%40brook.test');
  const form = await agent.get(handed.headers.location);
  assert.equal(form.status, 200);
  // Pressing Save lands on the chat, not on the customer's record.
  const saved = await agent.post('/sales/customers').type('form').send({ _csrf: csrfFrom(form.text), name: 'Dana Brook', email: 'dana@brook.test' });
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.location, '/ask');
  const customer = db.prepare("SELECT id FROM customers WHERE name = 'Dana Brook'").get();
  assert.ok(customer, 'the customer was saved');
  const goal = db.prepare('SELECT status, said, result_href FROM assistant_goals ORDER BY rowid DESC LIMIT 1').get();
  assert.equal(goal.status, 'done');
  assert.match(goal.said, /Dana Brook is ready/);
  assert.equal(goal.result_href, `/sales/customers/${customer.id}`);
  const back = await agent.get('/ask');
  assert.match(back.text, /Dana Brook is ready/);
  assert.match(back.text, /rm-turn--latest/);
  // A validation error keeps you on the form; walking off to another page forgets the handoff.
  const again = await agent.post('/foundry/tell').type('form').send({ _csrf: csrf, queryConversation: '1', message: 'add a customer called Lee' });
  const form2 = await agent.get(again.headers.location);
  const bad = await agent.post('/sales/customers').type('form').send({ _csrf: csrfFrom(form2.text), name: '' });
  assert.notEqual(bad.headers.location, '/ask');
  await agent.get('/inventory');
  const form3 = await agent.get('/sales/customers/new');
  const later = await agent.post('/sales/customers').type('form').send({ _csrf: csrfFrom(form3.text), name: 'Lee' });
  assert.match(later.headers.location, /^\/sales\/customers\/[A-Za-z0-9_-]+$/, 'no handoff in flight: the form goes to the record as usual');
});
