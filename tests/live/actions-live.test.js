'use strict';

/**
 * Natural-language actions against a real model.
 *
 * What can only be tested live is whether a real sentence becomes the *right*
 * typed action — and, just as importantly, whether the model refuses to choose
 * when choosing would falsify someone's history. Issuing stock and correcting a
 * count are different claims about the world; guessing between them is worse
 * than asking.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../src/config');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const authService = require('../../src/domain/auth-service');
const intentService = require('../../src/actions/intent-service');
const actionService = require('../../src/actions/action-service');
const execution = require('../../src/actions/execution-service');
const { makeDatabase, cleanupAll, seedWorkspace, makeVariantItem, makeSerialItem, makeLotItem } = require('../helpers');

const LIVE = config.ai.configured;
const TIMEOUT = 600000;

test.after(cleanupAll);

function clothing() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Clothing Business' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeVariantItem(db, workspace.ctx);
  const navy4 = item.byLabel('Navy / 4');
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.store.id, quantity: 4 });
  engine.receive(db, workspace.ctx, { skuId: navy4.id, locationId: workspace.main.id, quantity: 48 });
  return { db, workspace, membership, ctx: workspace.ctx, navy4, item };
}

const context = { locationNames: ['Main Warehouse', 'Downtown Store'] };

test('a plain transfer instruction is read correctly', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    'Move 15 Navy 4 sweaters from Main Warehouse to Downtown Store',
    { context }
  );
  assert.equal(intent.lines.length, 1);
  const [line] = intent.lines;
  assert.equal(line.actionType, 'transfer');
  assert.equal(line.quantity, 15);
  assert.match(line.sourceLocation, /Main Warehouse/i);
  assert.match(line.destinationLocation, /Downtown Store/i);
  assert.match(line.variant, /navy/i);
});

test('a receive instruction is read correctly', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    'Receive 100 Copper Elbows into Main Warehouse',
    { context }
  );
  const [line] = intent.lines;
  assert.equal(line.actionType, 'receive');
  assert.equal(line.quantity, 100);
  assert.match(line.item, /copper elbow/i);
  assert.match(line.destinationLocation, /Main Warehouse/i);
});

test('a correction is read as a target, not a quantity', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    'Set Downtown Store Navy 4 to 37 after the physical count',
    { context }
  );
  const [line] = intent.lines;
  assert.equal(line.actionType, 'adjust');
  assert.equal(line.adjustmentTarget, 37, 'the count it should read afterwards');
  assert.equal(line.reasonCode, 'physical_count');
});

test('an instruction naming two products becomes two lines', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    'Move 10 Navy 4 and 8 Navy 5 from Main Warehouse to Downtown Store',
    { context }
  );
  assert.equal(intent.lines.length, 2, `expected two lines, got ${JSON.stringify(intent.lines)}`);
  assert.deepEqual(intent.lines.map((l) => l.quantity).sort((a, b) => a - b), [8, 10]);
  for (const line of intent.lines) assert.equal(line.actionType, 'transfer');
});

test('a genuinely ambiguous removal is asked about, not guessed', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  // "take 4 off" could be stock leaving, or a count that was wrong. The two
  // record different things happened, so guessing falsifies the history.
  const intent = await intentService.readInstruction('Take 4 off Downtown Store', { context });
  const kinds = intent.lines.map((l) => l.actionType);
  assert.ok(
    intent.clarifyingQuestion || kinds.includes('clarify'),
    `expected a question, got ${JSON.stringify(intent)}`
  );
});

test('an unclear correction never gets an invented reason', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction('Change Downtown Store Navy 4 to 12', { context });
  const [line] = intent.lines;
  if (line && line.actionType === 'adjust') {
    assert.equal(line.reasonCode, '', 'no reason was given, so none may be recorded');
  }
});

test('things Foundry cannot do are refused rather than approximated', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  // Buying moved inside the product in Mission 6, so it is no longer on this
  // list. What remains is what Foundry still genuinely does not do: contacting
  // anyone, standing rules that act without a person, and accounting.
  const outside = [
    'Email the supplier about the delay',
    'Set up automatic reordering so it just happens without me',
    'Post this delivery to the general ledger',
    'Raise an invoice for the customer',
  ];
  for (const instruction of outside) {
    const intent = await intentService.readInstruction(instruction, { context });
    const usable = intent.lines.filter((l) => !['clarify', 'unsupported'].includes(l.actionType));
    assert.equal(usable.length, 0, `"${instruction}" produced ${JSON.stringify(intent.lines)}`);
    assert.ok(intent.unsupportedReason || intent.clarifyingQuestion, `"${instruction}" said nothing`);
  }
});

test('buying is understood now, and is still only ever a proposal', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  // Fully specified: this has to be read as a purchase.
  const named = await intentService.readInstruction('Order 500 more Navy 4 from our supplier', { context });
  const purchase = named.lines.find((line) => line.actionType === 'purchase');
  assert.ok(purchase, `produced ${JSON.stringify(named.lines)}`);
  assert.equal(purchase.quantity, 500);

  // "Raise a purchase order for the shortfall" names no product, so asking
  // which one is as good an answer as proposing one — and better than picking.
  const vague = await intentService.readInstruction('Raise a purchase order for the shortfall', { context });
  const kinds = vague.lines.map((line) => line.actionType);
  assert.ok(
    kinds.includes('purchase') || kinds.includes('clarify') || vague.clarifyingQuestion,
    `produced ${JSON.stringify(vague.lines)}`
  );
  assert.ok(!kinds.includes('unsupported'), 'buying is not unsupported any more');
});

test('a real instruction becomes a correct, unexecuted proposal', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = clothing();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership,
    'Move 15 Navy 4 from Main Warehouse to Downtown Store'
  );

  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  const proposal = result.proposal;
  assert.equal(proposal.actionType, 'transfer');
  assert.equal(proposal.quantity, 15);
  assert.equal(proposal.skuId, env.navy4.id);
  assert.equal(proposal.sourceLocationId, env.workspace.main.id);
  assert.equal(proposal.destinationLocationId, env.workspace.store.id);
  assert.equal(proposal.expectedBeforeState.sourceOnHand, 48);
  assert.equal(proposal.expectedAfterState.sourceOnHand, 33);
  assert.equal(proposal.status, 'AWAITING_APPROVAL');

  // And nothing has moved.
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 48);

  // Approving it does exactly what the preview said.
  execution.approve(env.db, env.ctx, env.membership, proposal.proposalId);
  const done = execution.execute(env.db, env.ctx, env.membership, proposal.proposalId);
  assert.equal(done.verified, true, JSON.stringify(done.verification.problems));
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.main.id), 33);
  assert.equal(repo.getBalance(env.db, env.workspace.workspaceId, env.navy4.id, env.workspace.store.id), 19);
});

test('a serialized instruction resolves the exact unit', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeSerialItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId,
    locationId: workspace.main.id,
    serials: [{ serial: 'DL-829193' }, { serial: 'DL-829194' }],
  });

  const result = await actionService.interpret(
    db, workspace.ctx, membership,
    'Move laptop DL-829193 to Downtown Store',
    { context: { locationNames: ['Main Warehouse', 'Downtown Store'] } }
  );
  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.equal(result.proposal.serialUnitIds.length, 1);
  assert.equal(result.proposal.quantity, 1);

  const unit = db.prepare('SELECT serial FROM serial_units WHERE id = ?').get(result.proposal.serialUnitIds[0]);
  assert.equal(unit.serial, 'DL-829193');
});

test('a lot instruction moves that lot, not generic stock', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const item = makeLotItem(db, workspace.ctx);
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 84, lotCode: 'L240812' });
  engine.receive(db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 120, lotCode: 'L240902' });

  const result = await actionService.interpret(
    db, workspace.ctx, membership,
    'Transfer 20 units from Lot L240812 to Downtown Store',
    { context: { locationNames: ['Main Warehouse', 'Downtown Store'] } }
  );
  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.ok(result.proposal.lotId, 'the lot was resolved');
  const lot = db.prepare('SELECT code FROM lots WHERE id = ?').get(result.proposal.lotId);
  assert.equal(lot.code, 'L240812');
  assert.equal(result.proposal.quantity, 20);
});

test('an instruction naming a product that does not exist says so', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = clothing();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership,
    'Move 5 jetpacks from Main Warehouse to Downtown Store'
  );
  assert.ok(['question', 'unsupported'].includes(result.kind), JSON.stringify(result));
  assert.match(result.question || result.message, /jetpack|nothing called/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
});

test('naming only the product, when it has versions, asks which', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = clothing();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership,
    "Move 5 Children's Sweaters from Main Warehouse to Downtown Store"
  );
  assert.equal(result.kind, 'question', JSON.stringify(result));
  assert.match(result.question, /versions|which/i);
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get().n, 0);
});

test('the two configuration actions can be asked for in words', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const location = await intentService.readInstruction('Add a location called Service Van 3', { context });
  assert.equal(location.lines[0].actionType, 'add_location');
  assert.match(location.lines[0].destinationLocation, /Service Van 3/i);

  const wording = await intentService.readInstruction('Call our items Products instead', { context });
  assert.equal(wording.lines[0].actionType, 'rename_terminology');
  assert.equal(wording.lines[0].terminologyKey, 'item');
  assert.match(wording.lines[0].terminologyValue, /product/i);
});

/**
 * Creating a product is real work now, so it goes through the same gate as
 * moving stock: proposed, previewed, and not existing until someone approves.
 * The assertion that matters is the second one.
 */
test('creating a product is proposed, not done', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const env = clothing();
  const result = await actionService.interpret(
    env.db, env.ctx, env.membership, 'Add a new item called Brass Fitting'
  );
  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.equal(result.proposal.actionType, 'create_item');
  assert.equal(result.proposal.settings.name, 'Brass Fitting');
  assert.equal(result.proposal.status, 'AWAITING_APPROVAL');
  assert.equal(env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE name = ?').get('Brass Fitting').n, 0);
});

/**
 * The two boxes look identical to a person, so both must recognise what they
 * have been handed. Getting this wrong is not a small annoyance: it tells
 * someone Foundry cannot do a thing it can do.
 */
test('the question box recognises an instruction as work', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const queryPlanner = require('../../src/attention/query-planner');
  const env = clothing();

  const instructions = [
    'Move banana in Mornoe Location',
    'Move 10 Navy 4 from Main Warehouse to Downtown Store',
    'Receive 50 Navy 4 into Downtown Store',
    'Remove 3 damaged Navy 4 from Downtown Store',
    'Set Downtown Store Navy 4 to 12',
    'transfer everything from Main Warehouse to Downtown Store',
  ];
  for (const instruction of instructions) {
    const result = await queryPlanner.ask(env.db, env.workspace.workspaceId, instruction, {});
    assert.equal(result.plan.intent, 'action', `"${instruction}" → ${result.plan.intent}`);
    assert.equal(result.isAction, true);
    assert.ok(!/cannot move|cannot transfer/i.test(result.answer), `"${instruction}" claimed it cannot`);
  }
});

test('the question box still answers actual questions', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const queryPlanner = require('../../src/attention/query-planner');
  const env = clothing();

  const questions = [
    ['How many Navy 4 do we have?', ['stock_level', 'stock_by_location']],
    ['Where is our Navy 4?', ['stock_by_location', 'stock_level']],
    ['What needs my attention?', ['attention_summary']],
    // "What moved" reasonably means either the log or the busiest lines.
    ['What moved last week?', ['movement_history', 'top_moving']],
  ];
  for (const [question, expected] of questions) {
    const result = await queryPlanner.ask(env.db, env.workspace.workspaceId, question, {});
    assert.ok(expected.includes(result.plan.intent), `"${question}" → ${result.plan.intent}`);
    assert.equal(result.isAction, false);
  }
});

test('things Foundry truly cannot do stay refused, not handed over', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const queryPlanner = require('../../src/attention/query-planner');
  const env = clothing();

  // Still outside the product: forecasting beyond current usage and anything
  // that would contact a supplier without going through purchasing authority.
  for (const question of [
    'What will demand be next quarter?',
    'Email ABC Footwear and chase the order',
  ]) {
    const result = await queryPlanner.ask(env.db, env.workspace.workspaceId, question, {});
    assert.equal(result.plan.intent, 'unsupported', `"${question}" → ${result.plan.intent}`);
    assert.equal(result.isAction, false, `"${question}" must not be offered as an action`);
  }

  // Mission 12 added current selling-price records. Asking what is already
  // configured is supported; Foundry still does not invent a recommended price.
  const price = await queryPlanner.ask(env.db, env.workspace.workspaceId, 'What do we charge for these?', {});
  assert.equal(price.plan.intent, 'selling_price');
  assert.equal(price.isAction, false);

  // Inside it since Mission 6: what something cost, and what to buy.
  const cost = await queryPlanner.ask(env.db, env.workspace.workspaceId, 'What did we pay our supplier for these?', {});
  assert.equal(cost.plan.intent, 'last_cost', `cost question → ${cost.plan.intent}`);

  const order = await queryPlanner.ask(env.db, env.workspace.workspaceId, 'Order 200 more Navy 4', {});
  assert.ok(
    ['action', 'replenishment'].includes(order.plan.intent),
    `an instruction to order should be handed over or planned, not refused — got ${order.plan.intent}`
  );
});

test('a misspelled instruction still lands on the right records', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Grocer' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  const locationService = require('../../src/domain/location-service');
  const monroe = locationService.createLocation(db, workspace.ctx, { name: 'Mornoe', kind: 'store' });

  const itemService = require('../../src/domain/item-service');
  const repo2 = require('../../src/domain/repository');
  const created = itemService.createItem(db, workspace.ctx, {
    name: 'banana', baseCode: 'BAN-1', trackingMode: 'quantity',
  });
  const sku = repo2.listSkusForItem(db, workspace.workspaceId, created.itemId)[0];
  engine.receive(db, workspace.ctx, { skuId: sku.id, locationId: workspace.main.id, quantity: 10 });

  const result = await actionService.interpret(
    db, workspace.ctx, membership,
    'move 3 bannana to monroe',
    { context: { locationNames: ['Main Warehouse', 'Downtown Store', 'Mornoe'] } }
  );

  assert.equal(result.kind, 'proposal', JSON.stringify(result));
  assert.equal(result.proposal.skuId, sku.id);
  assert.equal(result.proposal.destinationLocationId, monroe.id);
  assert.equal(result.proposal.quantity, 3);
});

/**
 * Conversational catalogue creation. The interesting property is that Foundry
 * does not ask how the business tracks stock — Mission 2 answered that once.
 */
test('a described product becomes the right variants', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    "Create Children's Oxford in Navy and Black, sizes 6 through 12",
    { context }
  );
  const [line] = intent.lines;
  assert.equal(line.actionType, 'create_item', JSON.stringify(intent));
  assert.match(line.productName, /Children'?s Oxford/i);
  // The range is passed through, not enumerated by the model.
  assert.match(line.variantAxes, /6\s*(?:-|–|to|through|thru)\s*12/i);
  assert.match(line.variantAxes, /navy/i);
  assert.match(line.variantAxes, /black/i);
});

test('a plain product needs no interrogation about tracking', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction('Create Copper Elbow, SKU CE-100', { context });
  const [line] = intent.lines;
  assert.equal(line.actionType, 'create_item');
  assert.match(line.productName, /copper elbow/i);
  assert.match(line.productCode, /CE-100/i);
});

test('several products in one sentence become several lines', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const intent = await intentService.readInstruction(
    'Create: Copper Elbow CE-100, Copper Tee CT-200, Copper Pipe CP-300',
    { context }
  );
  assert.equal(intent.lines.length, 3, JSON.stringify(intent.lines));
  for (const line of intent.lines) assert.equal(line.actionType, 'create_item');
  assert.deepEqual(
    intent.lines.map((l) => l.productCode.toUpperCase()).sort(),
    ['CE-100', 'CP-300', 'CT-200']
  );
});
