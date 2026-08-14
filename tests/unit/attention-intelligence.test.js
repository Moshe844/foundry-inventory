'use strict';

/**
 * The layers above detection: rewording, the daily brief, and constrained
 * question answering. Everything here uses a scripted provider — the point is
 * what Foundry does with what a model returns, including when it returns
 * something it should not have.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const attention = require('../../src/attention/attention-engine');
const interpretation = require('../../src/attention/interpretation-service');
const briefService = require('../../src/attention/brief-service');
const queryService = require('../../src/attention/query-service');
const queryPlanner = require('../../src/attention/query-planner');
const feedback = require('../../src/attention/feedback-service');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const { fakeProvider } = require('../helpers/fake-provider');
const scenarios = require('../helpers/scenarios');

test.after(cleanupAll);

function withStockout() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  const scenario = scenarios.stockoutScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });
  const items = attention.listAttention(db, workspace.workspaceId);
  return { db, workspace, scenario, items };
}

const narrative = (item, over = {}) => ({
  items: [
    {
      id: item.attentionId,
      title: 'Navy Oxford is nearly gone',
      summary: '10 left at Main Warehouse',
      recommendation: 'Consider ordering more before the weekend.',
      rank: 1,
      ...over,
    },
  ],
});

// --- rewording ---------------------------------------------------------------

test('a faithful rewording is applied', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider(narrative(items[0]));

  const result = await interpretation.interpret(db, workspace.workspaceId, items, { provider });
  assert.equal(result.applied, 1);
  assert.equal(result.rejected.length, 0);

  const [after] = attention.listAttention(db, workspace.workspaceId);
  assert.equal(after.title, 'Navy Oxford is nearly gone');
  assert.equal(after.narrativeSource, 'model');
  // The measured wording is still there underneath, untouched.
  assert.match(after.deterministicTitle, /may run out/);
  assert.equal(after.metrics.onHand, 10);
});

test('a number that is not in the evidence is refused', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider(
    narrative(items[0], { summary: 'Only 3 left and 47 sold last week' })
  );

  const result = await interpretation.interpret(db, workspace.workspaceId, items, { provider });
  assert.equal(result.applied, 0);
  assert.match(result.rejected[0].problems.join(' '), /figure that is not in the evidence/);

  const [after] = attention.listAttention(db, workspace.workspaceId);
  assert.match(after.title, /may run out/, 'the deterministic wording stands');
  assert.equal(after.narrativeSource, null);
});

test('a claim that stock was moved is refused', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider(
    narrative(items[0], { recommendation: 'I have reordered this for you.' })
  );

  const result = await interpretation.interpret(db, workspace.workspaceId, items, { provider });
  assert.equal(result.applied, 0);
  assert.match(result.rejected[0].problems.join(' '), /cannot support/);
});

test('an accusation is refused', () => {
  const item = { evidence: [{ label: 'Change', value: '-25', kind: 'measured' }], metrics: {} };
  const base = {
    deterministicTitle: 'Unusual adjustment',
    deterministicSummary: '-25',
    deterministicRecommendation: 'Confirm the count.',
    explanation: 'A correction of -25 was recorded.',
    ...item,
  };
  const verdict = interpretation.verifyNarrative(
    { title: 'Possible theft', summary: '-25 units', recommendation: 'Someone stole stock.' },
    base
  );
  assert.equal(verdict.ok, false);
});

test('a finding the model invented is discarded', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider({
    items: [
      { id: 'att_does_not_exist', title: 'Everything is on fire', summary: 'x', recommendation: 'y', rank: 1 },
    ],
  });

  const result = await interpretation.interpret(db, workspace.workspaceId, items, { provider });
  assert.equal(result.applied, 0);
  assert.deepEqual(result.rejected[0].problems, ['unknown finding id']);
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1, 'no item was created');
});

test('a provider failure costs wording, not the briefing', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider(new Error('502 upstream'));

  const result = await interpretation.interpret(db, workspace.workspaceId, items, { provider });
  assert.equal(result.applied, 0);
  assert.match(result.reason, /provider_unavailable/);

  const [after] = attention.listAttention(db, workspace.workspaceId);
  assert.match(after.title, /may run out/);
  assert.ok(after.evidence.length > 0);
});

test('rewording cannot push a critical finding below a lesser one', () => {
  const items = [
    { attentionId: 'a', severity: 'critical' },
    { attentionId: 'b', severity: 'watch' },
  ];
  const ranks = new Map([
    ['a', 9],
    ['b', 1],
  ]);
  const ordered = interpretation.applyRankHints(items, ranks);
  assert.deepEqual(ordered.map((i) => i.attentionId), ['a', 'b']);
});

// --- the brief ---------------------------------------------------------------

test('a healthy workspace gets a plain all-clear and no model call', async () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.healthyScenario(db, workspace);
  attention.evaluate(db, workspace.workspaceId, { trigger: 'test' });

  const provider = fakeProvider({ opening: 'Things are going great!' });
  const brief = await briefService.buildBrief(db, workspace.workspaceId, { provider });

  assert.equal(provider.calls.length, 0, 'nothing to write about, so nothing was asked');
  assert.equal(brief.source, 'deterministic');
  assert.match(brief.body, /Nothing in your stock needs attention/);
  assert.deepEqual(brief.itemIds, []);
});

test('the brief names the most urgent finding first', async () => {
  const { db, workspace } = withStockout();
  const brief = await briefService.buildBrief(db, workspace.workspaceId, { deterministicOnly: true });
  assert.match(brief.body, /needs your attention/);
  assert.match(brief.body, /Start with/);
  assert.match(brief.body, /navy oxford/i);
});

test('a model opening with an invented number is dropped', async () => {
  const { db, workspace } = withStockout();
  const provider = fakeProvider({ opening: 'You have 412 items running short across 9 sites.' });

  const brief = await briefService.buildBrief(db, workspace.workspaceId, { provider });
  assert.equal(brief.source, 'deterministic');
  assert.ok(!brief.body.includes('412'));
});

test('a grounded model opening is kept, with the detail still beneath it', async () => {
  const { db, workspace, items } = withStockout();
  const provider = fakeProvider({
    opening: `There is 1 thing to deal with today: ${items[0].title} at ${items[0].metrics.onHand} on hand.`,
  });

  const brief = await briefService.buildBrief(db, workspace.workspaceId, { provider });
  assert.equal(brief.source, 'model');
  assert.match(brief.body, /Start with/, 'the deterministic detail is not replaced');
});

test('a stored brief is only reused while it still describes the findings', async () => {
  const { db, workspace, scenario } = withStockout();
  const items = attention.listAttention(db, workspace.workspaceId);
  await briefService.buildBrief(db, workspace.workspaceId, { items, deterministicOnly: true });

  assert.ok(briefService.currentBrief(db, workspace.workspaceId, items), 'fresh brief is reused');

  const engine = require('../../src/domain/inventory-engine');
  engine.receive(db, workspace.ctx, { skuId: scenario.skuId, locationId: workspace.main.id, quantity: 500 });
  attention.evaluate(db, workspace.workspaceId, { trigger: 'after' });

  const now = attention.listAttention(db, workspace.workspaceId);
  assert.equal(briefService.currentBrief(db, workspace.workspaceId, now), null, 'stale brief is not shown');
});

// --- asking questions --------------------------------------------------------

test('a plan can only ever reach a supported lookup', () => {
  const wild = queryService.normalisePlan({
    intent: "'; DROP TABLE movements; --",
    windowDays: 99999,
    limit: 100000,
    entityQuery: 'x'.repeat(500),
  });
  assert.equal(wild.intent, 'unsupported');
  assert.equal(wild.windowDays, 365);
  assert.equal(wild.limit, queryService.MAX_ROWS);
  assert.equal(wild.entityQuery.length, 120);
});

test('a question about stock is answered from the ledger', async () => {
  const { db, workspace } = withStockout();
  const provider = fakeProvider({
    intent: 'stock_level',
    entityQuery: 'navy oxford',
    locationQuery: '',
    windowDays: 30,
    limit: 10,
    unsupportedReason: '',
  });

  const result = await queryPlanner.ask(db, workspace.workspaceId, 'How many navy oxfords do we have?', { provider });
  assert.equal(result.plan.intent, 'stock_level');
  assert.equal(result.rows[0].onHand, 10);
  assert.match(result.answer, /10/);
});

test('a question Foundry cannot answer is answered honestly', async () => {
  const { db, workspace } = withStockout();
  const provider = fakeProvider({
    intent: 'unsupported',
    entityQuery: '',
    locationQuery: '',
    windowDays: 30,
    limit: 10,
    unsupportedReason: 'Foundry does not track supplier pricing.',
  });

  const result = await queryPlanner.ask(db, workspace.workspaceId, 'What did we pay for these?', { provider });
  assert.equal(result.supported, false);
  assert.match(result.answer, /supplier pricing/);
  assert.equal(result.rows.length, 0);
});

test('an unparseable plan degrades to unsupported, never to a guess', async () => {
  const { db, workspace } = withStockout();
  const provider = fakeProvider({ intent: 'stock_level' }); // missing required fields

  const result = await queryPlanner.ask(db, workspace.workspaceId, 'anything', { provider });
  assert.equal(result.plan.intent, 'unsupported');
  assert.equal(result.supported, false);
});

test('a product is found by the words a person would use', () => {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  scenarios.configure(db, workspace.workspaceId);
  const itemService = require('../../src/domain/item-service');
  const repo = require('../../src/domain/repository');
  const item = itemService.createItem(db, workspace.ctx, {
    name: 'Brass Gate Valve 22mm',
    baseCode: 'BGV-22',
    trackingMode: 'quantity',
  });
  const sku = repo.listSkusForItem(db, workspace.workspaceId, item.itemId)[0];
  require('../../src/domain/inventory-engine').receive(db, workspace.ctx, {
    skuId: sku.id,
    locationId: workspace.main.id,
    quantity: 40,
  });

  for (const phrasing of ['brass gate valves', 'gate valve', 'valves', 'BGV-22', 'Brass Gate Valve 22mm']) {
    const found = queryService.resolveSkus(db, workspace.workspaceId, phrasing, 10);
    assert.equal(found.length, 1, `"${phrasing}" should find it`);
    assert.equal(found[0].id, sku.id);
  }

  // Still strict: every word has to be there.
  assert.equal(queryService.resolveSkus(db, workspace.workspaceId, 'copper gate valve', 10).length, 0);
  assert.equal(queryService.resolveSkus(db, workspace.workspaceId, 'jetpack', 10).length, 0);
});

test('a question about something that does not exist says so', async () => {
  const { db, workspace } = withStockout();
  const provider = fakeProvider({
    intent: 'stock_level',
    entityQuery: 'jetpacks',
    locationQuery: '',
    windowDays: 30,
    limit: 10,
    unsupportedReason: '',
  });

  const result = await queryPlanner.ask(db, workspace.workspaceId, 'How many jetpacks?', { provider });
  assert.match(result.answer, /could not find/);
  assert.equal(result.rows.length, 0);
});

test('answering never writes anything', async () => {
  const { db, workspace } = withStockout();
  const before = db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n;

  for (const intent of queryService.INTENTS) {
    queryService.execute(db, workspace.workspaceId, { intent, entityQuery: '', windowDays: 30, limit: 5 });
  }

  const after = db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n;
  assert.equal(after, before);
  assert.equal(require('../../src/domain/inventory-engine').verifyIntegrity(db, workspace.workspaceId).ok, true);
});

test('a question is scoped to the asker\'s workspace', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Acme' });
  const b = seedWorkspace(db, { workspaceName: 'Beacon' });
  scenarios.stockoutScenario(db, a);
  scenarios.configure(db, b.workspaceId);

  const mine = queryService.execute(db, b.workspaceId, { intent: 'stock_level', entityQuery: 'Navy Oxford' });
  assert.equal(mine.rows.length, 0, "another workspace's stock is invisible");

  const theirs = queryService.execute(db, a.workspaceId, { intent: 'stock_level', entityQuery: 'Navy Oxford' });
  assert.equal(theirs.rows.length, 1);
});

// --- feedback ----------------------------------------------------------------

test('acknowledging keeps the item, dismissing hides it for a while', () => {
  const { db, workspace, items } = withStockout();
  const id = items[0].attentionId;

  feedback.acknowledge(db, { workspaceId: workspace.workspaceId, userId: workspace.ownerId }, id);
  assert.equal(attention.getAttention(db, workspace.workspaceId, id).status, 'ACKNOWLEDGED');
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1, 'still on the briefing');

  feedback.dismiss(db, { workspaceId: workspace.workspaceId, userId: workspace.ownerId }, id, { days: 7 });
  assert.equal(attention.getAttention(db, workspace.workspaceId, id).status, 'DISMISSED');
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 0, 'off the briefing');
});

test('a dismissal survives re-evaluation until it expires', () => {
  const { db, workspace, items } = withStockout();
  const id = items[0].attentionId;
  feedback.dismiss(db, { workspaceId: workspace.workspaceId, userId: workspace.ownerId }, id, { days: 14 });

  attention.evaluate(db, workspace.workspaceId, { trigger: 'again' });
  assert.equal(attention.getAttention(db, workspace.workspaceId, id).status, 'DISMISSED');

  // Wind the expiry back; the next run brings it back on its own.
  db.prepare('UPDATE attention_items SET dismissed_until = ? WHERE id = ?').run(
    new Date(Date.now() - 86400000).toISOString(),
    id
  );
  attention.evaluate(db, workspace.workspaceId, { trigger: 'after-expiry' });
  assert.equal(attention.getAttention(db, workspace.workspaceId, id).status, 'OPEN');
});

test('feedback is recorded and changes no rule', () => {
  const { db, workspace, items } = withStockout();
  const id = items[0].attentionId;
  const before = require('../../src/attention/policy').THRESHOLDS.stockout.watchDays;

  feedback.rate(db, { workspaceId: workspace.workspaceId, userId: workspace.ownerId }, id, 'not_useful', { note: 'we always run this low' });

  const history = feedback.listFeedback(db, workspace.workspaceId, id);
  assert.equal(history.length, 1);
  assert.equal(history[0].verdict, 'not_useful');
  assert.equal(history[0].note, 'we always run this low');
  assert.equal(require('../../src/attention/policy').THRESHOLDS.stockout.watchDays, before);

  // Still detected: an opinion is recorded, not applied.
  attention.evaluate(db, workspace.workspaceId, { trigger: 'after-feedback' });
  assert.equal(attention.listAttention(db, workspace.workspaceId).length, 1);

  const rollup = feedback.usefulnessByCategory(db, workspace.workspaceId);
  assert.equal(rollup[0].category, 'stockout_risk');
  assert.equal(rollup[0].notUseful, 1);
});

test('feedback cannot reach another workspace\'s item', () => {
  const { db } = makeDatabase();
  const a = seedWorkspace(db, { workspaceName: 'Acme' });
  const b = seedWorkspace(db, { workspaceName: 'Beacon' });
  scenarios.stockoutScenario(db, a);
  attention.evaluate(db, a.workspaceId, { trigger: 'test' });
  const [item] = attention.listAttention(db, a.workspaceId);

  assert.throws(
    () => feedback.acknowledge(db, { workspaceId: b.workspaceId, userId: b.ownerId }, item.attentionId),
    /could not be found/
  );
  assert.equal(attention.getAttention(db, a.workspaceId, item.attentionId).status, 'OPEN');
});
