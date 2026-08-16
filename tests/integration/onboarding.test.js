'use strict';

/**
 * Onboarding and takeover.
 *
 * The properties that matter here are the ones a migration can quietly get
 * wrong: totals that do not reconcile being reported as success, a conflict
 * resolved by a coin toss, the same file imported twice, or a location spelled
 * three ways becoming three warehouses.
 *
 * Every assertion below is deterministic. The AI mapping layer is not needed —
 * the deterministic column recognition carries these files on its own, which is
 * exactly what it has to do for a migration to be trustworthy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const paths = require('../../src/onboarding/paths');
const sourceService = require('../../src/onboarding/source-service');
const consolidation = require('../../src/onboarding/consolidation-service');
const migration = require('../../src/onboarding/migration-service');
const registry = require('../../src/onboarding/connectors/registry');
const authService = require('../../src/domain/auth-service');
const repo = require('../../src/domain/repository');
const engine = require('../../src/domain/inventory-engine');
const attention = require('../../src/attention/attention-engine');
const { makeDatabase, cleanupAll, seedWorkspace, seedAnotherWorkspace } = require('../helpers');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db, { workspaceName: 'Migrating Co' });
  const membership = authService.getMembership(db, workspace.workspaceId, workspace.accountId);
  // A migrating workspace starts with no locations of its own; the files decide.
  db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
  return { db, workspace, membership, ctx: workspace.ctx };
}

const csv = (lines) => lines.join('\n');

/** The customer's main export: products, variants, locations, quantities. */
const MAIN = csv([
  'Exported 14 August 2026,,,,',
  ',,,,',
  'Item Code,Description,Colour,Size,Warehouse,Qty On Hand',
  'OX-1002,Navy Oxford,Navy,8,Brooklyn Warehouse,18',
  'OX-1002,Navy Oxford,Navy,9,Brooklyn Warehouse,12',
  'OX-1003,White Oxford,White,8,Brooklyn Warehouse,20',
  'CH-2001,Coastal Chino,Stone,32,New Jersey Warehouse,24',
]);

function addSource(env, name, text) {
  return sourceService.addSource(env.db, env.ctx, env.membership, {
    text,
    filename: name,
  }).source;
}

// --- choosing a path ---------------------------------------------------------

test('a new inventory starts by asking how it is managed today', () => {
  const env = setup();
  const state = paths.ensure(env.db, env.workspace.workspaceId);

  assert.equal(state.path, 'undecided');
  assert.equal(state.status, 'choosing');
  assert.deepEqual(paths.PATH_IDS, ['fresh', 'spreadsheet', 'software', 'messy']);
});

test('choosing a path routes to the right place and is remembered', () => {
  const env = setup();
  assert.equal(paths.choose(env.db, env.workspace.workspaceId, 'spreadsheet').step, '/onboarding/files');
  assert.equal(paths.get(env.db, env.workspace.workspaceId).status, 'collecting');

  // Starting fresh goes straight to the Mission 2 experience, unchanged.
  assert.equal(paths.choose(env.db, env.workspace.workspaceId, 'fresh').step, '/foundry/describe');
  assert.equal(paths.get(env.db, env.workspace.workspaceId).status, 'understanding');
});

test('a description picks a path, most specific wins', () => {
  const cases = [
    ["it's all in excel", 'spreadsheet'],
    ['we use NetSuite today', 'software'],
    ['spreadsheets all over the place, several files', 'messy'],
    ['nothing yet, just started the business', 'fresh'],
  ];
  for (const [description, expected] of cases) {
    const result = paths.recommendFromDescription(description);
    assert.ok(result, `no recommendation for "${description}"`);
    assert.equal(result.path, expected, `"${description}" should suggest ${expected}`);
    assert.ok(result.reason, 'a recommendation without a reason is a guess');
  }
  assert.equal(paths.recommendFromDescription('hello'), null);
});

// --- understanding a spreadsheet ---------------------------------------------

test('Foundry reads the file and reports what it found', () => {
  const env = setup();
  const source = addSource(env, 'warehouse.csv', MAIN);
  const sheet = source.profile.sheets[source.profile.primarySheetIndex];

  assert.equal(source.inferredPurpose, 'inventory');
  assert.equal(sheet.detectedType, 'variant_inventory');
  assert.equal(sheet.totals.rows, 4);
  assert.equal(sheet.totals.units, 74);
  assert.deepEqual(sheet.axes.map((axis) => axis.axis), ['Colour', 'Size']);
  assert.deepEqual(
    sheet.totals.locations.map((location) => location.name).sort(),
    ['Brooklyn Warehouse', 'New Jersey Warehouse']
  );
  // The file dated itself, so Foundry knows how old it is.
  assert.equal(source.observedAt, '2026-08-14');
  assert.match(source.freshnessBasis, /Exported 14 August 2026/);
});

test('the same file uploaded twice is recognised, not doubled', () => {
  const env = setup();
  const first = sourceService.addSource(env.db, env.ctx, env.membership, { text: MAIN, filename: 'warehouse.csv' });
  const again = sourceService.addSource(env.db, env.ctx, env.membership, { text: MAIN, filename: 'warehouse.csv' });

  assert.equal(first.alreadyPresent, false);
  assert.equal(again.alreadyPresent, true);
  assert.equal(again.source.id, first.source.id);
  assert.equal(sourceService.list(env.db, env.workspace.workspaceId).length, 1);
});

test('a macro-enabled workbook is refused rather than opened', () => {
  const env = setup();
  assert.throws(
    () => sourceService.addSource(env.db, env.ctx, env.membership, {
      buffer: Buffer.from('anything'), filename: 'books.xlsm',
    }),
    /does not open macro-enabled workbooks/
  );
});

// --- one clean file ----------------------------------------------------------

test('a single spreadsheet migrates and reconciles', async () => {
  const env = setup();
  addSource(env, 'warehouse.csv', MAIN);

  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  assert.equal(plan.status, 'READY', 'a clean file needs no decisions');
  assert.deepEqual(plan.proposedLocations.sort(), ['Brooklyn Warehouse', 'New Jersey Warehouse']);
  assert.equal(plan.expectedTotals.units, 74);
  assert.equal(plan.expectedTotals.products, 3);

  const { run } = await migration.migrate(env.db, env.ctx, env.membership, plan.id);

  assert.equal(run.status, 'VERIFIED', JSON.stringify(run.reconciliation && run.reconciliation.discrepancies));
  assert.equal(run.reconciliation.verified, true);
  assert.equal(run.reconciliation.observed.units, 74);
  assert.equal(run.reconciliation.observed.products, 3);
  assert.equal(run.reconciliation.observed.locations, 2);

  // The stock is real, and it arrived through the ledger.
  const units = env.db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
    .get(env.workspace.workspaceId).n;
  assert.equal(units, 74);
  assert.equal(engine.verifyIntegrity(env.db, env.workspace.workspaceId).ok, true);

  const receipts = env.db
    .prepare("SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ? AND operation = 'receive'")
    .get(env.workspace.workspaceId).n;
  assert.ok(receipts > 0, 'opening stock must exist as real movements');

  // One product with two sizes, not two products.
  const navy = env.db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND base_code = ?')
    .get(env.workspace.workspaceId, 'OX-1002');
  assert.ok(navy);
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM skus WHERE item_id = ?').get(navy.id).n,
    2
  );
  assert.equal(paths.get(env.db, env.workspace.workspaceId).status, 'ready');
});

test('running the same migration twice does not import twice', async () => {
  const env = setup();
  addSource(env, 'warehouse.csv', MAIN);
  const plan = migration.buildPlan(env.db, env.ctx, env.membership);

  const first = await migration.migrate(env.db, env.ctx, env.membership, plan.id);
  const second = await migration.migrate(env.db, env.ctx, env.membership, plan.id);

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.run.id, first.run.id);
  assert.equal(
    env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
      .get(env.workspace.workspaceId).n,
    74
  );
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    3
  );
});

test('after migrating, Foundry does not invent a demand history', async () => {
  const env = setup();
  addSource(env, 'warehouse.csv', MAIN);
  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  await migration.migrate(env.db, env.ctx, env.membership, plan.id);

  // Opening balances are receipts, not sales. Nothing has been issued, so no
  // usage rate can honestly be estimated and no stockout may be predicted.
  const signalEngine = require('../../src/signals/signal-engine');
  for (const sku of signalEngine.skuSignals(env.db, env.workspace.workspaceId)) {
    assert.equal(sku.estimated.hasUsageEvidence, false, `${sku.displayName} should have no usage evidence yet`);
    assert.equal(sku.estimated.averageDailyUsage, null);
  }
  const risks = attention
    .listAttention(env.db, env.workspace.workspaceId)
    .filter((item) => item.category === 'stockout_risk');
  assert.equal(risks.length, 0, 'a freshly migrated inventory cannot have a measured stockout risk');
});

// --- several files that disagree ---------------------------------------------

const COUNT = csv([
  'Physical count 20 August 2026,,,',
  'SKU,Location,Colour,Size,Counted',
  'OX-1002,Brooklyn Whse,Navy,8,14',
  'OX-1003,Brooklyn Whse,White,8,20',
]);

const OLD_PRODUCTS = csv([
  'Item Code,Description',
  'OX-1002,Oxford Navy',
  'SH-9000,Discontinued Sandal',
]);

test('overlapping files surface real conflicts and normalise the rest', () => {
  const env = setup();
  addSource(env, 'inventory-main.csv', MAIN);
  addSource(env, 'physical-count.csv', COUNT);
  addSource(env, 'old-products.csv', OLD_PRODUCTS);

  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  const conflicts = migration.conflictsFor(env.db, env.workspace.workspaceId, plan.id);

  // "Brooklyn Whse" and "Brooklyn Warehouse" are one place. Nobody is asked.
  const naming = conflicts.filter((c) => c.kind === 'location_naming');
  assert.equal(naming.length, 1);
  assert.equal(naming[0].severity, 'resolved_automatically');
  assert.equal(plan.proposedLocations.includes('Brooklyn Warehouse'), true);
  assert.equal(plan.proposedLocations.includes('Brooklyn Whse'), false);

  // Same SKU, two descriptions: one product, and Foundry says which name.
  const naming2 = conflicts.filter((c) => c.kind === 'same_product_different_names');
  assert.ok(naming2.length >= 1);
  assert.ok(naming2.some((c) => /OX-1002/.test(c.subject)));

  // 18 against 14 for the same product in the same place is a real conflict.
  const quantity = conflicts.filter((c) => c.kind === 'quantity_conflict');
  assert.equal(quantity.length, 1);
  assert.match(quantity[0].subject, /Navy Oxford/);
  assert.equal(quantity[0].options.length, 2);
  // The count is dated later, so Foundry recommends it — and says why.
  assert.ok(quantity[0].recommendedOption);
  assert.match(quantity[0].recommendationReason, /2026-08-20|physical count/i);

  assert.equal(plan.status, 'AWAITING_DECISIONS');
});

test('an undecided blocking conflict stops the migration', async () => {
  const env = setup();
  // Two files that disagree, neither dated, so nothing recommends a winner.
  addSource(env, 'a.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,18']));
  addSource(env, 'b.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,14']));

  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  const conflicts = migration.conflictsFor(env.db, env.workspace.workspaceId, plan.id);
  const quantity = conflicts.find((c) => c.kind === 'quantity_conflict');

  assert.ok(quantity, 'the disagreement must be reported');
  assert.equal(quantity.severity, 'blocking');
  assert.equal(quantity.recommendedOption, null, 'Foundry must not pick a stock figure on its own');

  await assert.rejects(
    () => migration.migrate(env.db, env.ctx, env.membership, plan.id),
    /need a decision before Foundry can take this inventory over/
  );
  assert.equal(
    env.db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(env.workspace.workspaceId).n,
    0
  );
});

test('deciding the conflicts lets the migration run', async () => {
  const env = setup();
  addSource(env, 'a.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,18']));
  addSource(env, 'b.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,14']));

  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  const quantity = migration
    .conflictsFor(env.db, env.workspace.workspaceId, plan.id)
    .find((c) => c.kind === 'quantity_conflict');

  const decided = migration.decide(env.db, env.ctx, env.membership, quantity.id, quantity.options[0].id);
  assert.equal(decided.decision, quantity.options[0].id);
  assert.equal(migration.getPlan(env.db, env.workspace.workspaceId, plan.id).status, 'READY');

  const { run } = await migration.migrate(env.db, env.ctx, env.membership, plan.id);
  assert.ok(['VERIFIED', 'MISMATCHED'].includes(run.status));
  assert.equal(run.result.conflictsReviewed >= 1, true);
});

test('a decision has to be one of the options offered', () => {
  const env = setup();
  addSource(env, 'a.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,18']));
  addSource(env, 'b.csv', csv(['SKU,Location,Qty', 'OX-1002,Brooklyn,14']));
  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  const conflict = migration.conflictsFor(env.db, env.workspace.workspaceId, plan.id)[0];

  assert.throws(
    () => migration.decide(env.db, env.ctx, env.membership, conflict.id, 'whatever-i-like'),
    /not one of the options/
  );
});

test('accepting the recommendations settles only what Foundry recommended', () => {
  const env = setup();
  addSource(env, 'inventory-main.csv', MAIN);
  addSource(env, 'physical-count.csv', COUNT);
  const plan = migration.buildPlan(env.db, env.ctx, env.membership);

  const result = migration.acceptRecommendations(env.db, env.ctx, env.membership, plan.id);
  assert.ok(result.accepted >= 1);
  // Anything Foundry had no recommendation for is still waiting for a person.
  for (const conflict of migration.conflictsFor(env.db, env.workspace.workspaceId, plan.id, { onlyOpen: true })) {
    assert.equal(conflict.recommendedOption, null);
  }
});

// --- reconciliation honesty ---------------------------------------------------

test('a migration whose totals disagree is not reported as verified', async () => {
  const env = setup();
  // A row with an unreadable quantity: the file says 30 units exist, and one of
  // them cannot be imported. The arithmetic must not be allowed to pass.
  addSource(env, 'partly-broken.csv', csv([
    'SKU,Location,Qty',
    'OX-1002,Brooklyn,18',
    'OX-1003,Brooklyn,call the office',
  ]));

  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  const { run } = await migration.migrate(env.db, env.ctx, env.membership, plan.id);

  assert.equal(run.status, 'MISMATCHED');
  assert.equal(run.verified, false);
  assert.ok(run.reconciliation.discrepancies.length > 0);
  assert.match(run.reconciliation.discrepancies.join(' '), /not imported/);
});

// --- source of truth and connectors -------------------------------------------

test('every inventory says which system owns its truth, and defaults to Foundry', () => {
  const env = setup();
  assert.equal(paths.sourceOfTruth(env.db, env.workspace.workspaceId), 'FOUNDRY_NATIVE');
  assert.equal(paths.isFoundryNative(env.db, env.workspace.workspaceId), true);
});

test('an inventory cannot claim an external owner with nothing connected', () => {
  const env = setup();
  assert.throws(
    () => paths.setSourceOfTruth(env.db, env.workspace.workspaceId, 'EXTERNAL_CONNECTED'),
    /once a connector to it is actually connected/
  );
  assert.equal(paths.sourceOfTruth(env.db, env.workspace.workspaceId), 'FOUNDRY_NATIVE');
});

test('Foundry ships no pretend integrations', () => {
  // The registry is the architecture. A connector appears in it when one really
  // exists, and an empty list is the honest state today.
  assert.deepEqual(registry.available(), []);
  assert.throws(() => registry.get('netsuite'), /Export your inventory to CSV or Excel/);
});

test('a read-only connected system gets a recommendation, never a false success', () => {
  const env = setup();
  const { nowIso } = require('../../src/lib/util');

  registry.register({
    key: 'test-readonly',
    displayName: 'Read Only System',
    capabilities: [registry.CAPABILITIES.READ_BALANCES, registry.CAPABILITIES.READ_CATALOG],
    create: () => ({ readBalances: () => [] }),
  });
  env.db.prepare(
    `INSERT INTO workspace_connectors (id, workspace_id, connector_key, display_name, status, capabilities, created_at, updated_at)
     VALUES ('conn_test', ?, 'test-readonly', 'Read Only System', 'connected', ?, ?, ?)`
  ).run(env.workspace.workspaceId, JSON.stringify(['read_balances', 'read_catalog']), nowIso(), nowIso());

  paths.setSourceOfTruth(env.db, env.workspace.workspaceId, 'EXTERNAL_CONNECTED');

  const verdict = registry.canPerform(env.db, env.workspace.workspaceId, 'transfer');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.readOnly, true);
  assert.match(verdict.because, /read-only/);
  assert.match(verdict.because, /done in your existing system/);
  registry.reset();
});

test('a connector cannot claim a capability that is not in the vocabulary', () => {
  assert.throws(
    () => registry.register({ key: 'bad', displayName: 'Bad', capabilities: ['do_anything'], create: () => ({}) }),
    /Unknown connector capabilities/
  );
  assert.throws(
    () => registry.register({ key: 'no-impl', displayName: 'No', capabilities: [] }),
    /needs a create\(\)/
  );
  registry.reset();
});

// --- isolation ----------------------------------------------------------------

test('files, plans and onboarding state never cross between inventories', async () => {
  const env = setup();
  addSource(env, 'warehouse.csv', MAIN);
  const plan = migration.buildPlan(env.db, env.ctx, env.membership);
  await migration.migrate(env.db, env.ctx, env.membership, plan.id);

  const other = seedAnotherWorkspace(env.db, env.workspace.accountId, 'Separate Co');

  assert.equal(sourceService.list(env.db, other.workspaceId).length, 0);
  assert.equal(migration.latestPlan(env.db, other.workspaceId), null);
  assert.equal(migration.latestRun(env.db, other.workspaceId), null);
  assert.throws(() => migration.getPlan(env.db, other.workspaceId, plan.id), /not in this inventory/);
  assert.equal(
    env.db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
      .get(other.workspaceId).n,
    0
  );
  // Each inventory decides its own onboarding independently.
  assert.equal(paths.get(env.db, other.workspaceId), null);
});
