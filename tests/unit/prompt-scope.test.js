'use strict';

/**
 * The semantic planner sees only the areas a question touches. Before, every
 * question carried all sixty-two intents, all eighteen datasets and the
 * whole product contract — about 13,000 tokens to plan "how many gloves".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const scope = require('../../src/attention/prompt-scope');
const planner = require('../../src/attention/query-planner');
const semantic = require('../../src/attention/semantic-query');
const queryService = require('../../src/attention/query-service');
const records = require('../../src/attention/record-query');
const { makeDatabase, seedWorkspace, makeQuantityItem, cleanupAll } = require('../helpers');

test.after(cleanupAll);

const all = { allIntents: queryService.INTENTS, allDatasets: Object.keys(records.REGISTRY) };

test('a question about stock gets the core; a question about buying gets purchasing too; a vague one gets everything', () => {
  const stock = scope.scopeFor('how many gloves do we have', all);
  assert.equal(stock.full, false);
  assert.ok(stock.intents.includes('stock_level') && stock.intents.includes('action') && stock.intents.includes('unsupported'));
  assert.ok(!stock.intents.includes('profit_and_loss') && !stock.intents.includes('on_order'));
  assert.deepEqual(stock.datasets.filter((d) => ['bills', 'invoices', 'shipments'].includes(d)), []);
  const buying = scope.scopeFor('whats on order from Lakeside?', all);
  assert.ok(buying.intents.includes('on_order') && buying.datasets.includes('purchase_order_lines'));
  const money = scope.scopeFor('which products are we losing money on?', all);
  assert.ok(money.intents.includes('product_profitability'));
  const vague = scope.scopeFor('what should I do today?', all);
  assert.equal(vague.full, true);
  assert.equal(vague.intents.length, queryService.INTENTS.length);
  assert.ok(scope.scopeFor('is anything expiring soon?', all).intents.includes('expiring_soon'));
  const followUp = scope.scopeFor('and at the store?', { ...all, previous: { intent: 'supplier_spend', dataset: 'bills' } });
  assert.ok(followUp.intents.includes('supplier_spend') && followUp.datasets.includes('bills'), 'the previous turn stays available');
});

test('the planner prompt lists only the intents handed to it and carries the product contract in its short form', () => {
  const full = planner.SYSTEM;
  const cut = planner.systemFor(['stock_level', 'action', 'unsupported']);
  assert.ok(cut.length < full.length / 2, `${cut.length} vs ${full.length}`);
  assert.match(cut, /- stock_level: how much of something there is/);
  assert.doesNotMatch(cut, /- profit_and_loss:/);
  assert.match(cut, /Available: Workspaces, Inventory setup/);
  assert.doesNotMatch(cut, /- workspace\.manage \(Workspaces\): AVAILABLE/);
  assert.match(cut, /Never say it cannot do something because no lookup here matches/);
  assert.equal(Object.keys(planner.INTENT_DESCRIPTIONS).length, 62);
});

test('the request the model sees is scoped in prose, catalogue and schema alike, and the plan still executes against everything', async () => {
  const { db } = makeDatabase();
  const w = seedWorkspace(db);
  makeQuantityItem(db, w.ctx, { name: 'Harbour Work Glove', baseCode: 'HG' });
  const seen = [];
  const provider = { async complete(r) {
    seen.push(r);
    return { data: { decision: 'answer', interpretation: 'gloves on hand', clarification: '', continuesPrevious: false, unsupportedReason: '', nearest: '',
      parts: [{ question: 'how many gloves do we have', intent: 'stock_level', entityQuery: 'gloves', locationQuery: '', windowDays: 30, limit: 25, unsupportedReason: '', recordQuery: null }] } };
  } };
  const opts = { provider, intentSystem: planner.SYSTEM, intentSystemFor: planner.systemFor, legacySchema: planner.PLAN_SCHEMA, context: {} };
  const result = await semantic.ask(db, w.workspaceId, 'how many gloves do we have', opts);
  assert.match(result.answer, /Harbour Work Glove/);
  const r = seen[0];
  const intentEnum = r.schema.properties.parts.items.properties.intent.enum;
  assert.ok(intentEnum.includes('stock_level') && !intentEnum.includes('profit_and_loss'));
  const datasetEnum = r.schema.properties.parts.items.properties.recordQuery.anyOf[0].properties.dataset.enum;
  assert.ok(datasetEnum.includes('products') && !datasetEnum.includes('bills'));
  assert.doesNotMatch(r.system, /^bills: /m);
  assert.doesNotMatch(r.system, /- profit_and_loss:/);
  assert.match(r.system, /- stock_level:/);
  await semantic.ask(db, w.workspaceId, 'what should I do today?', opts);
  const full = seen[1];
  assert.ok(full.schema.properties.parts.items.properties.intent.enum.includes('profit_and_loss'), 'a vague question keeps everything');
  assert.ok(full.system.length > r.system.length * 1.4);
});
