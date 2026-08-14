'use strict';

/**
 * InventoryUnderstanding — what Foundry believes about a customer's operation.
 *
 * This schema is the contract in both directions: it is sent to the model as
 * the required output format, and every response is validated against it before
 * any other code is allowed to read it. Model output is untrusted input.
 *
 * Every property is listed in `required`, because structured output is strict:
 * the model must emit every key. Fields that may not apply carry an empty
 * string or an empty array rather than being omitted.
 */

const { TRACKING_MODE_IDS, LOCATION_KIND_IDS } = require('../domain/constants');

const CONFIDENCE = ['high', 'medium', 'low'];

/**
 * The complete set of configuration changes a customer answer is allowed to
 * cause. Anything outside this list is not expressible, so a question can never
 * become a back door into the engine.
 */
const ANSWER_EFFECTS = [
  'none',
  'allow_negative_stock',
  'disallow_negative_stock',
  'capture_expiration',
  'skip_expiration',
];

/** Foundry must say which of the four honest states each conclusion is in. */
const CERTAINTY = ['inferred_confidently', 'assumed_safely', 'needs_customer_decision', 'unsupported_today'];

/**
 * Optional prose fields are plain strings rather than string|null unions:
 * constrained decoding limits how many union-typed parameters a schema may
 * carry, and an empty string carries the same "does not apply" meaning. Every
 * reader treats '' as absent.
 */
const optionalText = { type: 'string', maxLength: 2000 };
const stringList = { type: 'array', maxItems: 24, items: { type: 'string', maxLength: 300 } };

const trackingFlag = {
  type: 'object',
  additionalProperties: false,
  required: ['applies', 'certainty', 'reason'],
  properties: {
    applies: { type: 'boolean' },
    certainty: { type: 'string', enum: CERTAINTY },
    reason: optionalText,
  },
};

const UNDERSTANDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'businessDescription',
    'businessType',
    'inventoryPurpose',
    'inventoryExamples',
    'inventoryArchetypes',
    'productStructure',
    'variantDimensions',
    'serializedTracking',
    'lotTracking',
    'expirationTracking',
    'locationModel',
    'likelyLocations',
    'unitsOfMeasure',
    'receivingWorkflow',
    'issuingWorkflow',
    'transferWorkflow',
    'adjustmentWorkflow',
    'likelyRoles',
    'terminology',
    'importantOperationalPatterns',
    'recommendedConfiguration',
    'recommendations',
    'assumptions',
    'unresolvedDecisions',
    'confidence',
    'rationale',
  ],
  properties: {
    businessDescription: { type: 'string', maxLength: 4000 },
    businessType: optionalText,
    inventoryPurpose: optionalText,
    inventoryExamples: stringList,

    /** The archetypes in play. Combinations are normal, not exceptional. */
    inventoryArchetypes: {
      type: 'array',
      maxItems: 4,
      items: { type: 'string', enum: ['quantity', 'variant', 'serial', 'lot'] },
    },

    productStructure: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'levels', 'certainty'],
      properties: {
        summary: optionalText,
        levels: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 80 } },
        certainty: { type: 'string', enum: CERTAINTY },
      },
    },

    variantDimensions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'exampleValues'],
        properties: {
          name: { type: 'string', maxLength: 60 },
          exampleValues: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 60 } },
        },
      },
    },

    serializedTracking: trackingFlag,
    lotTracking: trackingFlag,
    expirationTracking: trackingFlag,

    locationModel: {
      type: 'object',
      additionalProperties: false,
      required: ['summary', 'multipleLocations', 'transfersExpected', 'certainty'],
      properties: {
        summary: optionalText,
        multipleLocations: { type: 'boolean' },
        transfersExpected: { type: 'boolean' },
        certainty: { type: 'string', enum: CERTAINTY },
      },
    },

    likelyLocations: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind', 'certainty'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: LOCATION_KIND_IDS },
          certainty: { type: 'string', enum: CERTAINTY },
        },
      },
    },

    unitsOfMeasure: stringList,

    receivingWorkflow: optionalText,
    issuingWorkflow: optionalText,
    transferWorkflow: optionalText,
    adjustmentWorkflow: optionalText,

    likelyRoles: stringList,

    /** Customer-facing wording only. Never renames a domain concept. */
    terminology: {
      type: 'object',
      additionalProperties: false,
      required: ['item', 'location', 'serialUnit', 'lot', 'variant'],
      properties: {
        item: optionalText,
        location: optionalText,
        serialUnit: optionalText,
        lot: optionalText,
        variant: optionalText,
      },
    },

    importantOperationalPatterns: stringList,

    /** What Foundry intends to configure, in engine vocabulary. */
    recommendedConfiguration: {
      type: 'object',
      additionalProperties: false,
      required: ['trackingMode', 'usesVariants', 'allowNegativeStock', 'summary'],
      properties: {
        trackingMode: { type: 'string', enum: TRACKING_MODE_IDS },
        usesVariants: { type: 'boolean' },
        allowNegativeStock: { type: 'boolean' },
        summary: optionalText,
      },
    },

    recommendations: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'noticed', 'recommendation', 'whyItMatters', 'scope', 'confidence'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 120 },
          noticed: { type: 'string', minLength: 1, maxLength: 600 },
          recommendation: { type: 'string', minLength: 1, maxLength: 600 },
          whyItMatters: { type: 'string', minLength: 1, maxLength: 600 },
          scope: { type: 'string', enum: ['configuration', 'future'] },
          confidence: { type: 'string', enum: CONFIDENCE },
        },
      },
    },

    assumptions: stringList,

    /** Only decisions that materially change inventory behaviour belong here. */
    unresolvedDecisions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'question', 'whyItMatters', 'options', 'recommendedOptionId'],
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]{2,48}$' },
          question: { type: 'string', minLength: 1, maxLength: 300 },
          whyItMatters: { type: 'string', minLength: 1, maxLength: 400 },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label', 'consequence', 'effect'],
              properties: {
                id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,48}$' },
                label: { type: 'string', minLength: 1, maxLength: 160 },
                consequence: { type: 'string', minLength: 1, maxLength: 400 },
                /**
                 * The only configuration levers an answer may move. A question
                 * whose answers cannot be expressed here is still recorded, but
                 * it changes nothing — the model cannot invent a new lever.
                 */
                effect: { type: 'string', enum: ANSWER_EFFECTS },
              },
            },
          },
          recommendedOptionId: { type: 'string', maxLength: 50 },
        },
      },
    },

    confidence: { type: 'string', enum: CONFIDENCE },
    rationale: { type: 'string', minLength: 1, maxLength: 3000 },
  },
};

/**
 * Constrained decoding compiles the schema into a grammar, and that grammar has
 * a size ceiling the full contract exceeds. So the model is asked twice, for
 * two genuinely different jobs — read the operation, then advise on it — and the
 * two halves are merged and validated against the whole contract above. The
 * split is a property of the wire, not of the contract.
 */
function subsetSchema(keys) {
  const properties = {};
  for (const key of keys) properties[key] = UNDERSTANDING_SCHEMA.properties[key];
  return { type: 'object', additionalProperties: false, required: [...keys], properties };
}

const ADVICE_KEYS = ['recommendations', 'unresolvedDecisions'];
const CORE_KEYS = UNDERSTANDING_SCHEMA.required.filter((key) => !ADVICE_KEYS.includes(key));

const CORE_SCHEMA = subsetSchema(CORE_KEYS);
const ADVICE_SCHEMA = subsetSchema(ADVICE_KEYS);

module.exports = {
  UNDERSTANDING_SCHEMA,
  CORE_SCHEMA,
  ADVICE_SCHEMA,
  CORE_KEYS,
  ADVICE_KEYS,
  CONFIDENCE,
  CERTAINTY,
  ANSWER_EFFECTS,
};
