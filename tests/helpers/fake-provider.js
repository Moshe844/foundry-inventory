'use strict';

/**
 * A scripted stand-in for a model provider, for tests only.
 *
 * It lives in tests/ and is never registered in the provider registry, so there
 * is no code path in which production silently falls back to canned answers —
 * a test must hand it in explicitly. Its job is to make the plumbing and the
 * safety properties testable without spending API calls; whether the real model
 * reasons well is what the live tests are for.
 */

/**
 * Splits one complete understanding fixture into the two responses the service
 * asks for (core, then advice), so tests script the fixture, not the wire.
 */
function fakeUnderstandingProvider(understanding, options = {}) {
  const { recommendations, unresolvedDecisions, ...core } = understanding;
  return fakeProvider([core, { recommendations, unresolvedDecisions }], options);
}

function fakeProvider(responses, { name = 'fake', model = 'fake-model' } = {}) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];

  return {
    name,
    model,
    calls,
    async complete(request) {
      calls.push(request);
      if (queue.length === 0) throw new Error('fakeProvider: no scripted response left');
      const next = queue.length === 1 ? queue[0] : queue.shift();
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return wrap(await next(request));
      return wrap(next);
    },
  };

  function wrap(data) {
    return {
      data,
      usage: { provider: name, model, inputTokens: 100, outputTokens: 200, latencyMs: 5 },
    };
  }
}

/** A complete, schema-valid understanding. Override any slice of it. */
function buildUnderstanding(overrides = {}) {
  const base = {
    businessDescription: 'We sell widgets from one warehouse.',
    businessType: 'Wholesale distribution',
    inventoryPurpose: 'Knowing how many widgets are on hand.',
    inventoryExamples: ['Widget A', 'Widget B'],
    inventoryArchetypes: ['quantity'],
    productStructure: { summary: 'Flat list of products.', levels: ['Product'], certainty: 'inferred_confidently' },
    variantDimensions: [],
    serializedTracking: { applies: false, certainty: 'inferred_confidently', reason: 'No unit identity mentioned.' },
    lotTracking: { applies: false, certainty: 'inferred_confidently', reason: 'No batches mentioned.' },
    expirationTracking: { applies: false, certainty: 'inferred_confidently', reason: 'Not perishable.' },
    locationModel: {
      summary: 'One warehouse.',
      multipleLocations: false,
      transfersExpected: false,
      certainty: 'inferred_confidently',
    },
    likelyLocations: [{ name: 'Main Warehouse', kind: 'warehouse', certainty: 'inferred_confidently' }],
    unitsOfMeasure: ['unit'],
    receivingWorkflow: 'Stock arrives and is counted in.',
    issuingWorkflow: 'Stock leaves when sold.',
    transferWorkflow: 'Not needed with one location.',
    adjustmentWorkflow: 'Counts are corrected with a reason.',
    likelyRoles: ['Warehouse staff'],
    terminology: { item: '', location: '', serialUnit: '', lot: '', variant: '' },
    importantOperationalPatterns: ['Single location keeps things simple.'],
    recommendedConfiguration: {
      trackingMode: 'quantity',
      usesVariants: false,
      allowNegativeStock: false,
      summary: 'Stock is counted as quantities per location.',
    },
    recommendations: [],
    assumptions: [],
    unresolvedDecisions: [],
    confidence: 'high',
    rationale: 'The description describes simple quantity inventory in one place.',
  };
  return { ...base, ...overrides };
}

function buildQuestion(overrides = {}) {
  return {
    id: 'negative_stock',
    question: 'Should staff be able to record stock leaving before it has been received?',
    whyItMatters: 'it decides whether balances may briefly go below zero',
    options: [
      { id: 'no', label: 'No — never below zero', consequence: 'Issues are refused when stock is short.', effect: 'disallow_negative_stock' },
      { id: 'yes', label: 'Yes — allow it', consequence: 'Balances may go negative and be corrected later.', effect: 'allow_negative_stock' },
    ],
    recommendedOptionId: 'no',
    ...overrides,
  };
}

function buildRecommendation(overrides = {}) {
  return {
    title: 'Track low stock by size',
    noticed: 'You sell the same style in several sizes.',
    recommendation: 'Set your reorder thinking at the size level rather than the style level.',
    whyItMatters: 'A style can look well stocked while the sizes people actually buy are gone.',
    scope: 'future',
    confidence: 'high',
    ...overrides,
  };
}

module.exports = {
  fakeProvider,
  fakeUnderstandingProvider,
  buildUnderstanding,
  buildQuestion,
  buildRecommendation,
};
