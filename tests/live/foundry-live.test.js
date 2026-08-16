'use strict';

/**
 * Live tests against a real model provider.
 *
 * These are the tests that can actually fail because the intelligence is wrong,
 * rather than because the plumbing is. Everything else in the suite runs on a
 * scripted provider; nothing here is mocked.
 *
 * Skipped automatically when no API key is configured, so the default suite
 * stays fast and free. Run with: npm run test:live
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../src/config');
const understandingService = require('../../src/foundry/understanding-service');
const planBuilder = require('../../src/foundry/plan-builder');
const planApplier = require('../../src/foundry/plan-applier');
const assistant = require('../../src/foundry/assistant-service');
const repo = require('../../src/domain/repository');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');

const LIVE = config.ai.configured;
const TIMEOUT = 600000;

const BUSINESSES = {
  clothing: {
    label: 'A — Clothing wholesaler',
    description:
      "We wholesale children's clothing. Products come in styles, colors and sizes. We have warehouses in Brooklyn and New Jersey.",
  },
  rental: {
    label: 'B — Equipment rental',
    description:
      'We rent construction equipment. Every machine has its own serial number, current location and condition.',
  },
  food: {
    label: 'C — Food distributor',
    description:
      'We distribute refrigerated food. We need to know which batch inventory came from and when each batch expires.',
  },
  school: {
    label: 'D — School technology',
    description:
      'We manage laptops and tablets for a school. Every device has a serial number and is assigned to a person or kept in a storage location.',
  },
  ambiguous: {
    label: 'E — Ambiguous',
    description: 'We sell building supplies from two stores.',
  },
};

/** Understand every business once, in parallel, and share across tests. */
let RESULTS = null;
async function results() {
  if (RESULTS) return RESULTS;
  const entries = await Promise.all(
    Object.entries(BUSINESSES).map(async ([key, business]) => {
      const { db } = makeDatabase();
      const workspace = seedWorkspace(db);
      db.prepare('DELETE FROM locations WHERE workspace_id = ?').run(workspace.workspaceId);
      const { id, understanding } = await understandingService.describeBusiness(
        db,
        workspace.ctx,
        business.description
      );
      const { planId, plan } = planBuilder.buildPlan(db, workspace.ctx, { understandingId: id });
      const applied = planApplier.applyPlan(db, workspace.ctx, planId);
      return [key, { db, workspace, understanding, plan, planId, applied, ...business }];
    })
  );
  RESULTS = Object.fromEntries(entries);

  // Keep the evidence for the report.
  const artifactDir = path.join(__dirname, '..', '..', 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, 'live-understandings.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(RESULTS).map(([key, r]) => [
          key,
          { description: r.description, understanding: r.understanding, plan: r.plan, applied: r.applied },
        ])
      ),
      null,
      2
    )
  );
  return RESULTS;
}

test.after(cleanupAll);

test('A — a clothing wholesaler becomes variant + quantity across two locations', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { clothing } = await results();
  const u = clothing.understanding;

  assert.equal(u.recommendedConfiguration.trackingMode, 'quantity');
  assert.equal(u.recommendedConfiguration.usesVariants, true);
  assert.ok(u.inventoryArchetypes.includes('variant'));
  assert.equal(u.serializedTracking.applies, false, 'clothing is not serialized');
  assert.equal(u.lotTracking.applies, false, 'clothing is not lot tracked');

  const dimensions = u.variantDimensions.map((d) => d.name.toLowerCase()).join(' ');
  assert.match(dimensions, /colou?r/, `expected a colour axis, got ${dimensions}`);
  assert.match(dimensions, /size/, `expected a size axis, got ${dimensions}`);

  assert.ok(clothing.plan.locations.length >= 2, 'two warehouses were described');
  assert.ok(clothing.applied.locationsCreated.length >= 2);
});

test('B — equipment rental becomes serialized inventory', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { rental } = await results();
  const u = rental.understanding;

  assert.equal(u.recommendedConfiguration.trackingMode, 'serial');
  assert.equal(u.serializedTracking.applies, true);
  assert.equal(rental.plan.serialRules.enabled, true);
  assert.equal(rental.plan.serialRules.singleLocationPerUnit, true);
  assert.equal(rental.plan.lotRules.enabled, false);
});

test('C — a food distributor becomes lot tracking with expiration', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { food } = await results();
  const u = food.understanding;

  assert.equal(u.recommendedConfiguration.trackingMode, 'lot');
  assert.equal(u.lotTracking.applies, true);
  assert.equal(u.expirationTracking.applies, true);
  assert.equal(food.plan.lotRules.enabled, true);
  assert.equal(food.plan.lotRules.requireLotOnReceive, true);
  assert.equal(food.plan.expirationRules.enabled, true);
  assert.equal(food.plan.expirationRules.captureOnReceive, true);
});

test('D — school devices become serialized assets', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { school } = await results();
  const u = school.understanding;

  assert.equal(u.recommendedConfiguration.trackingMode, 'serial');
  assert.equal(u.serializedTracking.applies, true);
  assert.equal(school.plan.serialRules.enabled, true);
  assert.ok(school.plan.locations.length >= 1, 'a storage location was described');
});

test('E — an ambiguous description is handled honestly, not elaborately', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { ambiguous } = await results();
  const u = ambiguous.understanding;

  // What it does know: quantity inventory, and two locations were explicit.
  assert.equal(u.recommendedConfiguration.trackingMode, 'quantity');
  assert.equal(u.locationModel.multipleLocations, true);
  assert.ok(u.likelyLocations.length >= 2, 'two stores were stated outright');

  // What it must not invent from "we sell building supplies".
  assert.equal(u.serializedTracking.applies, false, 'nothing implied per-unit identity');
  assert.equal(u.lotTracking.applies, false, 'nothing implied batches');
  assert.equal(ambiguous.plan.serialRules.enabled, false);
  assert.equal(ambiguous.plan.lotRules.enabled, false);
  assert.equal(
    u.recommendedConfiguration.usesVariants,
    false,
    'nothing in the description implied option axes — inventing them is the failure mode here'
  );
  assert.deepEqual(ambiguous.plan.variantDimensions, []);

  // And it should say so, rather than projecting false confidence.
  assert.notEqual(u.confidence, 'high', 'this description does not justify high confidence');
  assert.ok(
    u.unresolvedDecisions.length >= 1,
    'an unresolved tracking question is the honest response here'
  );
  assert.ok(u.unresolvedDecisions.length <= 3, 'but still not an interrogation');
});

test('every business is asked at most three questions', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const all = await results();
  for (const [key, r] of Object.entries(all)) {
    assert.ok(
      r.understanding.unresolvedDecisions.length <= 3,
      `${key} asked ${r.understanding.unresolvedDecisions.length} questions`
    );
  }
});

test('the four businesses produce materially different results', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const all = await results();
  const four = ['clothing', 'rental', 'food', 'school'].map((k) => all[k]);

  // Different inventory models.
  const models = four.map((r) => `${r.plan.inventoryModel.primaryArchetype}:${r.plan.inventoryModel.usesVariants}`);
  assert.ok(new Set(models).size >= 3, `expected varied models, got ${models.join(', ')}`);

  // Different locations — no shared boilerplate set.
  const locationSets = four.map((r) => r.plan.locations.map((l) => l.name.toLowerCase()).sort().join('|'));
  assert.equal(new Set(locationSets).size, 4, 'each business should get its own locations');

  // Different recommendations, and no recommendation text reused across businesses.
  const titles = four.flatMap((r) => r.understanding.recommendations.map((rec) => rec.title.toLowerCase()));
  assert.equal(new Set(titles).size, titles.length, 'recommendations must not repeat across businesses');

  // Different questions.
  const questions = four.flatMap((r) => r.understanding.unresolvedDecisions.map((q) => q.question.toLowerCase()));
  assert.equal(new Set(questions).size, questions.length, 'questions must not repeat across businesses');

  // At least some businesses adapt terminology, and not all to the same word.
  const terms = four.map((r) => JSON.stringify(r.plan.terminology));
  assert.ok(new Set(terms).size >= 3, `expected varied terminology, got ${terms.join(' / ')}`);
});

test('recommendations are specific, not generic filler', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const all = await results();
  const GENERIC = [
    /^keep (your )?inventory accurate/i,
    /^review (your )?inventory regularly/i,
    /^use good sku names/i,
    /^count (your )?stock regularly/i,
    /^stay organi[sz]ed/i,
  ];

  for (const [key, r] of Object.entries(all)) {
    for (const rec of r.understanding.recommendations) {
      for (const pattern of GENERIC) {
        assert.doesNotMatch(rec.title, pattern, `${key} produced generic advice: ${rec.title}`);
      }
      assert.ok(rec.noticed.length > 15, `${key}: "${rec.title}" must say what was noticed`);
      assert.ok(rec.whyItMatters.length > 15, `${key}: "${rec.title}" must say why it matters`);
      assert.ok(['configuration', 'future'].includes(rec.scope));
    }
  }
});

test('nothing Foundry cannot do is promised as configured', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const all = await results();
  for (const [key, r] of Object.entries(all)) {
    // Anything the engine genuinely does not have must be future-scoped.
    //
    // Reorder points and purchase orders were on this list until Mission 6 built
    // them. Leaving them here would now fail the model for telling the truth,
    // which is the same defect in the opposite direction: a customer told
    // Foundry cannot do something it does goes and buys a second system.
    for (const rec of r.understanding.recommendations) {
      // Disclaiming a missing feature is the model being careful, not promising
      // it: "reorder points are a floor, not a seasonal buy plan" names
      // forecasting precisely in order to rule it out. Only an unqualified
      // mention counts as a promise.
      const text = `${rec.title} ${rec.recommendation}`
        .toLowerCase()
        .replace(/\b(not|never|no|without|rather than|instead of|cannot|can't|does not|doesn't)\b[^.;]*/g, '');
      const mentionsMissing = /forecast|barcode scan|valuation|bill of materials|sales order/.test(text);
      if (mentionsMissing && rec.scope === 'configuration') {
        assert.fail(`${key}: "${rec.title}" promises an unavailable feature as configuration`);
      }
    }
    // And the plan only ever contains modes the engine implements.
    assert.ok(['quantity', 'serial', 'lot'].includes(r.plan.inventoryModel.primaryArchetype));
    for (const mode of r.plan.trackingModes) {
      assert.ok(['quantity', 'serial', 'lot'].includes(mode));
    }
  }
});

test('applying a live plan configures structure and never invents inventory', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const all = await results();
  for (const [key, r] of Object.entries(all)) {
    const counts = r.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM items WHERE workspace_id = @workspaceId) AS items,
           (SELECT COUNT(*) FROM skus WHERE workspace_id = @workspaceId) AS skus,
           (SELECT COUNT(*) FROM movements WHERE workspace_id = @workspaceId) AS movements,
           (SELECT COUNT(*) FROM serial_units WHERE workspace_id = @workspaceId) AS units,
           (SELECT COUNT(*) FROM lots WHERE workspace_id = @workspaceId) AS lots,
           (SELECT COALESCE(SUM(on_hand), 0) FROM balances WHERE workspace_id = @workspaceId) AS onHand`
      )
      .get({ workspaceId: r.workspace.workspaceId });

    assert.deepEqual(
      counts,
      { items: 0, skus: 0, movements: 0, units: 0, lots: 0, onHand: 0 },
      `${key}: Foundry must create structure only`
    );
    assert.ok(repo.listLocations(r.db, r.workspace.workspaceId).length >= 1, `${key}: locations were configured`);
  }
});

test('Foundry answers a question about the real configuration', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { clothing } = await results();
  const answer = await assistant.ask(
    clothing.db,
    clothing.workspace.ctx,
    'Why are my products tracked with variants?'
  );

  assert.ok(answer.answer.length > 40);
  assert.equal(answer.supportedToday, true);

  // Grounded in THIS workspace's setup: the answer must name something that
  // is actually configured, drawn from the plan rather than guessed at.
  const configuredTerms = [
    ...clothing.plan.variantDimensions.map((d) => d.name),
    ...clothing.plan.locations.map((l) => l.name.split(/\s+/)[0]),
    'variant',
  ].map((t) => t.toLowerCase());

  const text = `${answer.answer} ${answer.grounding.join(' ')}`.toLowerCase();
  assert.ok(
    configuredTerms.some((term) => text.includes(term)),
    `the answer should cite the real configuration (${configuredTerms.join(', ')}), got: ${answer.answer}`
  );
});

test('Foundry refuses to pretend it can forecast', { skip: !LIVE, timeout: TIMEOUT }, async () => {
  const { food } = await results();
  const answer = await assistant.ask(
    food.db,
    food.workspace.ctx,
    'Can you forecast how much stock I should reorder next month?'
  );

  // `supportedToday` is the structured contract and the thing the UI keys on;
  // asserting on prose phrasing would just make this test flaky.
  assert.equal(answer.supportedToday, false, `expected an honest no, got: ${answer.answer}`);

  // And it must not claim otherwise in the prose either.
  assert.doesNotMatch(
    answer.answer.toLowerCase(),
    /\b(i|foundry) (can|will) (forecast|predict|calculate your reorder)/,
    `Foundry must not promise forecasting: ${answer.answer}`
  );
});
