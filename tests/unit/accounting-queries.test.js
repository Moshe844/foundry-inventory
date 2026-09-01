'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ledger = require('../../src/accounting/ledger');
const planner = require('../../src/attention/query-planner');
const queries = require('../../src/attention/query-service');
const authService = require('../../src/domain/auth-service');
const engine = require('../../src/domain/inventory-engine');
const { makeDatabase, cleanupAll, seedWorkspace, makeQuantityItem } = require('../helpers');

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

/**
 * The verdict layer across the intents whose question is "is there any?".
 *
 * Most of these executors return the things themselves, so whether there are
 * any is a fact already in hand. Two traps had to be closed to use it.
 *
 * "Is anything not moving?" contains both "not moving" and "moving", so a plain
 * contains-check saw the question assert and deny the same thing. The longer
 * phrase is the one the reader meant.
 *
 * And replenishment is deliberately excluded: its rows are recommendations in
 * one branch and lines it cannot assess in another, so a uniform "any rows
 * means yes" answered "13 lines need ordering" about thirteen lines the
 * executor had just said it had no basis to judge — inventing the demand figure
 * the whole executor exists to refuse.
 */
test('list questions get a verdict, and only where the proposition is clear', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const ask = (intent, question) => queries
    .execute(db, workspace.workspaceId, { intent, windowDays: 30, limit: 20 }, { question })
    .answer;
  const isVerdict = (answer) => /^(Yes|No)( —|\.)/.test(String(answer || ''));

  // An empty workspace: nothing is late, nothing expires, nothing needs anyone.
  assert.ok(isVerdict(ask('late_orders', 'Are any orders late?')));
  assert.match(ask('late_orders', 'Are any orders late?'), /^No — /);
  assert.match(ask('late_orders', 'Is everything on time?'), /^Yes — /,
    'the opposite question gets the opposite answer');

  assert.match(ask('expiring_soon', 'Is anything expiring soon?'), /^No — /);
  assert.match(ask('attention_summary', 'Is anything wrong?'), /^No — /);

  // "not moving" must beat "moving" — the more specific phrase decides.
  assert.match(ask('idle_stock', 'Is anything not moving?'), /^No — /);

  // Questions that are not yes-or-no keep the plain statement.
  for (const question of ['How many orders are late?', 'Which orders are late?']) {
    assert.ok(!isVerdict(ask('late_orders', question)), `${question} needs no verdict`);
  }

  // Replenishment states its own verdict per branch, or none. What it must
  // never do is claim lines need ordering off a row count that means
  // something else in that branch.
  assert.doesNotMatch(ask('replenishment', 'Do I need to order anything?'), /^Yes/,
    'an inventory with nothing in it does not need ordering');
  db.close();
});

/**
 * "Is anything wrong with my books?"
 *
 * The one question from the accounting brief with no intent behind it. The
 * checks were already computed for the Accounting screen and then flattened
 * into sentences with nothing behind them — no record to open, no action, no
 * way to ask which ones.
 *
 * The checks live in accounting/books-review as entries in a list rather than
 * branches in a function, and read the owner dashboard's own figures, so the
 * audit and the screen cannot disagree and a new check is a new entry.
 */
test('the books review answers the question and every finding leads somewhere', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });

  const review = require('../../src/accounting/books-review');
  const clean = review.review(db, workspace.workspaceId);

  // A workspace with nothing in it has nothing wrong with it, and says how
  // much was looked at — "nothing is wrong" is only worth hearing with that.
  assert.equal(clean.clean, true);
  assert.deepEqual(clean.findings, []);
  assert.ok(clean.checksRun >= 8, 'every check ran');

  // Every check must answer the same four questions, or it is just a worry.
  for (const check of review.CHECKS) {
    assert.equal(typeof check.id, 'string');
    assert.equal(typeof check.run, 'function');
  }

  const answered = queries.execute(db, workspace.workspaceId, { intent: 'books_health' },
    { question: 'Is anything wrong with my books?' });
  assert.match(answered.answer, /^No — nothing found across \d+ checks\./,
    'a yes-or-no question about the books gets a yes or a no');
  assert.match(answered.answer, /what customers owe/, 'and says what was actually checked');
});

test('a finding names the record, the reason, and the way to fix it', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });

  // Stock on the shelves whose cost was never proven: a real finding, and the
  // one an imported spreadsheet produces on its first day.
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Canvas Tote' });
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 12,
    reasonCode: 'opening_inventory', notes: 'Opening inventory',
  });

  const review = require('../../src/accounting/books-review').review(db, workspace.workspaceId);
  assert.equal(review.clean, false);
  const finding = review.findings.find((row) => row.id === 'inventory_without_proven_cost');
  assert.ok(finding, 'unproven stock cost is found');

  assert.match(finding.what, /12 units/, 'what happened, with the real number');
  assert.match(finding.why, /will not guess/, 'why Foundry stopped rather than estimating');
  assert.ok(finding.proof.href, 'what proves it, and where to read it');
  assert.ok(finding.action.href, 'and one thing to do about it');

  // The answer carries that route through to the row, so the number is a way
  // in rather than a verdict to be taken on trust.
  const answered = queries.execute(db, workspace.workspaceId, { intent: 'books_health' },
    { question: 'Is anything wrong with my books?' });
  assert.match(answered.answer, /^Yes — /);
  assert.equal(answered.rows.length, review.findings.length);
  assert.ok(answered.rows.every((row) => row.href), 'every row drills down');
  assert.ok(!answered.columns.includes('href'), 'the link is not shown as a column');
});

/**
 * The three checks that need a baseline rather than today's figures.
 *
 * Each compares the business against itself — its own previous period, its own
 * typical spend on that category, its own movement ledger — because there is no
 * correct margin or normal expense for a business in general. A check that
 * never fires is worse than no check, so each is proven here against a case
 * built to trigger it.
 */
test('margin drops are measured against the same business a period earlier', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });

  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  // Earlier period: sold 200 at a cost of 80 — a 60% margin.
  ledger.post(db, workspace.ctx, {
    postingDate: day(45), description: 'Earlier sales', sourceKey: 'margin-before',
    lines: [
      { accountKey: 'CASH', debitMinor: 20_000 }, { accountKey: 'SALES_REVENUE', creditMinor: 20_000 },
      { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: 8_000 }, { accountKey: 'INVENTORY_ASSET', creditMinor: 8_000 },
    ],
  });
  // This period: sold 200 at a cost of 180 — a 10% margin.
  ledger.post(db, workspace.ctx, {
    postingDate: day(2), description: 'Recent sales', sourceKey: 'margin-now',
    lines: [
      { accountKey: 'CASH', debitMinor: 20_000 }, { accountKey: 'SALES_REVENUE', creditMinor: 20_000 },
      { accountKey: 'COST_OF_GOODS_SOLD', debitMinor: 18_000 }, { accountKey: 'INVENTORY_ASSET', creditMinor: 18_000 },
    ],
  });

  const review = require('../../src/accounting/books-review')
    .review(db, workspace.workspaceId, { from: day(30), to: day(0), asOf: day(0) });
  const finding = review.findings.find((row) => row.id === 'margin_dropped');

  assert.ok(finding, 'a margin falling from 60% to 10% is noticed');
  assert.match(finding.what, /60\.0% to 10\.0%/, 'and states both figures');
  assert.match(finding.why, /keeping less of every sale/);
  assert.ok(finding.action.href, 'with somewhere to compare them');
  db.close();
});

test('an unusual expense is unusual against that category, not a fixed amount', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });

  const day = (offset) => new Date(Date.now() - offset * 86400000).toISOString().slice(0, 10);
  // A habit: four ordinary shipping charges.
  for (const [index, amount] of [1_000, 1_200, 900, 1_100].entries()) {
    ledger.post(db, workspace.ctx, {
      postingDate: day(20 - index), description: `Courier ${index + 1}`, sourceKey: `ship-${index}`,
      lines: [
        { accountKey: 'SHIPPING_EXPENSE', debitMinor: amount }, { accountKey: 'CASH', creditMinor: amount },
      ],
    });
  }
  // Then one that is nothing like them.
  ledger.post(db, workspace.ctx, {
    postingDate: day(3), description: 'Courier — annual account', sourceKey: 'ship-big',
    lines: [
      { accountKey: 'SHIPPING_EXPENSE', debitMinor: 60_000 }, { accountKey: 'CASH', creditMinor: 60_000 },
    ],
  });

  const review = require('../../src/accounting/books-review')
    .review(db, workspace.workspaceId, { from: day(30), to: day(0), asOf: day(0) });
  const finding = review.findings.find((row) => row.id === 'unusual_expense');

  assert.ok(finding, 'the outlier is found');
  assert.match(finding.what, /\$600\.00/, 'and named by its amount');
  assert.match(finding.why, /Not necessarily wrong/,
    'without accusing the owner of an error they may have meant');
  db.close();
});

test('stock that disagrees with its own history is the most serious finding', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  ledger.configure(db, workspace.ctx, membership, {
    startDate: '2026-01-01', currency: 'USD', costingMethod: 'WEIGHTED_AVERAGE',
  });
  const item = makeQuantityItem(db, workspace.ctx, { name: 'Canvas Tote' });
  engine.receive(db, workspace.ctx, {
    skuId: item.skuId, locationId: workspace.main.id, quantity: 10, reasonCode: 'opening_inventory',
  });

  // A balance that no longer matches the movements behind it. The ledger is
  // immutable, so this is the only way the two can ever disagree — and exactly
  // what the integrity check exists to catch.
  db.prepare('UPDATE balances SET on_hand = on_hand + 7 WHERE workspace_id = ? AND sku_id = ?')
    .run(workspace.workspaceId, item.skuId);

  const review = require('../../src/accounting/books-review').review(db, workspace.workspaceId);
  const finding = review.findings.find((row) => row.id === 'inventory_discrepancy');

  assert.ok(finding, 'the mismatch is found');
  assert.equal(finding.severity, 'urgent', 'every value above it depends on these quantities');
  assert.match(finding.proof.label, /balance ledger mismatch/);
  assert.ok(finding.action.href, 'and it leads to the integrity report');

  // It sorts above the merely important, because it undermines them.
  assert.equal(review.findings[0].id, 'inventory_discrepancy');
  db.close();
});
