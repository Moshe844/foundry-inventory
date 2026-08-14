'use strict';

/**
 * InventoryConfigurationPlan — the versioned contract describing exactly what
 * Foundry will configure, before it touches the Mission 1 engine.
 *
 * The customer reads a summary of this; the system reads the structure. It is
 * never reduced to prose. A plan is built deterministically from a validated
 * understanding plus the customer's decisions — the model does not author it,
 * which is what keeps model output from reaching the engine unchecked.
 */

const crypto = require('node:crypto');
const { TRACKING_MODE_IDS, LOCATION_KIND_IDS } = require('../domain/constants');

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'workspaceId',
    'sourceDescription',
    'inventoryModel',
    'trackingModes',
    'variantDimensions',
    'serialRules',
    'lotRules',
    'expirationRules',
    'locations',
    'terminology',
    'operationalDefaults',
    'acceptedRecommendations',
    'customerDecisions',
    'foundryDecisions',
    'assumptions',
    'configurationVersion',
    'integrityHash',
  ],
  properties: {
    workspaceId: { type: 'string', minLength: 1 },
    sourceDescription: { type: 'string', maxLength: 4000 },

    inventoryModel: {
      type: 'object',
      additionalProperties: false,
      required: ['primaryArchetype', 'archetypes', 'usesVariants', 'summary'],
      properties: {
        primaryArchetype: { type: 'string', enum: TRACKING_MODE_IDS },
        archetypes: {
          type: 'array',
          items: { type: 'string', enum: ['quantity', 'variant', 'serial', 'lot'] },
        },
        usesVariants: { type: 'boolean' },
        summary: { type: 'string', maxLength: 1000 },
      },
    },

    /** Only modes the engine actually implements may appear. */
    trackingModes: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', enum: TRACKING_MODE_IDS },
    },

    variantDimensions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'exampleValues'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          exampleValues: { type: 'array', items: { type: 'string', maxLength: 60 } },
        },
      },
    },

    serialRules: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'uniquePerItem', 'singleLocationPerUnit', 'trackCondition'],
      properties: {
        enabled: { type: 'boolean' },
        uniquePerItem: { type: 'boolean' },
        singleLocationPerUnit: { type: 'boolean' },
        trackCondition: { type: 'boolean' },
      },
    },

    lotRules: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'requireLotOnReceive', 'trackPerLocation'],
      properties: {
        enabled: { type: 'boolean' },
        requireLotOnReceive: { type: 'boolean' },
        trackPerLocation: { type: 'boolean' },
      },
    },

    expirationRules: {
      type: 'object',
      additionalProperties: false,
      required: ['enabled', 'captureOnReceive'],
      properties: {
        enabled: { type: 'boolean' },
        captureOnReceive: { type: 'boolean' },
      },
    },

    locations: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: LOCATION_KIND_IDS },
        },
      },
    },

    /** Presentation vocabulary. The engine's own names never change. */
    terminology: {
      type: 'object',
      additionalProperties: false,
      required: ['item', 'location', 'serialUnit', 'lot', 'variant'],
      properties: {
        item: { type: ['string', 'null'], maxLength: 40 },
        location: { type: ['string', 'null'], maxLength: 40 },
        serialUnit: { type: ['string', 'null'], maxLength: 40 },
        lot: { type: ['string', 'null'], maxLength: 40 },
        variant: { type: ['string', 'null'], maxLength: 40 },
      },
    },

    operationalDefaults: {
      type: 'object',
      additionalProperties: false,
      required: ['adjustmentsRequireReason', 'allowNegativeStock', 'transfersEnabled'],
      properties: {
        adjustmentsRequireReason: { type: 'boolean' },
        allowNegativeStock: { type: 'boolean' },
        transfersEnabled: { type: 'boolean' },
      },
    },

    acceptedRecommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'scope'],
        properties: {
          title: { type: 'string', maxLength: 120 },
          scope: { type: 'string', enum: ['configuration', 'future'] },
        },
      },
    },

    customerDecisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionId', 'question', 'answerId', 'answerLabel'],
        properties: {
          questionId: { type: 'string', maxLength: 60 },
          question: { type: 'string', maxLength: 300 },
          answerId: { type: 'string', maxLength: 60 },
          answerLabel: { type: 'string', maxLength: 200 },
        },
      },
    },

    /** Decisions the customer delegated, recorded so nothing is invisible. */
    foundryDecisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['questionId', 'question', 'answerId', 'answerLabel', 'because'],
        properties: {
          questionId: { type: 'string', maxLength: 60 },
          question: { type: 'string', maxLength: 300 },
          answerId: { type: 'string', maxLength: 60 },
          answerLabel: { type: 'string', maxLength: 200 },
          because: { type: 'string', maxLength: 400 },
        },
      },
    },

    assumptions: { type: 'array', items: { type: 'string', maxLength: 300 } },
    configurationVersion: { type: 'integer', minimum: 1 },
    integrityHash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  },
};

/**
 * Deterministic hash over everything except the hash field itself, with keys
 * sorted so an identical plan always produces an identical digest.
 */
function computeIntegrityHash(plan) {
  const { integrityHash, ...rest } = plan;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function sealPlan(plan) {
  return { ...plan, integrityHash: computeIntegrityHash(plan) };
}

function verifyPlanIntegrity(plan) {
  return Boolean(plan) && plan.integrityHash === computeIntegrityHash(plan);
}

module.exports = { PLAN_SCHEMA, computeIntegrityHash, sealPlan, verifyPlanIntegrity, stableStringify };
