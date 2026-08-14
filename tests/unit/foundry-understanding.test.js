'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const understandingService = require('../../src/foundry/understanding-service');
const { UNDERSTANDING_SCHEMA, CORE_SCHEMA } = require('../../src/foundry/understanding-schema');
const { validate } = require('../../src/foundry/validator');
const { makeDatabase, cleanupAll, seedWorkspace } = require('../helpers');
const {
  fakeProvider,
  fakeUnderstandingProvider,
  buildUnderstanding,
  buildQuestion,
} = require('../helpers/fake-provider');

test.after(cleanupAll);

function setup() {
  const { db } = makeDatabase();
  const workspace = seedWorkspace(db);
  return { db, workspace };
}

test('a well-formed model response is accepted and stored', async () => {
  const { db, workspace } = setup();
  const provider = fakeUnderstandingProvider(buildUnderstanding());

  const { id, understanding } = await understandingService.describeBusiness(
    db,
    workspace.ctx,
    'We sell widgets from one warehouse.',
    { provider }
  );

  assert.ok(id);
  assert.equal(understanding.recommendedConfiguration.trackingMode, 'quantity');

  const row = db.prepare('SELECT * FROM foundry_understandings WHERE id = ?').get(id);
  assert.equal(row.workspace_id, workspace.workspaceId);
  assert.equal(row.actor_user_id, workspace.ownerId);
  assert.equal(row.provider, 'fake');
  assert.ok(JSON.parse(row.payload).rationale);

  // The prompt must describe the engine, not the business — no keyword rules.
  const sent = provider.calls[0];
  assert.match(sent.system, /quantity/);
  assert.match(sent.system, /forecasting/);
  assert.doesNotMatch(sent.system.toLowerCase(), /\bshoe|sweater|laptop\b/);
  assert.equal(sent.schema, CORE_SCHEMA);
});

test('malformed model output is rejected, not stored', async () => {
  const { db, workspace } = setup();

  const malformed = [
    {},
    { businessDescription: 'x' },
    buildUnderstanding({ confidence: 'extremely-high' }),
    buildUnderstanding({ recommendedConfiguration: { trackingMode: 'quantity' } }),
    buildUnderstanding({ likelyLocations: [{ name: 'X', kind: 'space_station', certainty: 'inferred_confidently' }] }),
    { ...buildUnderstanding(), sneakyExtraField: 'drop table' },
  ];

  for (const payload of malformed) {
    await assert.rejects(
      () => understandingService.describeBusiness(db, workspace.ctx, 'A description of a business.', {
        provider: fakeUnderstandingProvider(payload),
      }),
      (err) => err.code === 'validation_error',
      `should reject ${JSON.stringify(payload).slice(0, 60)}`
    );
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM foundry_understandings').get().n, 0);
});

test('a non-object response is rejected', async () => {
  const { db, workspace } = setup();
  // fakeProvider returns the same payload for every call, which is exactly the
  // "provider hands back garbage" case this covers.
  for (const payload of [null, 'a string', 42, ['an', 'array']]) {
    await assert.rejects(
      () => understandingService.describeBusiness(db, workspace.ctx, 'A description of a business.', {
        provider: fakeProvider(payload),
      }),
      (err) => err.code === 'validation_error'
    );
  }
});

test('an unsupported tracking mode is corrected, never honoured', () => {
  // Schema validation would reject an unknown enum outright; this covers the
  // case where a value is schema-valid but the engine still cannot support it.
  const raw = buildUnderstanding();
  raw.recommendedConfiguration.trackingMode = 'quantum_entangled';
  const normalised = understandingService.normalise(raw, 'desc');

  assert.equal(normalised.recommendedConfiguration.trackingMode, 'quantity');
  assert.ok(normalised.assumptions.some((a) => /does not support|not one it supports/i.test(a)));
});

test('expiration is only kept where the engine can honour it', () => {
  const onQuantity = understandingService.normalise(
    buildUnderstanding({
      expirationTracking: { applies: true, certainty: 'inferred_confidently', reason: 'perishable' },
    }),
    'desc'
  );
  assert.equal(onQuantity.expirationTracking.applies, false);
  assert.equal(onQuantity.expirationTracking.certainty, 'unsupported_today');

  const onLots = understandingService.normalise(
    buildUnderstanding({
      recommendedConfiguration: { trackingMode: 'lot', usesVariants: false, allowNegativeStock: false, summary: null },
      expirationTracking: { applies: true, certainty: 'inferred_confidently', reason: 'perishable' },
    }),
    'desc'
  );
  assert.equal(onLots.expirationTracking.applies, true);
});

test('archetypes are derived from the configuration, not taken on trust', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({
      inventoryArchetypes: ['quantity', 'serial', 'lot', 'variant'],
      recommendedConfiguration: { trackingMode: 'serial', usesVariants: true, allowNegativeStock: false, summary: null },
    }),
    'desc'
  );
  assert.deepEqual(normalised.inventoryArchetypes.sort(), ['serial', 'variant']);
  assert.equal(normalised.serializedTracking.applies, true);
});

test('variant dimensions are dropped when variants are not used', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({
      variantDimensions: [{ name: 'Colour', exampleValues: ['Navy'] }],
      recommendedConfiguration: { trackingMode: 'quantity', usesVariants: false, allowNegativeStock: false, summary: null },
    }),
    'desc'
  );
  assert.deepEqual(normalised.variantDimensions, []);
});

test('duplicate and unusable locations are filtered out', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({
      likelyLocations: [
        { name: 'Brooklyn', kind: 'warehouse', certainty: 'inferred_confidently' },
        { name: 'brooklyn', kind: 'store', certainty: 'assumed_safely' },
        { name: 'New Jersey', kind: 'warehouse', certainty: 'inferred_confidently' },
      ],
    }),
    'desc'
  );
  assert.deepEqual(normalised.likelyLocations.map((l) => l.name), ['Brooklyn', 'New Jersey']);
});

test('a recommendation pointing at no real option is repaired, not discarded', () => {
  // The question itself may be materially important; only the pointer is wrong.
  const normalised = understandingService.normalise(
    buildUnderstanding({
      unresolvedDecisions: [buildQuestion({ recommendedOptionId: 'does_not_exist' })],
    }),
    'desc'
  );

  assert.equal(normalised.unresolvedDecisions.length, 1);
  const [decision] = normalised.unresolvedDecisions;
  assert.ok(
    decision.options.some((option) => option.id === decision.recommendedOptionId),
    'the recommendation must name an option that exists'
  );
});

test('identifier shapes are normalised rather than rejected', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({
      unresolvedDecisions: [
        buildQuestion({
          id: 'Negative Stock?',
          options: [
            { id: 'Yes, allow it', label: 'Yes', consequence: 'x', effect: 'allow_negative_stock' },
            { id: 'No', label: 'No', consequence: 'y', effect: 'disallow_negative_stock' },
          ],
          recommendedOptionId: 'No',
        }),
      ],
    }),
    'desc'
  );

  const [decision] = normalised.unresolvedDecisions;
  assert.equal(decision.id, 'negative_stock');
  assert.deepEqual(decision.options.map((o) => o.id), ['yes_allow_it', 'no']);
  assert.equal(decision.recommendedOptionId, 'no');
});

test('a question with fewer than two real options is dropped', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({
      unresolvedDecisions: [
        buildQuestion({ options: [{ id: 'only', label: 'Only', consequence: 'x', effect: 'none' }] }),
      ],
    }),
    'desc'
  );
  assert.equal(normalised.unresolvedDecisions.length, 0);
});

test('over-long prose is trimmed to the contract instead of failing', () => {
  const normalised = understandingService.normalise(
    buildUnderstanding({ importantOperationalPatterns: ['x'.repeat(900)] }),
    'desc'
  );
  assert.equal(normalised.importantOperationalPatterns[0].length, 300);
});

test('Foundry asks few questions: at most three survive', () => {
  const many = Array.from({ length: 8 }, (_, i) => buildQuestion({ id: `question_${i}` }));
  const normalised = understandingService.normalise(buildUnderstanding({ unresolvedDecisions: many }), 'desc');
  assert.ok(normalised.unresolvedDecisions.length <= 3);
});

test('an answer can only carry a whitelisted effect', () => {
  const bad = buildUnderstanding({
    unresolvedDecisions: [
      buildQuestion({
        options: [
          { id: 'a', label: 'A', consequence: 'x', effect: 'delete_all_inventory' },
          { id: 'b', label: 'B', consequence: 'y', effect: 'none' },
        ],
        recommendedOptionId: 'a',
      }),
    ],
  });
  const result = validate(UNDERSTANDING_SCHEMA, bad, { key: 'understanding-effect-test' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /effect/.test(e)));
});

test('recommendations are stored with everything needed to judge them', async () => {
  const { db, workspace } = setup();
  const { id } = await understandingService.describeBusiness(db, workspace.ctx, 'We sell widgets from one warehouse.', {
    provider: fakeUnderstandingProvider(buildUnderstanding({
        recommendations: [
          {
            title: 'Split stock by size',
            noticed: 'You mentioned sizes.',
            recommendation: 'Track each size separately.',
            whyItMatters: 'Otherwise popular sizes vanish unnoticed.',
            scope: 'configuration',
            confidence: 'high',
          },
        ],
      })
    ),
  });

  const [rec] = understandingService.listRecommendations(db, workspace.workspaceId, id);
  assert.equal(rec.title, 'Split stock by size');
  assert.ok(rec.noticed && rec.recommendation && rec.why_it_matters);
  assert.equal(rec.scope, 'configuration');
  assert.equal(rec.status, 'offered');
});

test('a description that says almost nothing is refused before it reaches the model', async () => {
  const { db, workspace } = setup();
  const provider = fakeUnderstandingProvider(buildUnderstanding());
  await assert.rejects(
    () => understandingService.describeBusiness(db, workspace.ctx, 'stuff', { provider }),
    (err) => err.code === 'validation_error'
  );
  assert.equal(provider.calls.length, 0, 'no API call is made for an unusable description');
});
