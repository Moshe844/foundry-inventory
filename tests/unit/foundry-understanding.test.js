'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const understandingService = require('../../src/foundry/understanding-service');
const prompts = require('../../src/foundry/prompts');
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

test('onboarding describes every implemented business capability consistently', () => {
  const system = prompts.understandingSystemPrompt();
  assert.match(system, /Sales Orders:/);
  assert.match(system, /Supplier communication:/);
  assert.match(system, /Accounting is built in and starts automatically/);
  assert.match(system, /Connections for Shopify, Square, Clover, WooCommerce/);
  const unavailable = system.match(/The engine does NOT have,[\s\S]*?If the business/i)?.[0] || '';
  assert.doesNotMatch(unavailable, /sales orders/i);
  assert.doesNotMatch(unavailable, /accounting/i);
  assert.doesNotMatch(unavailable, /integrations/i);
});

test('the advice pass requires an exhaustive owner-requirement ledger', () => {
  const prompt = prompts.advicePrompt(
    'Products can have size, color, material, and customization options.',
    {}
  );
  assert.match(prompt, /exhaustive statedRequirements ledger/i);
  assert.match(prompt, /Do not collapse a list in a way that hides one of its members/i);
});

test('grounding keeps cited requirements and discards invented ones', () => {
  const description = 'Products can have size, color, material, and customization options.';
  const normalised = understandingService.normalise(buildUnderstanding({
    statedRequirements: [
      {
        sourceText: 'customization options',
        understanding: 'Products may need configurable customization choices.',
        semanticRole: 'resolvable_requirement',
        status: 'needs_detail',
        nextStep: 'Provide the actual customization fields.',
      },
      {
        sourceText: 'engraved serial plates',
        understanding: 'Products need engraving.',
        semanticRole: 'operational_requirement',
        status: 'supported_today',
        nextStep: '',
      },
    ],
  }), description, { workspaceMode: 'production' });

  const citations = normalised.statedRequirements.map((entry) => entry.sourceText);
  assert.ok(citations.includes('customization options'));
  assert.ok(citations.includes('Products can have size, color, material, and customization options'));
  assert.ok(!citations.includes('engraved serial plates'));
  assert.equal(
    normalised.statedRequirements.find((entry) => entry.sourceText.startsWith('Products can have size')).status,
    'needs_detail'
  );
});

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

test('the saved interpretation restores arbitrary requirements omitted by the model', async () => {
  const { db, workspace } = setup();
  const provider = fakeUnderstandingProvider(buildUnderstanding({ statedRequirements: [] }));
  const description = [
    'Each shipment needs a cold-chain seal, partner approval, and a recyclable-packaging note.',
    'Exceptions must retain the customer photograph.',
  ].join(' ');

  const { id, understanding } = await understandingService.describeBusiness(
    db,
    workspace.ctx,
    description,
    { provider }
  );

  const expected = [
    'Each shipment needs a cold-chain seal, partner approval, and a recyclable-packaging note',
    'Exceptions must retain the customer photograph',
  ];
  const citations = understanding.statedRequirements.map((entry) => entry.sourceText);
  for (const requirement of expected) assert.ok(citations.includes(requirement), requirement);

  const stored = JSON.parse(
    db.prepare('SELECT payload FROM foundry_understandings WHERE id = ?').get(id).payload
  );
  assert.deepEqual(stored.statedRequirements, understanding.statedRequirements);
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
        // Never said by the owner: a description of the business, not a place.
        { name: 'Refrigerated warehouse', kind: 'warehouse', certainty: 'assumed_safely' },
      ],
    }),
    'A warehouse in Brooklyn and a store in New Jersey for refrigerated goods.'
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

test('StockChief asks few questions: at most three survive', () => {
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
