'use strict';

/**
 * The contract from understanding to applied configuration: plan integrity,
 * decision persistence, safe application, idempotency, tenancy, and the
 * standing guarantee that the intelligence layer cannot move stock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const understandingService = require('../../src/foundry/understanding-service');
const planBuilder = require('../../src/foundry/plan-builder');
const planApplier = require('../../src/foundry/plan-applier');
const { PLAN_SCHEMA, verifyPlanIntegrity, computeIntegrityHash } = require('../../src/foundry/plan-schema');
const { validate } = require('../../src/foundry/validator');
const { createVocabulary } = require('../../src/foundry/terminology');
const engine = require('../../src/domain/inventory-engine');
const repo = require('../../src/domain/repository');
const { openDatabase } = require('../../src/db');
const {
  makeDatabase,
  cleanupAll,
  seedWorkspace,
  makeQuantityItem,
} = require('../helpers');
const {
  fakeProvider,
  fakeUnderstandingProvider,
  buildUnderstanding,
  buildQuestion,
} = require('../helpers/fake-provider');

test.after(cleanupAll);

const VARIANT_UNDERSTANDING = buildUnderstanding({
  businessDescription: "We wholesale children's shoes in styles, colors and sizes across two warehouses.",
  inventoryArchetypes: ['quantity', 'variant'],
  variantDimensions: [
    { name: 'Color', exampleValues: ['Navy', 'Cream'] },
    { name: 'Size', exampleValues: ['4', '5', '6'] },
  ],
  locationModel: { summary: 'Two warehouses.', multipleLocations: true, transfersExpected: true, certainty: 'inferred_confidently' },
  likelyLocations: [
    { name: 'Brooklyn Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' },
    { name: 'New Jersey Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' },
  ],
  terminology: { item: 'Product', location: 'Warehouse', serialUnit: '', lot: '', variant: '' },
  recommendedConfiguration: {
    trackingMode: 'quantity',
    usesVariants: true,
    allowNegativeStock: false,
    summary: 'Each colour and size combination is counted separately at each warehouse.',
  },
});

async function understand(db, workspace, payload = VARIANT_UNDERSTANDING) {
  const { id } = await understandingService.describeBusiness(
    db,
    workspace.ctx,
    payload.businessDescription,
    { provider: fakeUnderstandingProvider(payload) }
  );
  return id;
}

async function setup(payload) {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const understandingId = await understand(store.db, workspace, payload);
  return { ...store, workspace, understandingId };
}

test('a plan is built from the understanding and sealed with an integrity hash', async () => {
  const { db, workspace, understandingId } = await setup();
  const { planId, plan } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });

  assert.equal(validate(PLAN_SCHEMA, plan, { key: 'plan-test' }).ok, true);
  assert.equal(plan.workspaceId, workspace.workspaceId);
  assert.equal(plan.configurationVersion, 1);
  assert.equal(plan.inventoryModel.usesVariants, true);
  assert.deepEqual(plan.trackingModes, ['quantity']);
  assert.deepEqual(plan.variantDimensions.map((d) => d.name), ['Color', 'Size']);
  assert.deepEqual(plan.locations.map((l) => l.name), ['Brooklyn Warehouse', 'New Jersey Warehouse']);
  assert.equal(plan.operationalDefaults.adjustmentsRequireReason, true);
  assert.equal(verifyPlanIntegrity(plan), true);

  const row = db.prepare('SELECT * FROM foundry_plans WHERE id = ?').get(planId);
  assert.equal(row.status, 'proposed');
  assert.equal(row.integrity_hash, plan.integrityHash);
});

test('the integrity hash is stable and detects any tampering', async () => {
  const { db, workspace, understandingId } = await setup();
  const { plan } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });

  assert.equal(computeIntegrityHash(plan), computeIntegrityHash({ ...plan, integrityHash: 'x' }),
    'the hash covers the plan, not itself');

  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.locations.push({ name: 'Somewhere Else', kind: 'warehouse' });
  assert.equal(verifyPlanIntegrity(tampered), false);

  const reordered = { ...plan, locations: [...plan.locations] };
  assert.equal(verifyPlanIntegrity(reordered), true, 'key order must not change the hash');
});

test('applying a plan configures structure and nothing else', async () => {
  const { db, workspace, understandingId } = await setup();
  const { planId } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });

  const before = {
    items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n,
    skus: db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(workspace.workspaceId).n,
    movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n,
    balances: db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspace.workspaceId).n,
  };

  const summary = planApplier.applyPlan(db, workspace.ctx, planId);

  assert.equal(summary.alreadyApplied, false);
  assert.deepEqual(summary.locationsCreated.map((l) => l.name), ['Brooklyn Warehouse', 'New Jersey Warehouse']);

  const locations = repo.listLocations(db, workspace.workspaceId).map((l) => l.name);
  assert.ok(locations.includes('Brooklyn Warehouse'));
  assert.ok(locations.includes('New Jersey Warehouse'));

  // Real inventory records must come from the customer, never from Foundry.
  const after = {
    items: db.prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ?').get(workspace.workspaceId).n,
    skus: db.prepare('SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ?').get(workspace.workspaceId).n,
    movements: db.prepare('SELECT COUNT(*) AS n FROM movements WHERE workspace_id = ?').get(workspace.workspaceId).n,
    balances: db.prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?').get(workspace.workspaceId).n,
  };
  assert.deepEqual(after, before, 'no item, SKU, movement or unit of stock may be invented');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id = ?').get(workspace.workspaceId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM lots WHERE workspace_id = ?').get(workspace.workspaceId).n, 0);
});

test('applying the same plan twice changes nothing the second time', async () => {
  const { db, workspace, understandingId } = await setup();
  const { planId } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });

  const first = planApplier.applyPlan(db, workspace.ctx, planId);
  const locationsAfterFirst = repo.listLocations(db, workspace.workspaceId).length;

  const second = planApplier.applyPlan(db, workspace.ctx, planId);
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.alreadyApplied, true);
  assert.equal(repo.listLocations(db, workspace.workspaceId).length, locationsAfterFirst);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM foundry_plans WHERE status = 'applied'").get().n, 1);
});

test('a location that already exists is not duplicated', async () => {
  const { db, workspace, understandingId } = await setup();
  // seedWorkspace already made "Main Warehouse"; add one the plan also wants.
  require('../../src/domain/location-service').createLocation(db, workspace.ctx, {
    name: 'Brooklyn Warehouse',
    kind: 'store',
  });

  const { planId } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });
  const summary = planApplier.applyPlan(db, workspace.ctx, planId);

  assert.deepEqual(summary.locationsAlreadyPresent, ['Brooklyn Warehouse']);
  assert.deepEqual(summary.locationsCreated.map((l) => l.name), ['New Jersey Warehouse']);
  assert.equal(
    repo.listLocations(db, workspace.workspaceId).filter((l) => l.name === 'Brooklyn Warehouse').length,
    1
  );
});

test('a plan altered after it was proposed is refused', async () => {
  const { db, workspace, understandingId } = await setup();
  const { planId, plan } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });

  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.locations.push({ name: 'Injected Warehouse', kind: 'warehouse' });
  db.prepare('UPDATE foundry_plans SET payload = ? WHERE id = ?').run(JSON.stringify(tampered), planId);

  assert.throws(
    () => planApplier.applyPlan(db, workspace.ctx, planId),
    (err) => err.code === 'plan_integrity_failed'
  );
  assert.equal(
    repo.listLocations(db, workspace.workspaceId).some((l) => l.name === 'Injected Warehouse'),
    false
  );
});

test('customer decisions and delegated decisions are both persisted', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const understandingId = await understand(
    store.db,
    workspace,
    buildUnderstanding({
      unresolvedDecisions: [
        buildQuestion({ id: 'negative_stock' }),
        buildQuestion({ id: 'second_question', recommendedOptionId: 'no' }),
      ],
    })
  );

  const { planId, plan } = planBuilder.buildPlan(store.db, workspace.ctx, {
    understandingId,
    answers: { negative_stock: 'yes' }, // second question is delegated
  });

  assert.equal(plan.customerDecisions.length, 1);
  assert.equal(plan.customerDecisions[0].questionId, 'negative_stock');
  assert.equal(plan.customerDecisions[0].answerId, 'yes');

  assert.equal(plan.foundryDecisions.length, 1);
  assert.equal(plan.foundryDecisions[0].questionId, 'second_question');
  assert.ok(plan.foundryDecisions[0].because, 'a delegated decision records why');

  const rows = planBuilder.listDecisions(store.db, workspace.workspaceId, planId);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.decided_by).sort(), ['customer', 'foundry']);

  // The customer's answer actually moved the configuration lever.
  assert.equal(plan.operationalDefaults.allowNegativeStock, true);
});

test('an answer with no configuration effect is recorded but changes nothing', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const understandingId = await understand(
    store.db,
    workspace,
    buildUnderstanding({
      unresolvedDecisions: [
        buildQuestion({
          id: 'reservations',
          options: [
            { id: 'yes', label: 'Yes', consequence: 'Stock can be committed to orders.', effect: 'none' },
            { id: 'no', label: 'No', consequence: 'Stock reduces only when it leaves.', effect: 'none' },
          ],
          recommendedOptionId: 'no',
        }),
      ],
    })
  );

  const { plan } = planBuilder.buildPlan(store.db, workspace.ctx, {
    understandingId,
    answers: { reservations: 'yes' },
  });

  assert.equal(plan.customerDecisions.length, 1);
  assert.equal(plan.operationalDefaults.allowNegativeStock, false);
  assert.equal(plan.operationalDefaults.adjustmentsRequireReason, true);
});

test('accepted recommendations are recorded on the plan', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const understandingId = await understand(
    store.db,
    workspace,
    buildUnderstanding({
      recommendations: [
        {
          title: 'Keep manufacturer style numbers',
          noticed: 'You referred to styles by supplier code.',
          recommendation: 'Store the supplier code alongside your own.',
          whyItMatters: 'Receiving against a supplier packing list gets much faster.',
          scope: 'configuration',
          confidence: 'high',
        },
      ],
    })
  );

  const [rec] = understandingService.listRecommendations(store.db, workspace.workspaceId, understandingId);
  const { planId, plan } = planBuilder.buildPlan(store.db, workspace.ctx, {
    understandingId,
    acceptedRecommendationIds: [rec.id],
  });

  assert.deepEqual(plan.acceptedRecommendations, [
    { title: 'Keep manufacturer style numbers', scope: 'configuration' },
  ]);
  const stored = store.db.prepare('SELECT * FROM foundry_recommendations WHERE id = ?').get(rec.id);
  assert.equal(stored.status, 'accepted');
  assert.equal(stored.plan_id, planId);
});

test('terminology is applied to presentation only', async () => {
  const { db, workspace, understandingId } = await setup();
  const { planId, plan } = planBuilder.buildPlan(db, workspace.ctx, { understandingId });
  planApplier.applyPlan(db, workspace.ctx, planId);

  assert.equal(plan.terminology.item, 'Product');
  assert.equal(plan.terminology.location, 'Warehouse');

  const configuration = planApplier.getConfiguration(db, workspace.workspaceId);
  const vocabulary = createVocabulary(configuration.terminology);
  assert.equal(vocabulary.term('location'), 'Warehouse');
  assert.equal(vocabulary.term('location', { plural: true }), 'Warehouses');
  assert.equal(vocabulary.term('item'), 'Product');
  assert.equal(vocabulary.term('lot'), 'Lot', 'unset terms keep Foundry defaults');
  assert.equal(vocabulary.isCustomised, true);

  // The engine's own vocabulary is untouched: the tables and columns are the same.
  const item = makeQuantityItem(db, workspace.ctx);
  assert.ok(repo.requireItem(db, workspace.workspaceId, item.itemId));
  const columns = db.prepare('PRAGMA table_info(locations)').all().map((c) => c.name);
  assert.ok(columns.includes('name') && columns.includes('kind'));
});

test('a term identical to the default is not treated as a rename', () => {
  const terminology = planBuilder.normaliseTerminology({
    item: 'Item',
    location: 'location',
    serialUnit: 'Asset',
    lot: '  ',
    variant: null,
  });
  assert.equal(terminology.item, null);
  assert.equal(terminology.location, null);
  assert.equal(terminology.serialUnit, 'Asset');
  assert.equal(terminology.lot, null);
});

test('configuration and plans are invisible across workspaces', async () => {
  const store = makeDatabase();
  const a = seedWorkspace(store.db, { workspaceName: 'Acme' });
  const b = seedWorkspace(store.db, { workspaceName: 'Beacon' });

  const understandingId = await understand(store.db, a);
  const { planId } = planBuilder.buildPlan(store.db, a.ctx, { understandingId });
  planApplier.applyPlan(store.db, a.ctx, planId);

  // B cannot read A's understanding, plan or configuration.
  assert.equal(understandingService.getUnderstanding(store.db, b.workspaceId, understandingId), null);
  assert.equal(planBuilder.getPlan(store.db, b.workspaceId, planId), null);
  assert.equal(planApplier.getConfiguration(store.db, b.workspaceId), null);
  assert.equal(planApplier.isConfigured(store.db, b.workspaceId), false);

  // B cannot build on A's understanding, nor apply A's plan.
  assert.throws(
    () => planBuilder.buildPlan(store.db, b.ctx, { understandingId }),
    (err) => err.code === 'not_found'
  );
  assert.throws(
    () => planApplier.applyPlan(store.db, b.ctx, planId),
    (err) => err.code === 'not_found'
  );

  // A's locations did not leak into B.
  assert.equal(
    repo.listLocations(store.db, b.workspaceId).some((l) => l.name === 'Brooklyn Warehouse'),
    false
  );
  assert.equal(planApplier.isConfigured(store.db, a.workspaceId), true);
});

test('configuration survives closing and reopening the database', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const understandingId = await understand(store.db, workspace);
  const { planId } = planBuilder.buildPlan(store.db, workspace.ctx, { understandingId });
  planApplier.applyPlan(store.db, workspace.ctx, planId);
  const before = planApplier.getConfiguration(store.db, workspace.workspaceId);
  store.db.close();

  const db = openDatabase(store.databasePath);
  const after = planApplier.getConfiguration(db, workspace.workspaceId);

  assert.equal(after.configurationVersion, before.configurationVersion);
  assert.equal(after.terminology.location, 'Warehouse');
  assert.equal(after.inventoryModel.usesVariants, true);
  assert.deepEqual(after.inventoryModel.variantDimensions.map((d) => d.name), ['Color', 'Size']);
  assert.equal(planApplier.isConfigured(db, workspace.workspaceId), true);

  const stored = planBuilder.getPlan(db, workspace.workspaceId, planId);
  assert.equal(stored.status, 'applied');
  assert.equal(verifyPlanIntegrity(stored.plan), true);
  assert.ok(JSON.parse(stored.applied_summary).locationsCreated.length);

  const understanding = understandingService.getUnderstanding(db, workspace.workspaceId, understandingId);
  assert.ok(understanding.understanding.rationale);
  db.close();
});

test('configuring a workspace never disturbs its existing inventory', async () => {
  const store = makeDatabase();
  const workspace = seedWorkspace(store.db);
  const item = makeQuantityItem(store.db, workspace.ctx);
  engine.receive(store.db, workspace.ctx, { skuId: item.skuId, locationId: workspace.main.id, quantity: 60 });
  engine.transfer(store.db, workspace.ctx, {
    skuId: item.skuId,
    fromLocationId: workspace.main.id,
    toLocationId: workspace.store.id,
    quantity: 20,
  });

  const understandingId = await understand(store.db, workspace);
  const { planId } = planBuilder.buildPlan(store.db, workspace.ctx, { understandingId });
  planApplier.applyPlan(store.db, workspace.ctx, planId);

  assert.equal(repo.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.main.id), 40);
  assert.equal(repo.getBalance(store.db, workspace.workspaceId, item.skuId, workspace.store.id), 20);
  assert.equal(repo.getSkuTotal(store.db, workspace.workspaceId, item.skuId), 60);
  assert.equal(engine.verifyIntegrity(store.db, workspace.workspaceId).ok, true);
});

test('the applier cannot reach the inventory engine at all', () => {
  // Structural, not behavioural: the module simply does not import it.
  const source = require('node:fs').readFileSync(
    require.resolve('../../src/foundry/plan-applier.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /require\(['"][^'"]*inventory-engine['"]\)/);
  for (const forbidden of ['engine.receive', 'engine.issue', 'engine.transfer', 'engine.adjust']) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace('.', '\\.')));
  }
});
