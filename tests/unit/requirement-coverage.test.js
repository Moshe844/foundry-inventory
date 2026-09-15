'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const requirementCoverage = require('../../src/foundry/requirement-coverage');

test('preserves every owner statement without a business-specific keyword list', () => {
  const description = [
    'We sell general merchandise with multiple products and SKUs.',
    'Products can have variants such as size, color, material, and customization options.',
    'We keep inventory in multiple locations and transfer stock between locations.',
  ].join(' ');

  assert.deepEqual(requirementCoverage.sourceStatements(description), [
    'We sell general merchandise with multiple products and SKUs.',
    'Products can have variants such as size, color, material, and customization options.',
    'We keep inventory in multiple locations and transfer stock between locations.',
  ]);
});

test('extracts arbitrary list and clause requirements without a field vocabulary', () => {
  const description = [
    'Products need frost rating, acoustic isolation, and a reversible mounting pattern.',
    'Orders require customer approval; damaged returns must retain photographs.',
  ].join(' ');

  assert.deepEqual(requirementCoverage.requirementUnits(description), [
    'Products need frost rating, acoustic isolation, and a reversible mounting pattern',
    'Orders require customer approval',
    'damaged returns must retain photographs',
  ]);
});

test('reconciliation removes invented citations and restores every omitted source unit', () => {
  const description = [
    'Products need frost rating, acoustic isolation, and a reversible mounting pattern.',
    'Orders require customer approval; damaged returns must retain photographs.',
  ].join(' ');
  const result = requirementCoverage.reconcile(description, [
    {
      sourceText: 'frost rating',
      understanding: 'Store a frost rating.',
      status: 'supported_today',
      nextStep: '',
    },
    {
      sourceText: 'biometric chain of custody',
      understanding: 'Require biometrics.',
      status: 'supported_today',
      nextStep: '',
    },
  ]);

  const citations = result.map((entry) => entry.sourceText);
  assert.ok(citations.includes('frost rating'));
  assert.ok(citations.includes('Products need frost rating, acoustic isolation, and a reversible mounting pattern'));
  assert.ok(citations.includes('Orders require customer approval'));
  assert.ok(citations.includes('damaged returns must retain photographs'));
  assert.ok(!citations.includes('biometric chain of custody'));
  for (const restored of result.filter((entry) => entry.sourceText !== 'frost rating')) {
    assert.equal(restored.status, 'needs_detail');
  }
});

test('legacy generated fragments are removed when a real reconciled requirement covers them', () => {
  const description = 'Our inventory includes cleaning supplies, packaging materials, safety equipment, and tools.';
  const result = requirementCoverage.reconcile(description, [
    {
      sourceText: 'cleaning supplies, packaging materials, safety equipment, and tools',
      understanding: 'The catalogue spans several commercial product categories.',
      status: 'supported_today',
      nextStep: 'none',
    },
    {
      sourceText: 'Our inventory includes cleaning supplies',
      understanding: 'Our inventory includes cleaning supplies',
      status: 'needs_detail',
      nextStep: '',
    },
  ]);

  assert.deepEqual(result.map((entry) => entry.sourceText), [
    'cleaning supplies, packaging materials, safety equipment, and tools',
  ]);
  assert.equal(result[0].nextStep, '', 'placeholder prose is not shown as a human action');
});

test('semantic coverage removes framing-only duplicates without collapsing distinct requirements', () => {
  assert.equal(
    requirementCoverage.semanticallyCovers(
      'multiple SKUs based on attributes such as size',
      'while others have multiple SKUs based on attributes such as size'
    ),
    true
  );
  assert.equal(
    requirementCoverage.semanticallyCovers(
      'cleaning supplies, packaging materials, safety equipment, and tools',
      'Our inventory includes cleaning supplies'
    ),
    true
  );
  assert.equal(
    requirementCoverage.semanticallyCovers('size', 'multiple SKUs based on attributes such as size'),
    false,
    'a small citation cannot erase the meaning around it'
  );
});

test('downstream summary groups the complete reconciled set without truncation', () => {
  const requirements = Array.from({ length: 45 }, (_, index) => ({
    sourceText: `requirement ${index + 1}`,
    understanding: `Requirement ${index + 1}`,
    semanticRole: index % 2 === 0 ? 'resolvable_requirement' : 'operational_requirement',
    status: index % 3 === 0 ? 'supported_today' : (index % 3 === 1 ? 'needs_detail' : 'unsupported_today'),
    nextStep: '',
  }));
  const summary = requirementCoverage.summarize(requirements);
  assert.equal(summary.total, requirements.length);
  assert.deepEqual(
    [...summary.supported, ...summary.needsDetail, ...summary.needsOwnerInput, ...summary.context, ...summary.unsupported]
      .map((entry) => entry.sourceText).sort(),
    requirements.map((entry) => entry.sourceText).sort()
  );
});

test('semantic roles keep context, evidence instructions, and guardrails out of record questions', () => {
  const description = [
    'We operate a regional repair service.',
    'Inspection reports will be supplied after each visit.',
    'Do not fabricate missing asset identities.',
    'Each asset requires a calibrated pressure threshold.',
  ].join(' ');
  const reconciled = requirementCoverage.reconcile(description, []);
  const bySource = new Map(reconciled.map((entry) => [entry.sourceText, entry]));

  assert.equal(bySource.get('We operate a regional repair service').semanticRole, 'business_context');
  assert.equal(bySource.get('Inspection reports will be supplied after each visit').semanticRole, 'evidence_instruction');
  assert.equal(bySource.get('Do not fabricate missing asset identities').semanticRole, 'behavioral_guardrail');
  assert.equal(bySource.get('Each asset requires a calibrated pressure threshold').semanticRole, 'operational_requirement');

  const summary = requirementCoverage.summarize(reconciled);
  assert.equal(summary.needsDetail.length, 0);
  assert.equal(summary.context.length, 3);
  assert.equal(summary.needsOwnerInput.length, 1);
});
