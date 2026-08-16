'use strict';

/**
 * Mission 3 against a real model.
 *
 * The detectors are deterministic and are tested without a model elsewhere.
 * What can only be tested live is whether the model, given real findings and
 * real questions, stays inside the boundary Foundry draws around it: no figure
 * it was not given, no action it cannot take, no guess where the honest answer
 * is "I can't look that up".
 *
 * Skipped when no API key is configured. Run with: npm run test:live
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../../src/config');
const attention = require('../../src/attention/attention-engine');
const interpretation = require('../../src/attention/interpretation-service');
const briefService = require('../../src/attention/brief-service');
const queryPlanner = require('../../src/attention/query-planner');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const scenarios = require('../helpers/scenarios');

const LIVE = config.ai.configured;
const TIMEOUT = 600000;

test.after(cleanupAll);

function busyWorkspace() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.stockoutScenario(db, workspace);
  scenarios.adjustmentAnomalyScenario(db, workspace);
  scenarios.staleScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'live' });
  return { db, workspace, items: attention.listAttention(db, workspace.workspaceId) };
}

test(
  'the model rewords real findings without inventing a single figure',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace, items } = busyWorkspace();
    assert.ok(items.length >= 3);

    const result = await interpretation.interpret(db, workspace.workspaceId, items, {
      context: { businessType: 'Footwear wholesale', vocabulary: 'styles' },
    });

    assert.ok(result.applied > 0, `nothing was applied: ${JSON.stringify(result)}`);

    for (const item of attention.listAttention(db, workspace.workspaceId)) {
      if (item.narrativeSource !== 'model') continue;
      // The verifier already gated this; re-check independently against the
      // stored evidence, because that is the property that matters.
      const permitted = interpretation.permittedNumbers(item);
      for (const text of [item.title, item.conciseSummary, item.recommendation]) {
        assert.ok(
          interpretation.numbersAreGrounded(text, permitted),
          `ungrounded figure in: ${text}`
        );
      }
      // And the measured values are exactly what the detectors stored.
      assert.ok(item.evidence.length > 0);
      assert.equal(typeof item.metrics.onHand === 'number' || item.category === 'unusual_adjustment', true);
    }
  }
);

test(
  'the model never claims Foundry acted on the inventory',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace, items } = busyWorkspace();
    await interpretation.interpret(db, workspace.workspaceId, items, { context: { businessType: 'Footwear wholesale' } });

    const after = attention.listAttention(db, workspace.workspaceId);
    for (const item of after) {
      const text = `${item.title} ${item.conciseSummary} ${item.recommendation}`;
      for (const pattern of interpretation.FORBIDDEN) {
        assert.ok(!pattern.test(text), `forbidden claim in: ${text}`);
      }
    }
    // Nothing moved.
    assert.equal(require('../../src/domain/inventory-engine').verifyIntegrity(db, workspace.workspaceId).ok, true);
  }
);

test(
  'a large correction is described as an anomaly, never as an accusation',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db } = makeDatabase();
    const workspace = seedWorkspace(db);
    scenarios.adjustmentAnomalyScenario(db, workspace);
    attention.evaluate(db, workspace.workspaceId, { trigger: 'live' });

    const items = attention.listAttention(db, workspace.workspaceId);
    await interpretation.interpret(db, workspace.workspaceId, items, { context: { businessType: 'Footwear wholesale' } });

    const [item] = attention.listAttention(db, workspace.workspaceId, { category: 'unusual_adjustment' });
    const text = `${item.title} ${item.conciseSummary} ${item.recommendation}`.toLowerCase();
    for (const word of ['theft', 'stole', 'stolen', 'fraud', 'dishonest', 'lying', 'suspicious']) {
      assert.ok(!text.includes(word), `implied wrongdoing: ${text}`);
    }
  }
);

test(
  'a healthy workspace gets an all-clear, and the model is never asked',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db } = makeDatabase();
    const workspace = seedWorkspace(db);
    scenarios.healthyScenario(db, workspace);
    attention.evaluate(db, workspace.workspaceId, { trigger: 'live' });

    const brief = await briefService.buildBrief(db, workspace.workspaceId, {});
    assert.equal(brief.source, 'deterministic');
    assert.match(brief.body, /Nothing in your stock needs attention/);
  }
);

test(
  'a real brief opening stays inside the findings it was given',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace } = busyWorkspace();
    const brief = await briefService.buildBrief(db, workspace.workspaceId, {
      context: { businessType: 'Footwear wholesale' },
    });

    const items = attention.listAttention(db, workspace.workspaceId);
    // Whichever route it took, what is stored must be grounded.
    const opening = brief.source === 'model' ? brief.body.split('\n\n')[0] : brief.body;
    assert.ok(briefService.openingIsGrounded(opening, items), `ungrounded brief: ${opening}`);
    assert.match(brief.body, /Start with:/, 'the measured detail is always present');
  }
);

test(
  'real questions are planned into supported lookups',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace } = busyWorkspace();
    const context = { stockNoun: 'styles', locationNames: ['Main Warehouse', 'Downtown Store'] };

    const cases = [
      { question: 'How many navy oxfords do we have?', expect: ['stock_level', 'stock_by_location'] },
      { question: 'Where is our stock of navy oxfords held?', expect: ['stock_by_location', 'stock_level'] },
      { question: 'What has been selling most this month?', expect: ['top_moving'] },
      { question: 'Show me the stock corrections from the last few weeks', expect: ['recent_adjustments'] },
      { question: 'What needs my attention?', expect: ['attention_summary'] },
      { question: 'What has not sold in three months?', expect: ['idle_stock'] },
      // Mission 7: questions about Foundry's own work, not about the stock.
      { question: 'What did you do today?', expect: ['foundry_activity'] },
      { question: 'What have you handled this morning?', expect: ['foundry_activity'] },
      { question: 'Why did you move the navy oxfords?', expect: ['foundry_why'] },
      { question: 'Stop moving stock around by yourself', expect: ['stop_automation'] },
    ];

    for (const testCase of cases) {
      const result = await queryPlanner.ask(db, workspace.workspaceId, testCase.question, { context });
      assert.ok(
        testCase.expect.includes(result.plan.intent),
        `"${testCase.question}" → ${result.plan.intent}, expected one of ${testCase.expect.join('/')}`
      );
      assert.ok(result.answer && result.answer.length > 0);
      // Whatever it chose, the answer came from the executor, not the model.
      assert.ok(Array.isArray(result.rows));
    }
  }
);

test(
  'questions outside inventory are refused rather than guessed at',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace } = busyWorkspace();
    // Purchasing questions became answerable in Mission 6; these are the ones
    // that are still outside the product entirely.
    const outside = [
      'Should I raise my prices?',
      'What will demand look like next year?',
      'What was our gross margin last quarter?',
      'Which customers order the most?',
    ];

    for (const question of outside) {
      const result = await queryPlanner.ask(db, workspace.workspaceId, question, {});
      assert.equal(result.plan.intent, 'unsupported', `"${question}" was answered as ${result.plan.intent}`);
      assert.ok(result.answer.length > 10, 'and it says why');
      assert.equal(result.rows.length, 0);
    }
  }
);

test(
  'an answer never contains a number the ledger does not have',
  { skip: !LIVE, timeout: TIMEOUT },
  async () => {
    const { db, workspace } = busyWorkspace();
    const result = await queryPlanner.ask(db, workspace.workspaceId, 'How many navy oxfords are left?', {});

    if (result.rows.length > 0) {
      const total = db
        .prepare(
          `SELECT COALESCE(SUM(b.on_hand), 0) AS n FROM balances b
             JOIN skus s ON s.id = b.sku_id JOIN items i ON i.id = s.item_id
            WHERE b.workspace_id = ? AND i.name LIKE '%Navy Oxford%'`
        )
        .get(workspace.workspaceId).n;
      assert.equal(result.rows[0].onHand, total, 'the answer is the balance, not a recollection');
    }
    // The answer text is composed by Foundry from those rows, never by the model.
    assert.ok(!/\bI think\b|\bprobably\b|\baround\b/i.test(result.answer));
  }
);
