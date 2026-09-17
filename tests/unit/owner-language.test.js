'use strict';

/**
 * Sentences a normal owner types, each in several wordings, read in code.
 *
 * Every group here began as a live-provider scenario that failed: the model
 * returned no lines for a supplier message, an empty name for a new
 * location, "unsupported" for a selling-price question, a stock action for
 * an automation control, an invented location for a business that named
 * none. Each is now read deterministically before a model is consulted, and
 * the assertion is on the meaning — not on one phrase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const intentService = require('../../src/actions/intent-service');
const queryPlanner = require('../../src/attention/query-planner');
const outbound = require('../../src/actions/outbound-message');
const supplierService = require('../../src/purchasing/supplier-service');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const { makeDatabase, seedWorkspace, makeVariantItem, makeQuantityItem, cleanupAll } = require('../helpers');

test.after(cleanupAll);

const context = { locationNames: ['Main Warehouse', 'Downtown Store'], itemNames: ["Children's Sweater", 'Copper Elbow'] };

function read(sentence) {
  const intent = intentService.deterministicInstruction(sentence, context);
  assert.ok(intent, `"${sentence}" should be read in code`);
  return intent;
}

// Live failure: "Email the supplier about the delay" → no lines, "which supplier?"
test('a message to a supplier or customer is understood as a message, whoever it names', () => {
  for (const sentence of [
    'Email the supplier about the delay',
    'email our supplier regarding the late delivery',
    'Chase ABC Footwear about the order',
    'write to Acme re: the missing invoice',
    'Contact the vendor about PO-1001',
    'Send an email to Lakeside Textiles about the damaged sweaters',
    'remind the customer about the unpaid invoice',
  ]) {
    const intent = read(sentence);
    assert.equal(intent.lines.length, 1, sentence);
    assert.equal(intent.lines[0].actionType, 'send_message', sentence);
    assert.equal(intent.unsupportedReason, '', sentence);
    assert.equal(intent.lines[0].messageBody, '', `"${sentence}" gives a topic, not the words — those are composed and shown`);
  }
  const named = read('Chase ABC Footwear about the order');
  assert.equal(named.lines[0].recipient, 'ABC Footwear');
  const role = read('Email the supplier about the delay');
  assert.equal(role.lines[0].recipient, 'supplier');
  // Said in their own words, the words are kept verbatim.
  const literal = read('tell Acme that the shipment is delayed until Friday');
  assert.equal(literal.lines[0].recipient, 'Acme');
  assert.equal(literal.lines[0].messageBody, 'the shipment is delayed until Friday');
  // Not a message: a stock instruction with "to" in it.
  assert.equal(intentService.deterministicInstruction('tell me what we have in the warehouse', context)?.lines?.[0]?.actionType === 'send_message', false);
});

test('"the supplier" with one supplier on file is that supplier; with several it is a question with choices', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply', email: 'orders@acme.test' });
  const one = outbound.prepare(db, w.ctx, { recipientText: 'supplier', body: 'the order is late', instruction: 'email the supplier that the order is late' });
  assert.notEqual(one.kind, 'question', JSON.stringify(one));
  supplierService.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles', email: 'orders@lakeside.test' });
  const two = outbound.prepare(db, w.ctx, { recipientText: 'supplier', body: 'the order is late', instruction: 'email the supplier that the order is late' });
  assert.equal(two.kind, 'question');
  assert.match(two.question, /which supplier/i);
  assert.deepEqual(two.choices.map((c) => c.label).sort(), ['Acme Trade Supply', 'Lakeside Textiles']);
  assert.equal(two.reason, 'ambiguous');
  // No suppliers at all is not ambiguous: it is missing, and says where to add one.
  const { db: db2 } = makeDatabase();
  const w2 = seedWorkspace(db2);
  const none = outbound.prepare(db2, w2.ctx, { recipientText: 'supplier', body: 'hello', instruction: 'email the supplier that hello' });
  assert.equal(none.kind, 'question');
  assert.equal(none.reason, 'missing');
  assert.match(none.question, /no suppliers? on file/i);
});

// Live failure: the plain movement shape went to the model when only a variant was named.
test('a plain movement that names a variant, not a product, is read in code and resolved against the catalogue', () => {
  for (const sentence of [
    'Move 15 Navy 4 from Main Warehouse to Downtown Store',
    'transfer 15 navy 4 from the main warehouse to the downtown store',
    'please move 15 Navy / 4 from Main Warehouse into Downtown Store',
    'Take 3 Navy 4 out of Downtown Store',
  ]) {
    const intent = read(sentence);
    assert.equal(intent.lines.length, 1, sentence);
    assert.ok(['transfer', 'issue'].includes(intent.lines[0].actionType), sentence);
    assert.match(intent.lines[0].item, /navy/i, sentence);
    assert.equal(intent.lines[0].quantity, intent.lines[0].actionType === 'transfer' ? 15 : 3, sentence);
  }
  // Still not read in code: a place StockChief does not have, or "all of them".
  assert.equal(intentService.deterministicInstruction('Move 15 Navy 4 from Main Warehouse to the Van', context), null);
  assert.equal(intentService.deterministicInstruction('Move all of them from Main Warehouse to Downtown Store', context), null);
});

test('the variant-only movement becomes the right proposal, with the figures the preview promised', async () => {
  const actionService = require('../../src/actions/action-service');
  const repo = require('../../src/domain/repository');
  const { db } = makeDatabase();
  const w = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const item = makeVariantItem(db, w.ctx);
  const navy4 = item.byLabel('Navy / 4');
  engine.receive(db, w.ctx, { skuId: navy4.id, locationId: w.store.id, quantity: 4 });
  engine.receive(db, w.ctx, { skuId: navy4.id, locationId: w.main.id, quantity: 48 });
  const result = await actionService.interpret(db, w.ctx, membership, 'Move 15 Navy 4 from Main Warehouse to Downtown Store', { provider: { async complete() { throw new Error('no model needed'); } } });
  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.equal(result.proposal.skuId, navy4.id);
  assert.equal(result.proposal.expectedBeforeState.sourceOnHand, 48);
  assert.equal(result.proposal.expectedAfterState.sourceOnHand, 33);
  assert.equal(result.proposal.expectedAfterState.destinationOnHand, 19);
  assert.equal(repo.getBalance(db, w.workspaceId, navy4.id, w.main.id), 48, 'nothing moved');
  // Words that fit nothing are a question that says so — never a pick.
  const nothing = await actionService.interpret(db, w.ctx, membership, 'Move 2 Purple 9 from Main Warehouse to Downtown Store', { provider: { async complete() { throw new Error('no model needed'); } } });
  assert.equal(nothing.kind, 'question', JSON.stringify(nothing));
  assert.match(nothing.question, /purple 9/i);
});

// Live failure: add_location with an empty name.
test('a new place and a new word for things are configuration, read in code', () => {
  for (const [sentence, name] of [
    ['Add a location called Service Van 3', 'Service Van 3'],
    ['create a new warehouse named North Depot', 'North Depot'],
    ['set up a store called "Harbour Front"', 'Harbour Front'],
    ['please open a new location Eastside Shop', 'Eastside Shop'],
  ]) {
    const intent = read(sentence);
    assert.equal(intent.lines[0].actionType, 'add_location', sentence);
    assert.equal(intent.lines[0].destinationLocation, name, sentence);
  }
  for (const [sentence, key, value] of [
    ['Call our items Products instead', 'item', 'Products'],
    ['call our locations Branches', 'location', 'Branches'],
    ['rename items to styles', 'item', 'styles'],
    ['refer to our lots as batches from now on', 'lot', 'batches'],
  ]) {
    const intent = read(sentence);
    assert.equal(intent.lines[0].actionType, 'rename_terminology', sentence);
    assert.equal(intent.lines[0].terminologyKey, key, sentence);
    assert.equal(intent.lines[0].terminologyValue, value, sentence);
  }
  // "Add a location for the overflow stock" names nothing; it is not read here.
  assert.equal(intentService.deterministicInstruction('add a location for the overflow stock', context), null);
});

// Live failures: "What do we charge for these?" → unsupported; "Stop moving stock around by yourself" → action.
test('what we charge, what demand will be, and "stop acting on your own" each have one reading', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 10 });
  const plan = (q) => queryPlanner.__directPlan(db, w.workspaceId, q);
  for (const q of ['What do we charge for these?', 'what do we charge for copper elbow', 'How much do we sell copper elbows for?', "What's the selling price of copper elbow?", 'what are we charging for the elbows']) {
    const p = plan(q);
    assert.ok(p, `"${q}" should be read in code`);
    assert.equal(p.intent, 'selling_price', q);
  }
  for (const q of ['Stop moving stock around by yourself', 'stop doing things on your own', "don't order anything automatically", 'pause the autopilot', 'turn off automation please', 'no more transfers without asking me']) {
    const p = plan(q);
    assert.ok(p, `"${q}" should be read in code`);
    assert.equal(p.intent, 'stop_automation', q);
  }
  for (const q of ['What will demand be next quarter?', 'forecast demand for next month', 'how many will we sell next week?', 'what is the demand forecast']) {
    const p = plan(q);
    assert.ok(p, `"${q}" should be read in code`);
    assert.equal(p.intent, 'demand_forecast', q);
  }
  // Not any of those: a cost question, a how-to, a product-scoped forecast (the model reads the product).
  assert.notEqual((plan('What did we pay our supplier for these?') || {}).intent, 'selling_price');
  assert.equal(plan('how do I stop the autopilot?'), null);
  assert.equal(plan('what will copper elbow demand be next month'), null);
});

// Live failure: a "Refrigerated warehouse" for a description that names no place.
test('onboarding keeps only the places the owner named', () => {
  const { __locationIsNamedIn: named } = require('../../src/foundry/understanding-service');
  const clothing = 'We are a clothing wholesaler with a warehouse in Brooklyn and a store in New Jersey.';
  const food = 'We distribute refrigerated food. We need to know which batch inventory came from and when each batch expires.';
  const vans = 'Plumbing supplies: one main warehouse and stock on two vans.';
  assert.equal(named('Brooklyn Warehouse', clothing), true);
  assert.equal(named('New Jersey Store', clothing), true);
  assert.equal(named('Refrigerated warehouse', food), false);
  assert.equal(named('Main Warehouse', food), false);
  assert.equal(named('Main Warehouse', vans), true);
  assert.equal(named('Van 1', vans), false, 'a count of vans is not a name');
});

// Live finding: "StockChief transferred 15 …" on a page whose body said nothing physically moved.
test('an executed transfer is reported as a prepared transfer, never as stock that moved', async () => {
  const actionService = require('../../src/actions/action-service');
  const execution = require('../../src/actions/execution-service');
  const presenter = require('../../src/actions/presenter');
  const repo = require('../../src/domain/repository');
  const { db } = makeDatabase();
  const w = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const navy4 = makeVariantItem(db, w.ctx).byLabel('Navy / 4');
  engine.receive(db, w.ctx, { skuId: navy4.id, locationId: w.main.id, quantity: 48 });
  const result = await actionService.interpret(db, w.ctx, membership, 'Move 15 Navy 4 from Main Warehouse to Downtown Store', { provider: { async complete() { throw new Error('no model needed'); } } });
  execution.approve(db, w.ctx, membership, result.proposal.proposalId);
  const done = execution.execute(db, w.ctx, membership, result.proposal.proposalId);
  assert.equal(done.verified, true);
  assert.equal(done.transferStatus, 'APPROVED');
  assert.equal(repo.getBalance(db, w.workspaceId, navy4.id, w.main.id), 48, 'the shelves are untouched until the warehouse ships and receives');
  const shown = presenter.present(db, w.workspaceId, done.proposal);
  assert.match(shown.pastVerb, /prepared a transfer/);
  assert.doesNotMatch(shown.pastVerb, /transferred/);
});

test('"how many X do we have" and "what did we pay for X" are the two plainest questions, read in code', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const plan = (q) => queryPlanner.__directPlan(db, w.workspaceId, q);
  for (const [q, entity] of [['How many Navy 4 do we have?', 'Navy 4'], ['how many copper elbows are there', 'copper elbows'], ['how many gloves have we got in stock', 'gloves'], ['How much rope is on hand?', 'rope']]) {
    const p = plan(q);
    assert.ok(p, q);
    assert.equal(p.intent, 'stock_level', q);
    assert.equal(p.entityQuery, entity, q);
  }
  const placed = plan('how many navy 4 do we have at Main Warehouse');
  assert.equal(placed.intent, 'stock_level');
  assert.equal(placed.entityQuery, 'navy 4');
  assert.equal(placed.locationQuery, 'Main Warehouse');
  for (const [q, entity] of [['What did we pay our supplier for these?', ''], ['what did we last pay for copper elbow', 'copper elbow'], ["what's the last cost of navy 4", 'navy 4'], ['how much did the gloves cost us?', 'gloves']]) {
    const p = plan(q);
    assert.ok(p, q);
    assert.equal(p.intent, 'last_cost', q);
    assert.equal(p.entityQuery, entity, q);
  }
  // Not those: counts of records, money owed, sales.
  assert.notEqual((plan('how many orders do we have') || {}).intent, 'stock_level');
  assert.notEqual((plan('how many products do we have') || {}).intent, 'stock_level');
  assert.notEqual((plan('what did we pay in total last month') || {}).intent, 'last_cost');
});

// Live flake: "What has been selling most this month?" → action, once.
test('what sells most is the busiest lines, read in code', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const plan = (q) => queryPlanner.__directPlan(db, w.workspaceId, q);
  for (const q of ['What has been selling most this month?', 'which products are our best sellers', 'what sells best this week', 'Show me the top movers this quarter', 'what is the most popular product']) {
    const p = plan(q);
    assert.ok(p, q);
    assert.equal(p.intent, 'top_moving', q);
  }
  assert.equal(plan('Show me the top movers this quarter').windowDays, 90);
  assert.notEqual((plan('which customers buy the most') || {}).intent, 'top_moving');
});
