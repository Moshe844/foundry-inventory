'use strict';

/**
 * A model reads the catalogue as a business catalogue; deterministic code
 * keeps the literal evidence exact.  The model is deliberately not asked to
 * copy prices, quantities or identifiers into an executable shape.  That
 * would make a fluent paraphrase the source of truth.  Instead it explains
 * product identity, variant relationships and operational meaning, while the
 * original fields remain the only facts execution may use.
 */

const { createProviderForTier, ProviderOutputError } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'productGroups', 'operationalFindings'],
  properties: {
    overview: { type: 'string' },
    productGroups: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordOrdinals', 'relationship', 'reason'],
        properties: {
          recordOrdinals: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer' } },
          relationship: { type: 'string', enum: ['one_product_one_sku', 'one_product_multiple_variants'] },
          reason: { type: 'string' },
        },
      },
    },
    operationalFindings: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['recordOrdinal', 'finding'],
        properties: {
          recordOrdinal: { type: 'integer' },
          finding: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You are Foundry's senior inventory catalogue analyst.

Read the complete submitted catalogue and explain what it means operationally.
This is an analysis for the business owner to review before anything is created.

Rules:
- Account for every numbered source record exactly once in productGroups.
- Group records as variants of one product only when the evidence supports one
  shared product identity with distinct supplied SKUs.
- Never invent products, SKUs, variants, quantities, locations, serial numbers,
  lots, suppliers, prices, kit components or other facts.
- Treat every supplied field as evidence, including unfamiliar field names.
- Notice pack/case units, suppliers, reorder points, lot/expiry tracking,
  serial tracking, kits/BOMs, locations and opening quantities when supplied.
- Keep the overview concise and natural. Do not recite the input or write a
  computer-generated field dump.
- Operational findings should explain meaningful handling implications. Do not
  turn missing facts into guesses and do not claim anything has been created.`;

function sourceForModel(records) {
  return records.map((record) => ({
    ordinal: record.ordinal,
    name: record.name,
    fields: record.fields.map((field) => ({ label: field.label, value: field.value })),
  }));
}

function assertCompleteCoverage(data, records) {
  const expected = records.map((record) => record.ordinal).sort((a, b) => a - b);
  const actual = data.productGroups
    .flatMap((group) => group.recordOrdinals)
    .sort((a, b) => a - b);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new ProviderOutputError('Foundry did not account for every submitted product record. Nothing was created.');
  }
  const allowed = new Set(expected);
  if (data.operationalFindings.some((finding) => !allowed.has(finding.recordOrdinal))) {
    throw new ProviderOutputError('Foundry referred to a product record that was not supplied. Nothing was created.');
  }
}

async function analyze(description, records, options = {}) {
  const provider = options.provider || createProviderForTier('standard', {
    effort: 'low',
    maxTokens: 6000,
  });
  const response = await provider.complete({
    system: SYSTEM,
    prompt: `Read this entire catalogue before responding. The JSON below is a lossless transcription of the owner's numbered records.\n\n${JSON.stringify(sourceForModel(records))}`,
    schema: REVIEW_SCHEMA,
    schemaName: 'catalogue_understanding',
    signal: options.signal,
  });
  const checked = validate(toWireSchema(REVIEW_SCHEMA), response.data, { key: 'catalogue-understanding-wire' });
  if (!checked.ok) {
    throw new ProviderOutputError('Foundry could not produce a complete catalogue understanding. Nothing was created.', checked.errors);
  }
  assertCompleteCoverage(checked.data, records);
  return {
    overview: checked.data.overview.trim(),
    productGroups: checked.data.productGroups.map((group) => ({
      ...group,
      records: group.recordOrdinals.map((ordinal) => {
        const record = records.find((candidate) => candidate.ordinal === ordinal);
        return { ordinal, name: record.name, code: record.code || '' };
      }),
    })),
    operationalFindings: checked.data.operationalFindings.map((finding) => {
      const record = records.find((candidate) => candidate.ordinal === finding.recordOrdinal);
      return { ...finding, recordName: record.name, code: record.code || '' };
    }),
    usage: response.usage || null,
  };
}

module.exports = { REVIEW_SCHEMA, SYSTEM, analyze, assertCompleteCoverage, sourceForModel };
