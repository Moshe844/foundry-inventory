'use strict';

/**
 * The assistant does what was asked, all of it, or says plainly what it did
 * not do.
 *
 * Every test here is a way the assistant used to be quietly wrong: a
 * twenty-one-line list approved as one line, a pending question swallowing
 * the next unrelated message, an exact SKU answered with four positions, a
 * neighbouring lookup answered instead of the one asked, and a two-product
 * order drafted for one product.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../../src/app');
const engine = require('../../src/domain/inventory-engine');
const authService = require('../../src/domain/auth-service');
const intentService = require('../../src/actions/intent-service');
const actionService = require('../../src/actions/action-service');
const semantic = require('../../src/attention/semantic-query');
const queryService = require('../../src/attention/query-service');
const { ProviderOutputError, ProviderError } = require('../../src/ai/provider');
const { makeDatabase, seedWorkspace, makeQuantityItem, makeVariantItem, cleanupAll, signIn, csrfFrom, plain } = require('../helpers');

test.after(cleanupAll);

const CONTEXT = {
  itemNames: ['Copper Elbow 1/2 in.', 'Trail Ration Pack', 'Solder Wire 500g', "Children's Sweater", 'Harbour Work Glove'],
  locationNames: ['Main Warehouse', 'Downtown Store', 'Service Van 3'],
};
const neverCalled = { async complete() { throw new Error('the model must not be consulted for this'); } };

test('a numbered list of plain movements is read in full without a model', async () => {
  const list = 'Please do all of the following: '
    + '1) move 2 Copper Elbow 1/2 in. from Main Warehouse to Downtown Store; '
    + '2) move 1 Copper Elbow 1/2 in. from Main Warehouse to Service Van 3; '
    + '3) move 3 Trail Ration Pack from Main Warehouse to Downtown Store; '
    + '4) move 4 Harbour Work Glove Tan M from Main Warehouse to Downtown Store; '
    + "5) move 2 Children's Sweater Navy 5 from Main Warehouse to Downtown Store; "
    + '6) issue 1 Solder Wire 500g from Downtown Store as sold.';
  const intent = await intentService.readInstruction(list, { context: CONTEXT, provider: neverCalled });
  assert.equal(intent.lines.length, 6);
  assert.deepEqual(intent.lines.map((line) => line.actionType), ['transfer', 'transfer', 'transfer', 'transfer', 'transfer', 'issue']);
  assert.equal(intent.lines[3].item, 'Harbour Work Glove');
  assert.equal(intent.lines[3].variant, 'Tan M');
  assert.equal(intent.lines[4].variant, 'Navy 5');
  assert.equal(intent.lines[5].sourceLocation, 'Downtown Store');
  assert.equal(intent.lines[5].reasonCode, 'sold');
  assert.equal(intent.clarifyingQuestion, '');
});

test('a single transfer written with "units of" is read without a model', async () => {
  const intent = await intentService.readInstruction(
    'Transfer 20 units of Copper Elbow 1/2 in. from Main Warehouse to Downtown Store.', { context: CONTEXT, provider: neverCalled }
  );
  assert.equal(intent.lines.length, 1);
  assert.equal(intent.lines[0].actionType, 'transfer');
  assert.equal(intent.lines[0].quantity, 20);
  assert.equal(intent.lines[0].item, 'Copper Elbow 1/2 in.');
  assert.equal(intent.lines[0].destinationLocation, 'Downtown Store');
});

test('a clause naming a place this inventory does not have goes to the model, never half-read', () => {
  assert.equal(intentService.deterministicMovementList(
    '1) move 2 Copper Elbow 1/2 in. from Main Warehouse to Downtown Store; 2) move 1 Trail Ration Pack from Main Warehouse to the Moon', CONTEXT
  ), null);
});

test('fewer lines back than changes listed becomes a question, not a partial plan', async () => {
  const line = {
    actionType: 'transfer', item: 'Widget', variant: '', sourceText: 'move 2 Widget from Main Warehouse to Downtown Store',
    lotCode: '', serials: [], sourceLocation: 'Main Warehouse', destinationLocation: 'Downtown Store', quantity: 2, adjustmentTarget: -1,
    reasonCode: '', terminologyKey: '', terminologyValue: '', productName: '', productCode: '', variantAxes: '', unitLabel: '',
    kitComponents: [], supplier: '', purchaseUnit: '', amount: -1, reference: '', recipient: '', messageBody: '',
  };
  const provider = { async complete() { return { data: { lines: [line], clarifyingQuestion: '', unsupportedReason: '' } }; } };
  const intent = await intentService.readInstruction(
    '1) move 2 Widget from Main Warehouse to Downtown Store; 2) move 1 Gadget from Main Warehouse to Downtown Store; 3) move 5 Gizmo from Downtown Store to Main Warehouse',
    { context: CONTEXT, provider }
  );
  assert.equal(intent.lines.length, 0, 'nothing is prepared from a list that was only partly read');
  assert.match(intent.clarifyingQuestion, /lists 3 changes and StockChief could only read 1/);
  assert.match(intent.clarifyingQuestion, /did not read: “move 1 Gadget/);
});

test('the reader fails in plain words and never in provider vocabulary', async () => {
  const outOfRoom = { async complete() { throw new ProviderOutputError('The model ran out of room before finishing its answer.'); } };
  await assert.rejects(
    intentService.readInstruction('Move some gadgets around please', { context: CONTEXT, provider: outOfRoom }),
    (err) => err.status === 400 && /could not read that instruction all the way through\. Nothing changed/.test(err.message)
  );
  const offline = { async complete() { throw new ProviderError('ECONNRESET', { code: 'ai_provider_error' }); } };
  await assert.rejects(
    intentService.readInstruction('Move some gadgets around please', { context: CONTEXT, provider: offline }),
    (err) => err.status === 400 && /could not reach its reading service/.test(err.message)
  );
  const hangs = { complete(requestSent) { return new Promise((_, reject) => { requestSent.signal.addEventListener('abort', () => reject(new Error('aborted'))); }); } };
  await assert.rejects(
    intentService.readInstruction('Move some gadgets around please', { context: CONTEXT, provider: hangs, readTimeoutMs: 40 }),
    (err) => err.status === 400 && /took too long to read that and stopped\. Nothing changed/.test(err.message)
  );
});

test('an order naming two products is refused whole and pointed at the order form', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  makeQuantityItem(db, w.ctx, { name: 'Trail Ration Pack', baseCode: 'TRP' });
  const purchase = (item, quantity) => intentService.normaliseLine({
    actionType: 'purchase', item, variant: '', quantity, sourceLocation: '', destinationLocation: '',
    supplier: 'Acme Trade Supply', purchaseUnit: '', adjustmentTarget: -1, reasonCode: '',
  });
  const result = await actionService.interpret(db, w.ctx, membership,
    'Create a PO for 12 Copper Elbow and 6 Trail Ration Pack from Acme Trade Supply.',
    { parsedIntent: { lines: [purchase('Copper Elbow', 12), purchase('Trail Ration Pack', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'unsupported');
  assert.match(result.message, /names 2 products \(12 Copper Elbow; 6 Trail Ration Pack\) from Acme Trade Supply/);
  assert.match(result.message, /prepared nothing rather than order only the first/);
  assert.equal(result.where.href, '/purchasing/orders/new');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0, 'no order is drafted for the first product alone');
});

test('a product named exactly is that product, even when its name is inside another name', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const wanted = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow 1/2 in.', baseCode: 'CE-HALF' });
  makeQuantityItem(db, w.ctx, { name: '1/2in Copper Elbow', baseCode: 'CE-ALT' });
  const exact = queryService.resolveSkus(db, w.workspaceId, 'Copper Elbow 1/2 in.', 25);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].id, wanted.skuId);
  const byCode = queryService.resolveSkus(db, w.workspaceId, 'ce-alt', 25);
  assert.equal(byCode.length, 1);
  assert.equal(byCode[0].code, 'CE-ALT');
  assert.equal(queryService.resolveSkus(db, w.workspaceId, 'Copper Elbow', 25).length, 2, 'a partial name still finds both');
});

function part(overrides) {
  return { question: 'q', intent: 'record_query', entityQuery: '', locationQuery: '', windowDays: 30, limit: 10, unsupportedReason: '', recordQuery: null, ...overrides };
}

test('a lookup must keep the exact code and the place the question named', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const item = makeVariantItem(db, w.ctx);
  const navy5 = item.byLabel('Navy / 5');
  engine.receive(db, w.ctx, { skuId: navy5.id, locationId: w.main.id, quantity: 9 });
  const code = navy5.code;
  const question = `How many units of ${code} are available at Main Warehouse?`;
  const loose = part({ question, recordQuery: {
    dataset: 'positions', entityScope: 'single', fields: [], filters: [{ field: 'sku', operator: 'contains', value: code.slice(0, 6) }],
    filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25,
  } });
  const refused = semantic.executePart(db, w.workspaceId, loose, {});
  assert.equal(refused.needsClarification, true);
  assert.match(refused.answer, new RegExp(`could not keep the exact code ${code} and the location Main Warehouse`));
  assert.equal(refused.rows.length, 0);
  const problems = semantic.scopeProblems(db, w.workspaceId, question, part({ question, recordQuery: { ...loose.recordQuery,
    filters: [{ field: 'sku', operator: 'eq', value: code }, { field: 'location', operator: 'eq', value: 'Main Warehouse' }] } }));
  assert.deepEqual(problems, []);
});

test('a question with no matching lookup is not answered by the nearest one', () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const question = 'Show me products below their reorder point.';
  const wrong = semantic.executePart(db, w.workspaceId, part({ question, intent: 'likely_stockouts' }), {});
  assert.equal(wrong.supported, false);
  assert.match(wrong.answer, /rather than answer a different question: Ask “what should I order\?”/);
  assert.equal(semantic.mismatchedIntent(question, 'what_to_order'), null, 'the lookup that genuinely answers it is allowed');
});

test('something StockChief does not do is said plainly, without capability ids', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const provider = { async complete() { return { data: {
    decision: 'not_supported', interpretation: 'Loyalty programme', clarification: '', continuesPrevious: false,
    unsupportedReason: 'StockChief does not run customer loyalty or points programmes.', nearest: 'pricing.manage can set selling prices', parts: [],
  } }; } };
  const result = await semantic.ask(db, w.workspaceId, 'Set up a loyalty points programme with 5% back.', { provider, intentSystem: '', legacySchema: { type: 'object' } });
  assert.equal(result.supported, false);
  assert.equal(result.answer, 'StockChief does not run customer loyalty or points programmes.');
  assert.doesNotMatch(result.answer, /pricing\.manage/);
});

test('a pending clarification never captures an unrelated message', async () => {
  let calls = 0;
  const provider = { async complete(r) {
    calls += 1;
    if (calls === 1) return { data: { decision: 'clarify', interpretation: 'Which product', clarification: 'Which product do you mean?', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [] } };
    const prompt = JSON.parse(r.prompt);
    assert.match(prompt.previous.clarification, /Which product/);
    return { data: { decision: 'action', interpretation: 'Draft an email', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [] } };
  } };
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Composite Bush', baseCode: 'CB' });
  const app = createApp({ db, env: 'test', sessionSecret: 'phase-0', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const first = await agent.get('/ask').query({ q: 'How much do we have?' });
  assert.match(plain(first.text), /Which product do you mean\?/);
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(first.text), queryConversation: '1', message: 'Draft an email to Acme about PO-1013.' });
  assert.equal(posted.status, 303);
  assert.doesNotMatch(posted.headers.location, /Follow-up answer/, 'the new instruction is carried on its own');
  const page = await agent.get('/ask');
  assert.doesNotMatch(plain(page.text), /Follow-up answer/);
  assert.match(plain(page.text), /You How much do we have\? StockChief Which product do you mean\?/, 'the earlier turn is still on the page');
});

test('the transcript is per workspace, capped, and cleared by New conversation', async () => {
  const provider = { async complete() { return { data: { decision: 'answer', interpretation: 'Count', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [{
    question: 'How many products?', intent: 'record_query', entityQuery: '', locationQuery: '', windowDays: 30, limit: 10, unsupportedReason: '', recordQuery: {
      dataset: 'products', entityScope: 'set', fields: [], filters: [{ field: 'active', operator: 'eq', value: 1 }], filterMode: 'all', aggregate: 'count', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 25,
    } }] } }; } };
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Composite Bush', baseCode: 'CB' });
  const app = createApp({ db, env: 'test', sessionSecret: 'phase-0-transcript', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  for (let n = 1; n <= 14; n += 1) {
    const form = await agent.get('/ask');
    const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(form.text), queryConversation: '1', message: `Question number ${n}?` });
    assert.equal(posted.status, 303);
    await agent.get(posted.headers.location);
  }
  const page = await agent.get('/ask');
  const text = plain(page.text);
  assert.doesNotMatch(text, /Question number 1\?/, 'the oldest turns fall off');
  assert.doesNotMatch(text, /Question number 2\?/);
  assert.match(text, /Question number 3\?/);
  assert.match(text, /Question number 14\?/);
  assert.equal((page.text.match(/rm-turn--you/g) || []).length, 12);
  const cleared = await agent.post('/ask/new').type('form').send({ _csrf: csrfFrom(page.text) });
  assert.equal(cleared.status, 303);
  const fresh = await agent.get('/ask');
  assert.doesNotMatch(plain(fresh.text), /Question number/);
  assert.match(plain(fresh.text), /What can I help you run\?/);
});
