'use strict';

/**
 * Phase 3 of the assistant reliability programme: purchase orders from a
 * sentence carry every line or nothing (A3), the rest of the business is
 * queryable (G1), and every tool and model call has a typed boundary and a
 * record (the tool registry and ai_calls).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const authService = require('../../src/domain/auth-service');
const supplierService = require('../../src/purchasing/supplier-service');
const actionService = require('../../src/actions/action-service');
const intentService = require('../../src/actions/intent-service');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll } = require('../helpers');

test.after(cleanupAll);

function purchaseLine(item, quantity, supplier = 'Acme Trade Supply', extra = {}) {
  return intentService.normaliseLine({
    actionType: 'purchase', item, variant: '', quantity, sourceLocation: '', destinationLocation: '',
    supplier, purchaseUnit: '', adjustmentTarget: -1, reasonCode: '', ...extra,
  });
}

function setup() {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  const membership = authService.getMembership(db, w.workspaceId, w.accountId);
  const elbow = makeQuantityItem(db, w.ctx, { name: 'Copper Elbow', baseCode: 'CE' });
  const pack = makeQuantityItem(db, w.ctx, { name: 'Trail Ration Pack', baseCode: 'TRP' });
  const acme = supplierService.createSupplier(db, w.ctx, membership, { name: 'Acme Trade Supply' });
  const lakeside = supplierService.createSupplier(db, w.ctx, membership, { name: 'Lakeside Textiles' });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 2 });
  supplierService.linkItem(db, w.ctx, membership, { supplierId: acme.id, skuId: pack.skuId, purchaseUnit: 'box', unitsPerPurchaseUnit: 6, lastUnitCost: 24 });
  return { db, w, membership, elbow, pack, acme, lakeside };
}

// A3. Before: "That order names 2 products … prepared nothing rather than order only the first."
test('an order naming two products is one draft with both lines, and says two asked for, two carried', async () => {
  const { db, w, membership, elbow, pack, acme } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Create a PO for 12 Copper Elbow and 6 Trail Ration Pack from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Trail Ration Pack', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  assert.equal(result.order.supplierId, acme.id);
  assert.equal(result.order.status, 'DRAFT', 'a draft — nothing ordered until approved');
  const lines = db.prepare('SELECT sku_id, quantity_units, quantity_purchase_units FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number').all(result.order.id);
  assert.deepEqual(lines.map((l) => [l.sku_id, l.quantity_units, l.quantity_purchase_units]), [[elbow.skuId, 12, 12], [pack.skuId, 6, 1]]);
  assert.match(result.assumptions.join(' '), /2 lines asked for, 2 on the order: 12 units of Copper Elbow; 1 box of Trail Ration Pack\./);
  assert.deepEqual(result.order.sourceDetail.requestedLines, ['12 Copper Elbow', '6 Trail Ration Pack']);
  assert.equal(result.order.sourceDetail.preparedLines, 2);
});

test('a line that cannot be resolved stops the whole order and is named by line; nothing is drafted or linked', async () => {
  const { db, w, membership } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Create a PO for 12 Copper Elbow and 6 Widgets from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Widgets', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.notEqual(result.kind, 'purchase_order');
  assert.match(String(result.question || result.message), /^Line 2 of 2 \(6 Widgets\): /);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0);
});

test('lines from different suppliers are not one order: the split is said, nothing drafted', async () => {
  const { db, w, membership, lakeside, pack } = setup();
  supplierService.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: pack.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 5 });
  const result = await actionService.interpret(db, w.ctx, membership,
    'Order 12 Copper Elbow from Acme Trade Supply and 6 Trail Ration Pack from Lakeside Textiles.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12), purchaseLine('Trail Ration Pack', 6, 'Lakeside Textiles')], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'unsupported');
  assert.match(result.message, /different suppliers — Copper Elbow from Acme Trade Supply; Trail Ration Pack from Lakeside Textiles — and a purchase order goes to one supplier/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM purchase_orders').get().n, 0);
});

test('a cost said once in the sentence is not copied onto every line of a list; a cost on a line is kept', async () => {
  const { db, w, membership } = setup();
  const result = await actionService.interpret(db, w.ctx, membership,
    'Order 12 Copper Elbow at $2.50 each and 6 Trail Ration Pack from Acme Trade Supply.',
    { parsedIntent: { lines: [purchaseLine('Copper Elbow', 12, 'Acme Trade Supply', { unitCost: 2.5 }), purchaseLine('Trail Ration Pack', 6)], clarifyingQuestion: '', unsupportedReason: '' } });
  assert.equal(result.kind, 'purchase_order', JSON.stringify(result));
  const lines = db.prepare('SELECT unit_cost FROM purchase_order_lines WHERE purchase_order_id = ? ORDER BY line_number').all(result.order.id);
  assert.equal(Number(lines[0].unit_cost), 2.5);
  assert.notEqual(Number(lines[1].unit_cost), 2.5, 'the pack keeps its own supplier cost, not the elbow price');
});

// G1. Before: order lines, bills, invoices, payments, shipments, returns, reorder settings and supplier items were not queryable at all.
test('the other half of the business is queryable: nine new datasets, each compiling with its defaults', () => {
  const records = require('../../src/attention/record-query');
  const { db, w, membership, elbow, lakeside } = setup();
  const base = { entityScope: 'set', fields: [], filters: [], filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 5 };
  for (const dataset of ['purchase_order_lines', 'sales_order_lines', 'bills', 'invoices', 'payments', 'shipments', 'returns', 'reorder_settings', 'supplier_items']) {
    assert.ok(records.REGISTRY[dataset], `${dataset} is registered`);
    const result = records.execute(db, w.workspaceId, { ...base, dataset }, {});
    assert.equal(result.supported !== false, true, dataset);
  }
  supplierService.linkItem(db, w.ctx, membership, { supplierId: lakeside.id, skuId: elbow.skuId, purchaseUnit: 'unit', unitsPerPurchaseUnit: 1, lastUnitCost: 3 });
  const items = records.execute(db, w.workspaceId, { ...base, dataset: 'supplier_items', filters: [{ field: 'product', operator: 'contains', value: 'Copper Elbow' }], sortField: 'last_unit_cost', sortDirection: 'asc' }, {});
  assert.equal(items.rows.length, 2);
  assert.equal(items.rows[0].supplier, 'Acme Trade Supply', 'the cheapest supplier sorts first');
  assert.equal(items.rows[0].last_unit_cost, 2);
});

test('a name that matches nothing exactly is tried as part of a name, and money is shown as money', () => {
  const records = require('../../src/attention/record-query');
  const poService = require('../../src/purchasing/po-service');
  const { db, w, membership, elbow, acme } = setup();
  const po = poService.createOrder(db, w.ctx, membership, { supplierId: acme.id, lines: [{ skuId: elbow.skuId, quantityPurchaseUnits: 10, unitCost: 2 }], source: 'test' });
  const base = { entityScope: 'set', fields: [], filters: [], filterMode: 'all', aggregate: '', measure: '', metrics: [], groupBy: [], sortField: '', sortDirection: 'asc', limit: 5 };
  const lines = records.execute(db, w.workspaceId, { ...base, dataset: 'purchase_order_lines', filters: [{ field: 'supplier', operator: 'eq', value: 'Acme' }] }, {});
  assert.equal(lines.rows.length, 1);
  assert.equal(lines.rows[0].order_number, po.poNumber);
  assert.match(lines.answer, /\(Matched “Acme” as part of the supplier\.\)$/);
  const plural = records.execute(db, w.workspaceId, { ...base, dataset: 'purchase_order_lines', filters: [{ field: 'product', operator: 'contains', value: 'elbows' }] }, {});
  assert.equal(plural.rows.length, 1);
  assert.match(plural.answer, /Matched “elbows” as part of the product/);
  const none = records.execute(db, w.workspaceId, { ...base, dataset: 'bills', filters: [{ field: 'issue_date', operator: 'gte', value: '2030-01-01' }] }, {});
  assert.match(none.answer, /That is a search result, not a failure\.$/, 'a date filter gets no spelling advice');
  const single = records.execute(db, w.workspaceId, { ...base, dataset: 'purchase_order_lines', entityScope: 'single', filters: [{ field: 'supplier', operator: 'contains', value: 'Acme' }] }, {});
  assert.equal(single.needsClarification, undefined, 'a party with many lines is not an ambiguity');
  const money = records.execute(db, w.workspaceId, { ...base, dataset: 'sales_order_lines', fields: ['order_number', 'unit_price_minor'] }, {});
  assert.deepEqual(money.columns, ['order_number', 'unit_price'], 'minor-unit columns are shown as money');
});

test('"has SO-… shipped and where is it?" is a question about the order, not a request for its page', () => {
  const navigation = require('../../src/product-brain/navigation');
  assert.equal(navigation.isBusinessDataQuestion('has SO-1006 shipped and where is it?'), true);
  assert.equal(navigation.isBusinessDataQuestion('open SO-1006'), false);
});

// The tool registry and the record of calls.
test('every tool is declared once: id, kind, schema, permission; input is validated and permission checked before anything runs', async () => {
  const tools = require('../../src/assistant/tools');
  const ids = tools.list().map((t) => t.id);
  assert.deepEqual(ids, ['records.query', 'lookup.run', 'question.ask', 'action.prepare', 'price.change', 'instruction.remember', 'message.draft', 'navigate.resolve']);
  for (const t of tools.list()) { assert.ok(t.input && t.input.type === 'object', t.id); assert.ok(t.permission, t.id); assert.ok(tools.KINDS.includes(t.kind), t.id); }
  const { db, w, membership } = setup();
  await assert.rejects(tools.call(db, w.ctx, membership, 'records.query', { dataset: 'nothing_like_this' }), /could not use read your records/);
  await assert.rejects(tools.call(db, w.ctx, membership, 'nothing.here', {}), /has no tool called/);
  const staff = { role: 'accountant', permissions: [] };
  await assert.rejects(tools.call(db, w.ctx, staff, 'action.prepare', { instruction: 'move 5 copper elbow to the store' }), /Your role \(accountant\) does not allow StockChief to prepare a change to your stock or catalogue/);
  const read = await tools.call(db, w.ctx, membership, 'records.query', { dataset: 'products' });
  assert.equal(read.tool, 'records.query'); assert.equal(read.kind, 'read'); assert.equal(read.ok, true);
  assert.ok(read.result.rows.length >= 2);
  const rows = db.prepare("SELECT purpose, kind, outcome FROM ai_calls ORDER BY created_at").all();
  assert.deepEqual(rows.map((r) => [r.purpose, r.kind, r.outcome]), [
    ['records.query', 'tool', 'invalid_input'], ['action.prepare', 'tool', 'refused'], ['records.query', 'tool', 'ok'],
  ]);
});

test('every model call is on the record, redacted, tied to the goal it served, and its cost is said on the answer', async () => {
  const request = require('supertest');
  const { createApp } = require('../../src/app');
  const { signIn, csrfFrom } = require('../helpers');
  const calls = require('../../src/assistant/calls');
  const engine = require('../../src/domain/inventory-engine');
  const { db, w, elbow } = setup();
  engine.receive(db, w.ctx, { skuId: elbow.skuId, locationId: w.main.id, quantity: 40 });
  const provider = { name: 'fake', model: 'fake-1', async complete(r) {
    if (r.schemaName === 'assistant_understanding') return { data: { continuesPrevious: false, goals: [{ kind: 'lookup', text: 'how many Copper Elbow do we have' }] }, usage: { inputTokens: 10, outputTokens: 5, latencyMs: 12 } };
    if (r.schemaName === 'stockchief_semantic_query') return { data: { decision: 'answer', interpretation: 'stock of Copper Elbow', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '', parts: [{ question: 'how many Copper Elbow do we have', intent: 'stock_level', entityQuery: 'Copper Elbow', locationQuery: '', windowDays: 30, limit: 25, unsupportedReason: '', recordQuery: null }] }, usage: { inputTokens: 100, outputTokens: 40, latencyMs: 300 } };
    return { data: {}, usage: {} };
  } };
  const app = createApp({ db, env: 'test', sessionSecret: 'phase3', aiProvider: provider });
  const agent = request.agent(app);
  await signIn(agent, w.account.email, w.account.password);
  const home = await agent.get('/');
  const posted = await agent.post('/foundry/tell').type('form').send({ _csrf: csrfFrom(home.text), message: 'tell me the stock position for Copper Elbow', queryConversation: '1' });
  const page = await agent.get(posted.headers.location);
  assert.match(page.text, /Copper Elbow: 40/);
  const rows = db.prepare("SELECT kind, purpose, model, prompt_redacted, input_tokens, goal_id, outcome FROM ai_calls WHERE kind = 'model' ORDER BY created_at").all();
  assert.ok(rows.length >= 1, JSON.stringify(rows));
  assert.ok(rows.every((r) => r.model === 'fake-1' && r.outcome === 'ok' && r.goal_id), 'each model call names the goal it served');
  assert.ok(rows.every((r) => !/Copper Elbow/.test(r.prompt_redacted || '')), 'record values are not kept in the prompt');
  assert.equal(rows.find((r) => r.purpose === 'stockchief_semantic_query').input_tokens, 100);
  const goal = db.prepare("SELECT id, provenance FROM assistant_goals ORDER BY created_at DESC LIMIT 1").get();
  const provenance = JSON.parse(goal.provenance);
  assert.ok(provenance.modelCalls >= 1, 'the answer records what it cost');
  assert.equal(calls.forGoal(db, goal.id).modelCalls, provenance.modelCalls);
  assert.match(page.text, /\d+ model calls?, \d+ ms/);
  assert.equal(calls.redact('Order 12 "Copper Elbow" at $2.50'), 'Order # "…" at $#');
});
