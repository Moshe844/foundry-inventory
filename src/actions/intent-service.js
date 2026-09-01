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
  'archive_item',
  // Mission 6: buying, and taking delivery of what was bought. Neither one
  // moves stock by itself — a purchase becomes a draft order to approve, and a
  // delivery opens the receiving screen for the orders it might be.
  'purchase',
  'receive_shipment',
  'clarify',
  'unsupported',
];

/**
 * How many operations Foundry will read out of one instruction.
 *
 * Six was far too few for the thing people actually type first: opening stock
 * for a product with variants, across more than one location. "Main Warehouse
 * has 50 Black Small, 40 Black Medium... Downtown Store has 10 Black Small..."
 * is twelve corrections, and the cap silently kept the first six — an approval
 * screen that looked complete while half the sentence had been thrown away.
 *
 * Two colours by three sizes across two locations is twelve; three by five is
 * thirty. The bound exists to keep one request from becoming unbounded work,
 * not to decide what a real instruction looks like, and going past it is now
 * reported rather than trimmed.
 */
const MAX_LINES = 40;

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
    // The shortest exact part of the original instruction that describes this
    // line. It is provenance for multi-action requests, never an invented
    // paraphrase. Older providers may omit it; deterministic alignment then
    // supplies the slice or leaves the line deliberately ungrounded.
    sourceText: { type: 'string' },
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
  written — do not enumerate them yourself. A single stated variation still
  belongs in variantAxes: "white socks size 6" means productName "white socks"
  and variantAxes "Size: 6". If the person says the new product was received,
  arrived, has opening stock, or gives a starting quantity, preserve that
  number in quantity and any stated receiving place in destinationLocation.
  Never reduce a combined add-and-receive request to catalogue creation alone.
- archive_item: remove, archive or deactivate an existing catalogue product or
  variant. Use this for requests such as "remove SKU-10 from my inventory" or
  "delete the item I added by mistake". This changes whether the catalogue
  record is active; it is never a stock-count correction. Copy the named
  product/code into item and any named variation into variant. Foundry will
  refuse safely if the record still has stock on hand.
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
- Once the operation itself is clear, do not choose 'clarify' merely because a
  product, variant axis, location, supplier, quantity, batch, unit or reason is
  incomplete. Return the operation with exactly the fields the person supplied
  and leave the missing fields empty. Foundry resolves those fields against the
  real workspace and asks a grounded question with the actual candidates.
- quantity is how many to move. adjustmentTarget is what the count should READ
  afterwards. "Set it to 37" is adjustmentTarget 37, not quantity 37.
- Use -1 for any number that was not given. Never invent one.
- reasonCode for an issue, when clear: ${ISSUE_REASON_IDS.join(', ')}.
- reasonCode for a correction, when clear: ${ADJUSTMENT_REASON_IDS.join(', ')}.
  Never invent a reason for a correction. If they did not say why the count is
  wrong, leave reasonCode '' — Foundry will ask.
- Copy names, lot codes and serial numbers exactly as written. Do not correct
  spelling, expand abbreviations or tidy them up.
- For every line, copy the shortest exact contiguous part of the instruction
  that describes that one action into sourceText. Preserve every explicitly
  supplied product and variant word in that clause. Never paraphrase it and
  never copy the whole multi-action instruction into every line. For example,
  "sold 2 red large and 3 blue small" has sourceText "2 red large" on the
  first line and "3 blue small" on the second.
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
- Choose 'unsupported' for anything needing accounting or manufacturing, and
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
    sourceText: String(raw.sourceText || '').trim(),
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

/**
 * Normalises the wire shape into what the proposal builder expects.
 *
 * Over the limit is refused, not trimmed. Quietly dropping the tail is the one
 * outcome nobody can catch: the lines that survive are all individually
 * correct, so the preview reads as a complete and accurate plan.
 */
function normalise(raw) {
  const raws = Array.isArray(raw.lines) ? raw.lines : [];
  if (raws.length > MAX_LINES) {
    return {
      lines: [],
      clarifyingQuestion: '',
      unsupportedReason:
        `That asks for ${raws.length} separate changes and Foundry reads up to ${MAX_LINES} at once. `
        + 'It will not carry out part of an instruction, so send it in smaller pieces — '
        + 'one location at a time works well — or bring the quantities in as a file.',
    };
  }
  const lines = [];
  const exactLines = new Set();
  for (const rawLine of raws) {
    const line = normaliseLine(rawLine);
    // Provider retries can occasionally repeat the same structured line even
    // though the person supplied one instruction. An identical typed line is
    // one piece of evidence, not permission to move stock twice. Different
    // products, quantities, places, or source clauses remain separate.
    const identity = JSON.stringify(line);
    if (exactLines.has(identity)) continue;
    exactLines.add(identity);
    lines.push(line);
  }
  return {
    lines,
    clarifyingQuestion: String(raw.clarifyingQuestion || '').trim(),
    unsupportedReason: String(raw.unsupportedReason || '').trim(),
  };
}

/**
 * Detect the ordinary list shape a model must never silently truncate.
 *
 * The deterministic check does not try to interpret the missing action. It
 * merely proves that the sentence contains another numbered clause while the
 * response contains only one action. An exact common transfer grammar can be
 * expanded deterministically; every other shape becomes a question rather
 * than a partial proposal.
 */
function needsNumberedClauseRetry(instruction, intent) {
  return intent.lines.length === 1
    && !['clarify', 'unsupported'].includes(intent.lines[0].actionType)
    && /\b(?:and|then)\s+\d+\b/i.test(String(instruction || ''));
}

/**
 * Expands the most common two-line transfer without another model call.
 * Every field comes directly from the sentence or the already validated first
 * line. Anything outside this exact grammar is left for a human clarification.
 */
function expandSimpleNumberedTransfer(instruction, intent) {
  if (!needsNumberedClauseRetry(instruction, intent)) return null;
  const first = intent.lines[0];
  if (first.actionType !== 'transfer') return null;
  const match = /^\s*(?:move|transfer)\s+(\d+)\s+(.+?)\s+(?:and|then)\s+(\d+)\s+(.+?)\s+from\s+(.+?)\s+to\s+(.+?)\s*$/i
    .exec(String(instruction || ''));
  if (!match) return null;
  const [, firstQuantity, firstIdentity, secondQuantity, secondIdentity, source, destination] = match;
  const item = String(first.item || '').trim();
  const secondHasItem = item && secondIdentity.toLowerCase().includes(item.toLowerCase());
  const secondVariant = secondHasItem
    ? secondIdentity.replace(new RegExp(item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '').trim()
    : secondIdentity.trim();
  return {
    ...intent,
    lines: [
      {
        ...first,
        quantity: Number(firstQuantity),
        sourceText: `${firstQuantity} ${firstIdentity}`,
        sourceLocation: source.trim(),
        destinationLocation: destination.trim(),
      },
      {
        ...first,
        item: secondHasItem ? item : (item ? secondIdentity.trim() : ''),
        variant: item ? secondVariant : secondIdentity.trim(),
        quantity: Number(secondQuantity),
        sourceText: `${secondQuantity} ${secondIdentity}`,
        sourceLocation: source.trim(),
        destinationLocation: destination.trim(),
      },
    ],
  };
}

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namedMatch(text, names = []) {
  return [...names].sort((a, b) => String(b).length - String(a).length)
    .find((name) => new RegExp(`(?:^|\\s)${escapeRegExp(name)}(?:$|\\s)`, 'i').test(text)) || '';
}

function removeNamed(text, name) {
  return name ? String(text).replace(new RegExp(escapeRegExp(name), 'i'), ' ').replace(/\s+/g, ' ').trim()
    : String(text).trim();
}

/**
 * A colon-led catalogue list with an explicit code on every clause is already
 * fully structured evidence. Parsing this small grammar in code prevents a
 * provider from silently returning only the first product. Names and codes are
 * copied from the instruction; this does not infer tracking, variants or stock.
 */
function deterministicCatalogueList(instruction) {
  const source = String(instruction || '');
  const coded = /^\s*(?:create|add)\s*:\s*(.+)\s*$/i.exec(source);
  const declared = /^\s*(?:create|add)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+products?\s*:\s*(.+)\s*$/i.exec(source);
  if (!coded && !declared) return null;
  const countWords = { one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const expected = declared
    ? (countWords[declared[1].toLowerCase()] || Number(declared[1]))
    : null;
  const list = coded ? coded[1] : declared[2];
  const clauses = list.split(/\s*[,;\n]\s*|\s+and\s+/i).map((value) => value.trim()).filter(Boolean);
  if (clauses.length < 2 || clauses.length > MAX_LINES || (expected && clauses.length !== expected)) return null;
  const parsed = clauses.map((clause) => {
    const codeMatch = /^(.*?)\s+(?:sku\s+)?([a-z0-9][a-z0-9._/-]*[-_][a-z0-9._/-]+)\s*$/i.exec(clause);
    if (coded && (!codeMatch || !codeMatch[1].trim())) return null;
    return normaliseLine({
      actionType: 'create_item',
      productName: codeMatch ? codeMatch[1].trim() : clause,
      productCode: codeMatch ? codeMatch[2].trim() : '',
      sourceText: clause,
      quantity: -1,
      adjustmentTarget: -1,
    });
  });
  if (parsed.some((line) => !line)) return null;
  return { lines: parsed, clarifyingQuestion: '', unsupportedReason: '' };
}

/**
 * Common, fully explicit stock instructions do not need a model round trip.
 * Every product and location still comes from the workspace context and is
 * resolved again by the normal proposal builder; this parser grants no
 * authority and never supplies a missing business fact.
 */
function deterministicInstruction(instruction, context = {}) {
  const clean = String(instruction || '').trim();
  const catalogue = deterministicCatalogueList(clean);
  if (catalogue) return catalogue;
  const correction = /^(?:set|correct|adjust)\s+(.+?)\s+to\s+(\d+)\s+(?:after|from|based on)\s+(?:a\s+)?physical count\s*$/i.exec(clean);
  if (correction) {
    const identity = correction[1].trim();
    const sourceLocation = namedMatch(identity, context.locationNames);
    const withoutLocation = removeNamed(identity, sourceLocation);
    const item = namedMatch(withoutLocation, context.itemNames);
    if (sourceLocation && item) return { lines: [normaliseLine({
      actionType: 'adjust', item, variant: removeNamed(withoutLocation, item),
      sourceText: clean, sourceLocation, adjustmentTarget: Number(correction[2]),
      quantity: -1, reasonCode: 'physical_count',
    })], clarifyingQuestion: '', unsupportedReason: '' };
  }

  const received = /^receive\s+(\d+)\s+(?:more\s+)?(.+?)\s+(?:into|at)\s+(.+?)\s*$/i.exec(clean);
  if (received) {
    const destinationLocation = namedMatch(received[3].trim(), context.locationNames);
    const item = namedMatch(received[2].trim(), context.itemNames);
    if (destinationLocation && item) return { lines: [normaliseLine({
      actionType: 'receive', item, variant: removeNamed(received[2], item),
      sourceText: clean, destinationLocation, quantity: Number(received[1]),
      adjustmentTarget: -1, reasonCode: '',
    })], clarifyingQuestion: '', unsupportedReason: '' };
  }

  // Announcing a delivery is not permission to receive stock. The supplier's
  // name is literal evidence from the sentence; the normal receiving workflow
  // will resolve its open orders and ask for the quantities that actually came.
  const supplierDelivery = /^(.+?)(?:'s|’s)\s+(?:shipment|delivery|order)\s+(?:has\s+)?(?:arrived|came\s+in|was\s+delivered)\s*$/i.exec(clean);
  const deliveryFrom = /^(?:the\s+)?(?:shipment|delivery|order)\s+from\s+(.+?)\s+(?:has\s+)?(?:arrived|came\s+in|was\s+delivered)\s*$/i.exec(clean);
  const announcedSupplier = supplierDelivery ? supplierDelivery[1].trim()
    : deliveryFrom ? deliveryFrom[1].trim() : '';
  if (announcedSupplier) return { lines: [normaliseLine({
    actionType: 'receive_shipment', supplier: announcedSupplier, sourceText: clean,
    quantity: -1, adjustmentTarget: -1, reasonCode: '',
  })], clarifyingQuestion: '', unsupportedReason: '' };

  const purchase = /^(?:order|buy|purchase)\s+(\d+)\s+(?:more\s+)?(.+)$/i.exec(clean);
  if (purchase) {
    let productWords = purchase[2].trim();
    let supplier = '';
    const from = /^(.*?)\s+from\s+(.+)$/i.exec(productWords);
    if (from) {
      productWords = from[1].trim();
      supplier = from[2].trim();
    }
    let purchaseUnit = '';
    const packed = /^([^\s]+)\s+of\s+(.+)$/i.exec(productWords);
    if (packed) {
      purchaseUnit = packed[1].trim();
      productWords = packed[2].trim();
    }
    const item = namedMatch(productWords, context.itemNames);
    if (item) return { lines: [normaliseLine({
      actionType: 'purchase', item, variant: removeNamed(productWords, item),
      sourceText: clean, quantity: Number(purchase[1]), supplier, purchaseUnit,
      adjustmentTarget: -1, reasonCode: '',
    })], clarifyingQuestion: '', unsupportedReason: '' };
  }
  return null;
}

/** Turns an instruction into a validated intent. Never returns free-form SQL. */
async function readInstruction(instruction, options = {}) {
  const clean = requireText(instruction, 'Instruction', { max: MAX_INSTRUCTION });
  const deterministic = deterministicInstruction(clean, options.context || {});
  if (deterministic) return deterministic;
  if (!options.provider && !config.ai.configured) {
    throw new ValidationError('Foundry needs an AI provider configured before it can read instructions.');
  }

  const provider = options.provider || createProviderForTier('standard');
  const request = {
    system: SYSTEM,
    prompt: intentPrompt(clean, options.context || {}),
    schema: INTENT_SCHEMA,
    schemaName: 'inventory_action_intent',
  };
  const response = await provider.complete(request);

  const result = validate(toWireSchema(INTENT_SCHEMA), response.data, { key: 'action-intent-wire' });
  if (!result.ok) {
    return {
      lines: [],
      clarifyingQuestion: 'Foundry could not work out what that meant. Could you say it another way?',
      unsupportedReason: '',
    };
  }
  const intent = normalise(result.data);
  if (!needsNumberedClauseRetry(clean, intent)) return intent;
  const expanded = expandSimpleNumberedTransfer(clean, intent);
  if (expanded) return expanded;
  return {
    lines: [],
    clarifyingQuestion:
      'Foundry could not safely separate every numbered change in that instruction. Please put each change on its own line.',
    unsupportedReason: '',
  };
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
  needsNumberedClauseRetry,
  expandSimpleNumberedTransfer,
  deterministicInstruction,
  deterministicCatalogueList,
  intentPrompt,
};
