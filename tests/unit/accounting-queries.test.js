'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const planner = require('../../src/attention/query-planner');
const queries = require('../../src/attention/query-service');
const authService = require('../../src/domain/auth-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

test.after(cleanupAll);

test('financial wording routes deterministically without hard-coded products or an AI call', async () => {
  const cases = [
    ['What was our gross profit this month?', 'profit_and_loss'],
    ['Show me the balance sheet', 'balance_sheet'],
    ['How much cash do we have?', 'cash_position'],
    ['Who owes us money?', 'receivables_aging'],
    ['What bills do we need to pay?', 'payables_aging'],
    ['What is our inventory valuation?', 'inventory_valuation'],
    ['How much sales tax is payable?', 'sales_tax_summary'],
    ['How is the business doing financially?', 'financial_summary'],
  ];
  for (const [question, intent] of cases) assert.equal((await planner.plan(question)).intent, intent);
});

test('financial answers come from posted ledger numbers and explain gross versus net profit', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const today = new Date().toISOString().slice(0, 10);
  ledger.post(db, workspace.ctx, {
    postingDate: today, description: 'Sale and cost', sourceKey: 'query-sale',
    lines: [
      { accountKey: 'CASH', debitMinor: 20_000 },
      { accountKey: 'SALES_REVENUE', creditMinor: 20_000 },
      { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: 8_000 },
      { accountKey: 'INVENTORY_ASSET', creditMinor: 8_000 },
    ],
  });
  ledger.post(db, workspace.ctx, {
    postingDate: today, description: 'Rent', sourceKey: 'query-rent',
    lines: [
      { accountKey: 'RENT_EXPENSE', debitMinor: 3_000 },
      { accountKey: 'CASH', creditMinor: 3_000 },
    ],
  });
  const result = queries.execute(db, workspace.workspaceId, { intent: 'profit_and_loss', windowDays: 30 });
  assert.match(result.answer, /\$90\.00 net profit/i);
  assert.match(result.answer, /\$200\.00 revenue.*\$80\.00 cost of goods.*\$30\.00 operating expenses/i);
  assert.match(result.answer, /Gross profit.*not the same as net profit/i);
  assert.deepEqual(result.rows.map((row) => row.amountMinor), [20_000, 8_000, 12_000, 3_000, 9_000]);
});

test('financial questions work immediately because accounting is automatic', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const result = queries.execute(db, workspace.workspaceId, { intent: 'cash_position' });
  assert.match(result.answer, /Ledger cash is \$0\.00/i);
  assert.equal(result.handoff, null);
});

/**
 * A yes-or-no question gets a yes or a no.
 *
 * Answers here are assembled from real figures rather than written by a model,
 * which is why Foundry cannot invent one — but a template states its fact
 * regardless of what was asked. "Have I made any profit yet?" was answered
 * "This is $99.92 net profit based on the expenses recorded in Foundry for
 * 2026-08-03 through 2026-09-01: ...". Every figure correct, and not an answer.
 *
 * The first attempt at fixing it was worse: it asserted its own proposition and
 * answered "Am I making a loss?" with "Yes — $99.92 so far" about a profitable
 * month. A verdict is only safe when Foundry knows which proposition the
 * question makes, so where it cannot tell, it offers none.
 */
test('profit questions are answered in the form they were asked', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, { startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE' });
  const today = new Date().toISOString().slice(0, 10);
  ledger.post(db, workspace.ctx, {
    postingDate: today, description: 'Sale and cost', sourceKey: 'verdict-sale',
    lines: [
      { accountKey: 'CASH', debitMinor: 20_000 },
      { accountKey: 'SALES_REVENUE', creditMinor: 20_000 },
      { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: 8_000 },
      { accountKey: 'INVENTORY_ASSET', creditMinor: 8_000 },
    ],
  });
  const ask = (question) => queries
    .execute(db, workspace.workspaceId, { intent: 'profit_and_loss', windowDays: 30 }, { question })
    .answer;

  assert.match(ask('Have I made any profit yet?'), /^Yes — /, 'a profitable month says yes');
  assert.match(ask('Am I profitable?'), /^Yes — /);

  // The opposite proposition gets the opposite answer, not an agreeable one.
  assert.match(ask('Am I making a loss?'), /^No — /);
  assert.match(ask('Did I lose money?'), /^No — /);
  assert.match(ask('Am I in the red?'), /^No — /);

  // Questions that are not yes-or-no keep the plain statement of figures.
  assert.doesNotMatch(ask('How much profit have I made?'), /^(Yes|No)/);
  assert.doesNotMatch(ask('Why is profit low?'), /^(Yes|No)/);

  // The evidence still follows the verdict; nothing is replaced by it.
  assert.match(ask('Have I made any profit yet?'), /net profit based on the expenses recorded/);
  db.close();
});
