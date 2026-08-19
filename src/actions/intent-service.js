'use strict';

/**
 * Reading what a person asked Foundry to do.
 *
 * The model's entire job is to turn a sentence into a typed *intent*: which
 * operation, and which things by the words the person used. It never returns an
 * id, never sees the database, and never touches an inventory function. Every
 * name it produces is resolved deterministically afterwards, and a name that
 * matches two records becomes a question rather than a guess.
 *
 * The distinction between operations carries audit meaning — issuing stock and
 * correcting a count are different claims about what physically happened — so
 * where the wording is genuinely unclear the model is told to ask rather than
 * pick.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { ADJUSTMENT_REASON_IDS, ISSUE_REASON_IDS } = require('../domain/constants');
const { requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

const MAX_INSTRUCTION = 500;

const ACTION_TYPES = [
  'receive',
  'issue',
  'transfer',
  'adjust',
  'add_location',
  'rename_terminology',
  'create_item',
  // Mission 6: buying, and taking delivery of what was bought. Neither one
  // moves stock by itself — a purchase becomes a draft order to approve, and a
  // delivery opens the receiving screen for the orders it might be.
  'purchase',
  'receive_shipment',
  'clarify',
  'unsupported',
];

const MAX_LINES = 6;

/**
 * One requested operation. An instruction naming several products becomes
 * several lines, approved and run together as one plan.
 */
const LINE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'actionType', 'item', 'variant', 'lotCode', 'serials',
    'sourceLocation', 'destinationLocation', 'quantity', 'adjustmentTarget', 'reasonCode',
    'terminologyKey', 'terminologyValue',
    'productName', 'productCode', 'variantAxes', 'unitLabel',
    'supplier', 'purchaseUnit',
  ],
  properties: {
    actionType: { type: 'string', enum: ACTION_TYPES },
    // The product in the person's own words. '' when they named none.
    item: { type: 'string' },
    // The version they named: a colour, a size, both. '' when none.
    variant: { type: 'string' },
    // A lot or batch code, exactly as written. '' when none.
    lotCode: { type: 'string' },
    // Serial numbers, exactly as written.
    serials: { type: 'array', items: { type: 'string' } },
    sourceLocation: { type: 'string' },
    destinationLocation: { type: 'string' },
    // -1 when no number was given.
    quantity: { type: 'integer' },
    // The count it should read AFTER a correction. -1 when not given.
    adjustmentTarget: { type: 'integer' },
    reasonCode: { type: 'string' },
    // rename_terminology only: which word, and what to call it instead.
    terminologyKey: { type: 'string', enum: ['', 'item', 'location', 'variant', 'lot', 'serialUnit'] },
    terminologyValue: { type: 'string' },
    // create_item only.
    productName: { type: 'string' },
    productCode: { type: 'string' },
    // "Colour: Navy, Black | Size: 6 through 12". Ranges are left as written —
    // Foundry expands them, so no size is ever quietly dropped.
    variantAxes: { type: 'string' },
    // purchase / receive_shipment only: the supplier they named, verbatim.
    supplier: { type: 'string' },
    // The unit they counted in, when it was not the item itself: "cases",
    // "boxes", "pallets". '' when they just said a number of items.
    purchaseUnit: { type: 'string' },
    unitLabel: { type: 'string' },
  },
};

const INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines', 'clarifyingQuestion', 'unsupportedReason'],
  properties: {
    lines: { type: 'array', maxItems: MAX_LINES, items: LINE_SCHEMA },
    clarifyingQuestion: { type: 'string' },
    unsupportedReason: { type: 'string' },
  },
};

const SYSTEM = `You turn an inventory instruction into a typed action.

You do not carry the action out and you do not look anything up. Foundry
resolves every name you return against its own records, checks it, shows the
person what will happen, and only runs it once they approve.

Operations you may choose:
- receive: stock arriving into a location.
- issue: stock leaving the business — sold, used, delivered, scrapped, damaged.
- transfer: stock moving between two of their own locations.
- adjust: correcting what the records say, when nothing physically moved. This
  is for counts: "set it to 37", "the count says 40", "we actually have 12".
- add_location: create a new location.
- create_item: add a new product to the catalogue. Put its name in
  productName and its code, if they gave one, in productCode. If it comes in
  variations, put them in variantAxes as "Axis: values | Axis: values", for
  example "Colour: Navy, Black | Size: 6 through 12". Copy ranges exactly as
  written — do not enumerate them yourself.
- purchase: they want to BUY something from a supplier — "order 5 cases of
  navy 8 from ABC", "reorder the low stock shoes", "buy enough to cover the
  next month". Put the supplier in supplier if they named one, and the unit
  they counted in ("cases", "boxes") in purchaseUnit. Leave quantity -1 if
  they did not say a number; Foundry works out how many from its own figures.
  This creates a draft order for them to approve, never an actual purchase.
- receive_shipment: a delivery has arrived — "ABC's shipment arrived", "the
  order from XYZ came in". Put the supplier in supplier. This opens the
  receiving screen; it does not book anything in by itself.
- rename_terminology: change the word Foundry uses for something. Set
  terminologyKey to which one ('item', 'location', 'variant', 'lot',
  'serialUnit') and terminologyValue to the word they want.
- clarify: you need one specific thing before this can be a real action.
- unsupported: it is not one of the above.

Rules:
- Never choose between issue and adjust when the sentence does not make it
  clear. Issuing says stock physically left; adjusting says the record was
  wrong. Getting that wrong falsifies their history. Choose 'clarify' and ask.
- quantity is how many to move. adjustmentTarget is what the count should READ
  afterwards. "Set it to 37" is adjustmentTarget 37, not quantity 37.
- Use -1 for any number that was not given. Never invent one.
- reasonCode for an issue, when clear: ${ISSUE_REASON_IDS.join(', ')}.
- reasonCode for a correction, when clear: ${ADJUSTMENT_REASON_IDS.join(', ')}.
  Never invent a reason for a correction. If they did not say why the count is
  wrong, leave reasonCode '' — Foundry will ask.
- Copy names, lot codes and serial numbers exactly as written. Do not correct
  spelling, expand abbreviations or tidy them up.
- A serial number or lot code identifies one unit or batch, and usually sits
  right next to the product in the sentence. Separate them: "issue laptop
  DL-829193" is item "laptop" with serials ["DL-829193"], and "move 20 of lot
  B-2609" is lotCode "B-2609". Never leave the code inside item — Foundry
  looks the product up by name and will not find one called "laptop DL-829193".
- You do not need to know where stock currently is, or how much of it there is.
  Foundry looks both up. If they did not say where something is coming from,
  leave sourceLocation ''. If they did not say how many, leave quantity -1: an
  instruction with no number means all of whatever is there, and Foundry works
  out how much that is and shows them before anything happens. Never ask for
  either, and never choose 'clarify' because one is missing. A serial number or
  a lot code identifies the stock on its own.
- An instruction may end with " — " and then a short reply to a question
  Foundry already asked: a batch code, a serial number, a location, a reason or
  a number, on its own and out of sentence form. Read that reply as the missing
  detail and put it in its proper field — "sold 85 House Blend 250g from the
  Roastery. — R-2603" is lotCode "R-2603", not part of the product name and not
  a second line. Never ask the same question back.
- Choose 'unsupported' for anything needing purchasing, suppliers, purchase
  orders, sales orders, reordering, barcodes, accounting or manufacturing, and
  say in one line what Foundry cannot do.
- You do not need to ask whether something is counted by quantity, by serial
  number or by lot. Foundry already knows how this business tracks stock and
  applies it. Only set a different one if they explicitly said so.
- Several products in one instruction become several create_item lines.
- clarifyingQuestion and unsupportedReason are '' unless nothing can be done.
- One instruction naming several products becomes several lines: "move 10 navy
  8 and 8 navy 9 to Brooklyn" is two lines. Otherwise return exactly one line.`;

function intentPrompt(instruction, context) {
  const lines = [];
  if (context.locationNames && context.locationNames.length) {
    lines.push(`Their locations: ${context.locationNames.slice(0, 12).join(', ')}.`);
  }
  if (context.itemNames && context.itemNames.length) {
    // Without this the reader cannot tell a one-product inventory from a
    // thousand-product one, so it asks "which product?" of a business that has
    // exactly one. Foundry knows the answer; the reader should too.
    lines.push(
      context.itemNames.length === 1
        ? `They have exactly one product: ${context.itemNames[0]}. Any variant they name belongs to it — never ask which product.`
        : `Their products: ${context.itemNames.slice(0, 40).join(', ')}${context.itemCount > 40 ? `, and ${context.itemCount - 40} more` : ''}.`
    );
  }
  if (context.stockNoun) lines.push(`They call their stock "${context.stockNoun}".`);
  if (context.pendingAction) {
    lines.push(
      `Foundry has already proposed: ${context.pendingAction}. ` +
        'If they are agreeing to that ("do it", "go ahead", "yes"), or changing its ' +
        'quantity, return that same action with the new number.'
    );
  }
  return `${lines.join('\n')}

Instruction: ${instruction}`;
}

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};

function normaliseLine(raw) {
  return {
    actionType: ACTION_TYPES.includes(raw.actionType) ? raw.actionType : 'unsupported',
    item: String(raw.item || '').trim(),
    variant: String(raw.variant || '').trim(),
    lotCode: String(raw.lotCode || '').trim(),
    serials: Array.isArray(raw.serials) ? raw.serials.map((s) => String(s).trim()).filter(Boolean).slice(0, 25) : [],
    sourceLocation: String(raw.sourceLocation || '').trim(),
    destinationLocation: String(raw.destinationLocation || '').trim(),
    quantity: number(raw.quantity),
    adjustmentTarget: number(raw.adjustmentTarget),
    reasonCode: String(raw.reasonCode || '').trim(),
    terminologyKey: String(raw.terminologyKey || '').trim(),
    terminologyValue: String(raw.terminologyValue || '').trim(),
    productName: String(raw.productName || '').trim(),
    productCode: String(raw.productCode || '').trim(),
    supplier: String(raw.supplier || '').trim(),
    purchaseUnit: String(raw.purchaseUnit || '').trim(),
    variantAxes: String(raw.variantAxes || '').trim(),
    unitLabel: String(raw.unitLabel || '').trim(),
    assumptions: [],
  };
}

/** Normalises the wire shape into what the proposal builder expects. */
function normalise(raw) {
  const lines = Array.isArray(raw.lines) ? raw.lines.slice(0, MAX_LINES).map(normaliseLine) : [];
  return {
    lines,
    clarifyingQuestion: String(raw.clarifyingQuestion || '').trim(),
    unsupportedReason: String(raw.unsupportedReason || '').trim(),
  };
}

/** Turns an instruction into a validated intent. Never returns free-form SQL. */
async function readInstruction(instruction, options = {}) {
  const clean = requireText(instruction, 'Instruction', { max: MAX_INSTRUCTION });
  if (!options.provider && !config.ai.configured) {
    throw new ValidationError('Foundry needs an AI provider configured before it can read instructions.');
  }

  const provider = options.provider || createProviderForTier('standard');
  const response = await provider.complete({
    system: SYSTEM,
    prompt: intentPrompt(clean, options.context || {}),
    schema: INTENT_SCHEMA,
    schemaName: 'inventory_action_intent',
  });

  const result = validate(toWireSchema(INTENT_SCHEMA), response.data, { key: 'action-intent-wire' });
  if (!result.ok) {
    return {
      lines: [],
      clarifyingQuestion: 'Foundry could not work out what that meant. Could you say it another way?',
      unsupportedReason: '',
    };
  }
  return normalise(result.data);
}

module.exports = {
  INTENT_SCHEMA,
  LINE_SCHEMA,
  MAX_LINES,
  ACTION_TYPES,
  SYSTEM,
  MAX_INSTRUCTION,
  readInstruction,
  normalise,
  normaliseLine,
  intentPrompt,
};
