'use strict';

/**
 * Reading what a person asked StockChief to do.
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

const { createProviderForTier, ProviderError, ProviderOutputError } = require('../ai/provider');
const config = require('../config');
const removals = require('./removals');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { ADJUSTMENT_REASON_IDS, ISSUE_REASON_IDS } = require('../domain/constants');
const { requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');

// A real operating instruction often contains a complete product definition,
// BOM, handling rules and exceptions. Five hundred characters forced people
// to strip out exactly the evidence StockChief needs to avoid guessing.
const MAX_INSTRUCTION = 10000;

const ACTION_TYPES = [
  'receive',
  'issue',
  'transfer',
  'adjust',
  'add_location',
  'rename_terminology',
  'create_item',
  'configure_kit',
  'archive_item',
  /*
   * Retiring something that is not stock: a supplier, a customer, a location.
   * One action type for all of them, because what changes between them is the
   * table it lives in, not what the person meant. Which kinds exist is the
   * registry's business, not this file's — see actions/removals.js.
   */
  removals.ACTION_TYPE,
  // Mission 6: buying, and taking delivery of what was bought. Neither one
  // moves stock by itself — a purchase becomes a draft order to approve, and a
  // delivery opens the receiving screen for the orders it might be.
  'purchase',
  'receive_shipment',
  /*
   * Money going out to a supplier. Separate from receiving on purpose: paying
   * for goods does not deliver them and receiving them does not pay for them,
   * and a system that treats either as the other will eventually tell somebody
   * their shelves are full because the invoice was settled.
   */
  'pay_supplier',
  /*
   * Getting rid of the whole inventory.
   *
   * Every other operation here is about stock, and until this existed the
   * reader had nothing correct to choose for "remove the entire inventory".
   * It did what anybody would with the wrong vocabulary: picked the nearest
   * thing — issue, or adjust — and asked which item was meant. Somebody who
   * had just said "the entire inventory" was asked which item they meant,
   * twice.
   *
   * The reader was not misreading. StockChief did not have the concept. This is
   * the concept.
   */
  'delete_inventory',
  /*
   * Writing to somebody.
   *
   * StockChief has three working paths for this — replies to customers, supplier
   * messages, and shipping and payment notices — and it sent a real one
   * today. None of that was in this list, so a reader asked to email somebody
   * had no correct option and said "StockChief cannot send emails to customers
   * or suppliers". It can. It just could not say so from here.
   */
  'send_message',
  'clarify',
  'unsupported',
];

/**
 * How many operations StockChief will read out of one instruction.
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
    'actionType', 'item', 'variant', 'recordKind', 'recordName', 'lotCode', 'serials',
    'sourceLocation', 'destinationLocation', 'quantity', 'adjustmentTarget', 'reasonCode',
    'terminologyKey', 'terminologyValue',
    'productName', 'productCode', 'variantAxes', 'unitLabel', 'kitComponents',
    'sellingPrice', 'unitCost',
    'supplier', 'purchaseUnit',
    'amount', 'reference',
    'recipient', 'messageBody',
  ],
  properties: {
    actionType: { type: 'string', enum: ACTION_TYPES },
    // The product in the person's own words. '' when they named none.
    item: { type: 'string' },
    // The version they named: a colour, a size, both. '' when none.
    variant: { type: 'string' },
    /*
     * archive_record only: which sort of record, and its name.
     *
     * These sit here, beside item and variant, because that is what they are —
     * the identity of the thing the action is about. Written at the tail of the
     * line instead, after every empty string, the reader had nothing left to
     * anchor on and padded the name out: "Downtown Store Location Store Store
     * Store". A name it invents matches no record, so the request dead-ends in
     * a question about a record nobody named.
     *
     * The enum is the registry's list, so a kind added there is a kind the
     * reader may return — and one removed there stops being accepted.
     */
    recordKind: { type: 'string', enum: ['', ...removals.kinds()] },
    recordName: { type: 'string' },
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
    // StockChief expands them, so no size is ever quietly dropped.
    variantAxes: { type: 'string' },
    // configure_kit only. The kit itself is named by item/variant; each exact
    // component identity and required quantity stays separate and auditable.
    kitComponents: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['item', 'variant', 'quantity'],
        properties: {
          item: { type: 'string' },
          variant: { type: 'string' },
          quantity: { type: 'integer' },
        },
      },
    },
    // purchase / receive_shipment only: the supplier they named, verbatim.
    supplier: { type: 'string' },
    purchaseExpectedDate: { type: 'string' },
    purchaseDateSource: { type: 'string' },
    deliveryInstructions: { type: 'string' },
    trackingMode: { type: 'string', enum: ['', 'quantity', 'lot', 'serial'] },
    trackingSource: { type: 'string' },
    // pay_supplier only: how much left the account, in the currency they typed.
    // -1 when they gave no figure.
    amount: { type: 'number' },
    // The invoice or bill number they named, exactly as written. '' when none.
    reference: { type: 'string' },
    // send_message only: who it goes to, and what they want said. Their
    // words, not a composed version of them.
    recipient: { type: 'string' },
    messageBody: { type: 'string' },
    // The unit they counted in, when it was not the item itself: "cases",
    // "boxes", "pallets". '' when they just said a number of items.
    purchaseUnit: { type: 'string' },
    unitLabel: { type: 'string' },
    // create_item only: the selling price and the cost price they stated, in
    // the currency they typed ("$100.00" is 100). -1 when they gave none.
    // A price the person stated and the reader dropped would be a product
    // added at no price, presented as done.
    sellingPrice: { type: 'number' },
    unitCost: { type: 'number' },
  },
};

/*
 * Fields that must be on the wire, and may be missing on the way back.
 *
 * The schema sent to the model lists amount, reference, recipient and
 * messageBody as required, because a reader told they are optional leaves
 * them out — and a message with no recipient is a question, not a draft. But
 * an answer that omits them is still a perfectly good answer about a stock
 * movement, and rejecting it turned every older scripted reply into
 * "StockChief could not work out what that meant". So the wire demands them and
 * the check on the way back does not; normaliseLine fills the blanks.
 */
const OPTIONAL_ON_READ = ['amount', 'reference', 'recipient', 'messageBody',
  // Same bargain for the removal fields: demanded on the wire so the reader
  // fills them in, forgiven on the way back so every reply written before
  // they existed is still a perfectly good answer about something else.
  'recordKind', 'recordName', 'kitComponents', 'purchaseExpectedDate', 'purchaseDateSource',
  'deliveryInstructions', 'trackingMode', 'trackingSource', 'sellingPrice', 'unitCost'];
const ACCEPTED_LINE_SCHEMA = {
  ...LINE_SCHEMA,
  required: LINE_SCHEMA.required.filter((key) => !OPTIONAL_ON_READ.includes(key)),
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

const ACCEPTED_INTENT_SCHEMA = {
  ...INTENT_SCHEMA,
  properties: {
    ...INTENT_SCHEMA.properties,
    lines: { ...INTENT_SCHEMA.properties.lines, items: ACCEPTED_LINE_SCHEMA },
  },
};

const SYSTEM = `You turn an inventory instruction into a typed action.

You do not carry the action out and you do not look anything up. StockChief
resolves every name you return against its own records, checks it, shows the
person what will happen, and only runs it once they approve.

Operations you may choose:
- receive: stock arriving into a location.
- issue: stock leaving the business — sold, used, delivered, scrapped, damaged.
- transfer: stock moving between two of their own locations.
- adjust: correcting what the records say, when nothing physically moved. This
  is for counts: "set it to 37", "the count says 40", "we actually have 12".
- add_location: create a new location. Put its name, exactly as they said
  it, in destinationLocation — "add a location called Service Van 3" is
  destinationLocation "Service Van 3".
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
  A stated selling price goes in sellingPrice and a stated cost, cost price or
  purchase price in unitCost, as plain numbers in the currency typed; -1 when
  not stated. Every product listed is its own create_item line, with its own
  quantity and prices — a list of two products is two lines, never one.
- configure_kit: define or replace a kit/BOM for an existing customer-facing
  SKU. Put the kit SKU or product in item and any variant in variant. Put every
  explicitly named component SKU/product, variant and required whole-number
  quantity in kitComponents. A kit is not an issue and its components are not
  separate customer order lines: StockChief keeps the kit as the saleable SKU and
  uses this definition to reserve, pick, fulfil and return the physical
  components. Never invent a component or quantity. Never downgrade a required
  kit/BOM capability to a manual workaround or label it unsupported.
- archive_item: remove, archive or deactivate an existing catalogue product or
  variant. Use this for requests such as "remove SKU-10 from my inventory" or
  "delete the item I added by mistake". This changes whether the catalogue
  record is active; it is never a stock-count correction. Copy the named
  product/code into item and any named variation into variant. StockChief will
  refuse safely if the record still has stock on hand.
${removals.promptSection()}
- purchase: they want to BUY something from a supplier — "order 5 cases of
  navy 8 from ABC", "reorder the low stock shoes", "buy enough to cover the
  next month". Put the supplier in supplier if they named one, and the unit
  they counted in ("cases", "boxes") in purchaseUnit. Leave quantity -1 if
  they did not say a number; StockChief works out how many from its own figures.
  This creates a draft order for them to approve, never an actual purchase.
  A purchase can introduce a brand-new SKU. Preserve its human product name in productName,
  its stated SKU in productCode, and its inventory unit in unitLabel when explicitly supplied.
  Do not substitute a catalogue product just because the new SKU is absent from context.
  Copy delivery instructions/address verbatim into deliveryInstructions. Put a stated arrival
  date in purchaseExpectedDate as YYYY-MM-DD and its exact supporting excerpt in purchaseDateSource.
  Preserve explicitly stated stock tracking in trackingMode with an exact excerpt in trackingSource.
  Leave each unstated field empty; ordering alone does not imply quantity, lot or serial tracking.
- send_message: write to somebody — "email motty@example.com that the order
  is delayed", "tell ABC we need the shipment by Friday", "let the customer
  know it shipped". Put who it is going to in recipient: an email address
  exactly as written, or the customer or supplier name they used. Put what
  they want said in messageBody, in their own words — do not compose, expand
  or improve it. StockChief writes the message and shows it before anything is
  sent. Never refuse this; sending messages is something StockChief does.
- delete_inventory: the whole inventory is to go — the workspace itself, not
  a product in it and not a stock count. Every way of saying that belongs
  here: remove/delete/wipe/erase/scrap/bin/destroy/throw away the inventory,
  this workspace, everything, the whole thing, all of it, the data; wanting to
  start over, start fresh, begin again, or shut it down. Asking HOW to delete
  it is the same request. Never read it as issue, adjust or archive_item, and
  never ask which item or location was meant — they told you, it is all of it.
  Choose this whenever that is what was asked for, whatever StockChief then does
  about it; it is a classification, not a promise to carry it out.
- pay_supplier: money was paid to a supplier — "I paid ABC $100 toward
  invoice 9281", "paid the remaining 140", "we sent Langchi the deposit". Put
  the supplier in supplier, the figure in amount, and any invoice or bill
  number they named in reference. StockChief records what was paid and what is
  still owed. Paying for goods is NEVER receiving them: it changes no stock,
  and an instruction that only mentions money is only ever this.
- receive_shipment: a delivery has arrived — "ABC's shipment arrived", "the
  order from XYZ came in". Put the supplier in supplier. This opens the
  receiving screen; it does not book anything in by itself.
- rename_terminology: change the word StockChief uses for something. Set
  terminologyKey to which one ('item', 'location', 'variant', 'lot',
  'serialUnit') and terminologyValue to the word they want.
- clarify: you need one specific thing before this can be a real action.
- unsupported: it is not one of the above.

Rules:
- archive_item and archive_record are both "remove this", and what separates
  them is what is being removed, never the verb. A product or variant — a thing
  they hold stock of — is archive_item. ${removals.labelList('A ')} is
  archive_record. "delete the navy 8" is archive_item; "delete ABC Apparel", a
  supplier, is archive_record with recordKind "supplier". When they say which
  sort of record it is, take them at their word rather than guessing from the
  name. When the sentence truly does not say — a bare name that could be either
  — choose 'clarify' and ask which one they mean.
- Never choose between issue and adjust when the sentence does not make it
  clear. Issuing says stock physically left; adjusting says the record was
  wrong. Getting that wrong falsifies their history. Choose 'clarify' and ask.
- Once the operation itself is clear, do not choose 'clarify' merely because a
  product, variant axis, location, supplier, quantity, batch, unit or reason is
  incomplete. Return the operation with exactly the fields the person supplied
  and leave the missing fields empty. StockChief resolves those fields against the
  real workspace and asks a grounded question with the actual candidates.
- quantity is how many to move. adjustmentTarget is what the count should READ
  afterwards. "Set it to 37" is adjustmentTarget 37, not quantity 37.
- Use -1 for any number that was not given. Never invent one.
- reasonCode for an issue, when clear: ${ISSUE_REASON_IDS.join(', ')}.
- reasonCode for a correction, when clear: ${ADJUSTMENT_REASON_IDS.join(', ')}.
  Never invent a reason for a correction. If they did not say why the count is
  wrong, leave reasonCode '' — StockChief will ask.
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
  B-2609" is lotCode "B-2609". Never leave the code inside item — StockChief
  looks the product up by name and will not find one called "laptop DL-829193".
- You do not need to know where stock currently is, or how much of it there is.
  StockChief looks both up. If they did not say where something is coming from,
  leave sourceLocation ''. If they did not say how many, leave quantity -1: an
  instruction with no number means all of whatever is there, and StockChief works
  out how much that is and shows them before anything happens. Never ask for
  either, and never choose 'clarify' because one is missing. A serial number or
  a lot code identifies the stock on its own.
- An instruction may end with " — " and then a short reply to a question
  StockChief already asked: a batch code, a serial number, a location, a reason or
  a number, on its own and out of sentence form. Read that reply as the missing
  detail and put it in its proper field — "sold 85 House Blend 250g from the
  Roastery. — R-2603" is lotCode "R-2603", not part of the product name and not
  a second line. Never ask the same question back.
- Never state what StockChief cannot do beyond "that is not one of the operations
  listed above". You are shown a list of operations, not a list of StockChief's
  abilities, and it does far more than this list — it emails customers and
  suppliers, keeps books, deletes inventories, takes payments. Three times a
  reader with no matching operation invented a limitation instead: "StockChief
  cannot send emails", "StockChief cannot delete an inventory", "StockChief does not
  handle payments". All three were false and all three were read by the owner
  as fact. If nothing here matches, say only that, and say it in one line.
- Choose 'unsupported' for anything StockChief has no operation for, and
  say in one line what StockChief cannot do.
- You do not need to ask whether something is counted by quantity, by serial
  number or by lot. StockChief already knows how this business tracks stock and
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
    // exactly one. StockChief knows the answer; the reader should too.
    lines.push(
      context.itemNames.length === 1
        ? `They have exactly one product: ${context.itemNames[0]}. Any variant they name belongs to it — never ask which product.`
        : `Their products: ${context.itemNames.slice(0, 40).join(', ')}${context.itemCount > 40 ? `, and ${context.itemCount - 40} more` : ''}.`
    );
  }
  if (context.stockNoun) lines.push(`They call their stock "${context.stockNoun}".`);
  // From the conversation ledger: what “that PO” or “the draft” means here.
  if (context.referentNote) lines.push(`Earlier things on the table: ${require('../ai/guard').recordValue(context.referentNote, { max: 600 })}.`);
  if (context.pendingAction) {
    lines.push(
      `StockChief has already proposed: ${context.pendingAction}. ` +
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
  const line = {
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
    purchaseExpectedDate: String(raw.purchaseExpectedDate || '').trim(),
    purchaseDateSource: String(raw.purchaseDateSource || '').trim(),
    deliveryInstructions: String(raw.deliveryInstructions || '').trim(),
    trackingMode: ['', 'quantity', 'lot', 'serial'].includes(raw.trackingMode) ? raw.trackingMode : '',
    trackingSource: String(raw.trackingSource || '').trim(),
    // An unknown kind is dropped rather than passed on: the proposal builder
    // would only fail to find a registry entry for it, later and less clearly.
    recordKind: removals.get(raw.recordKind) ? String(raw.recordKind).trim().toLowerCase() : '',
    recordName: String(raw.recordName || '').trim(),
    /*
     * What was paid, kept in minor units from here on so no later step has to
     * guess whether "140" meant dollars or cents. -1 when no figure was given,
     * matching every other number on this line.
     */
    amountMinor: Number.isFinite(Number(raw.amount)) && Number(raw.amount) >= 0
      ? Math.round(Number(raw.amount) * 100) : -1,
    reference: String(raw.reference || '').trim(),
    recipient: String(raw.recipient || '').trim(),
    messageBody: String(raw.messageBody || '').trim(),
    variantAxes: String(raw.variantAxes || '').trim(),
    unitLabel: String(raw.unitLabel || '').trim(),
    sellingPriceMinor: Number.isFinite(Number(raw.sellingPrice)) && Number(raw.sellingPrice) >= 0 ? Math.round(Number(raw.sellingPrice) * 100) : -1,
    unitCostMinor: Number.isFinite(Number(raw.unitCost)) && Number(raw.unitCost) >= 0 ? Math.round(Number(raw.unitCost) * 100) : -1,
    kitComponents: Array.isArray(raw.kitComponents)
      ? raw.kitComponents.slice(0, 100).map((component) => ({
          item: String(component && component.item || '').trim(),
          variant: String(component && component.variant || '').trim(),
          quantity: number(component && component.quantity),
        }))
      : [],
    assumptions: [],
  };
  // Deterministic structured-catalogue evidence never crosses the model wire.
  // Preserve its complete record for reconciliation, preview and execution.
  if (raw.catalogueRecord && typeof raw.catalogueRecord === 'object') {
    line.catalogueRecord = JSON.parse(JSON.stringify(raw.catalogueRecord));
  }
  return line;
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
        `That asks for ${raws.length} separate changes and StockChief reads up to ${MAX_LINES} at once. `
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
  const structured = require('./structured-catalogue').parse(source);
  if (structured) {
    return {
      ...structured,
      lines: structured.lines.map((line) => normaliseLine(line)),
    };
  }
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
 * An explicit email address plus an explicit message body is already complete
 * routing evidence. Preserve both literally instead of making availability of
 * this safe draft path depend on a model response. This recognizes a grammar,
 * not a particular recipient or sentence; names and implicit recipients still
 * go through the language reader and deterministic business-record lookup.
 */
function deterministicOutboundMessage(instruction) {
  const source = String(instruction || '').trim();
  const match = /^(?:please\s+)?(?:email|e-mail|message|write\s+to|send\s+(?:an?\s+)?(?:email|message)\s+to)\s+([^\s@]+@[^\s@]+\.[^\s@]+)\s+(?:that|saying|to\s+say)\s+(.+?)\s*[.!]?$/i.exec(source);
  if (match && match[2].trim()) {
    return {
      lines: [normaliseLine({
        actionType: 'send_message',
        recipient: match[1],
        messageBody: match[2].trim(),
        sourceText: source,
        quantity: -1,
        adjustmentTarget: -1,
      })],
      clarifyingQuestion: '',
      unsupportedReason: '',
    };
  }
  /*
   * "Email the supplier about the delay", "chase ABC Footwear about the
   * order", "tell Acme we need it by Friday". A message is understood the
   * moment somebody says who and what; a recipient given as a role — the
   * supplier, our customer — is understood with something missing, and the
   * message flow asks which one (or takes the only one). It came back from
   * the reader as no lines and a question, which reads as if writing to a
   * supplier were not something StockChief does.
   */
  const spoken = /^(?:please\s+)?(?:email|e-mail|message|write\s+to|contact|chase|remind|ask|tell|send\s+(?:an?\s+)?(?:email|message|note)\s+to)\s+(.+?)\s+(about|regarding|re:?|concerning|that|saying|to\s+say|asking|to\s+ask|and\s+ask|and\s+chase|and\s+tell)\s+(.+?)\s*[.!]?$/i.exec(source);
  if (!spoken) return null;
  const who = spoken[1].replace(/^(?:the|our|my)\s+/i, '').trim();
  if (!who || /\s(?:from|to|into|at)\s/i.test(who) || who.split(/\s+/).length > 6) return null;
  const literal = /^(?:that|saying|to\s+say)$/i.test(spoken[2]);
  const body = literal ? spoken[3].trim() : '';
  return {
    lines: [normaliseLine({
      actionType: 'send_message',
      recipient: who,
      messageBody: body,
      sourceText: source,
      quantity: -1,
      adjustmentTarget: -1,
    })],
    clarifyingQuestion: '',
    unsupportedReason: '',
  };
}

/*
 * Configuration said in words: a new place, or what StockChief calls
 * things. "Add a location called Service Van 3" came back from the reader as
 * add_location with no name in it; the name is the whole instruction.
 */
const TERMINOLOGY_NOUNS = [
  [/^(?:items?|products?|skus?|stock|goods|parts|styles?|articles?|lines)$/i, 'item'],
  [/^(?:locations?|places?|sites?|warehouses?|stores?|branches|depots?)$/i, 'location'],
  [/^(?:variants?|variations?|options?|sizes?|colou?rs?)$/i, 'variant'],
  [/^(?:lots?|batch(?:es)?)$/i, 'lot'],
  [/^(?:serials?|serial\s+(?:units?|numbers?)|units?|assets?)$/i, 'serialUnit'],
];
function deterministicConfiguration(instruction) {
  const source = String(instruction || '').trim().replace(/[.!]+$/, '');
  const place = /^(?:please\s+)?(?:add|create|set\s+up|make|open|register)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:location|warehouse|store|shop|site|van|depot|branch|place|showroom|kitchen|office)\s+(?:called|named|name:?)?\s*["“']?(.+?)["”']?\s*$/i.exec(source);
  if (place && place[1].trim() && !/^(?:for|with|at|in|of)\b/i.test(place[1])) {
    return { lines: [normaliseLine({ actionType: 'add_location', destinationLocation: place[1].trim(),
      sourceText: source, quantity: -1, adjustmentTarget: -1 })], clarifyingQuestion: '', unsupportedReason: '' };
  }
  const wording = /^(?:please\s+)?(?:call|refer\s+to|name|label)\s+(?:our|the|my|all)?\s*([a-z][a-z ]{1,24}?)\s+(?:as\s+)?["“']?([A-Za-z][A-Za-z0-9 -]{0,40}?)["”']?\s*(?:instead|from\s+now\s+on|going\s+forward|please)?\s*$/i.exec(source)
    || /^(?:please\s+)?(?:rename|change)\s+(?:the\s+word\s+|the\s+term\s+)?["“']?([a-z][a-z ]{1,24}?)["”']?\s+to\s+["“']?([A-Za-z][A-Za-z0-9 -]{0,40}?)["”']?\s*(?:instead|from\s+now\s+on|going\s+forward|everywhere)?\s*$/i.exec(source);
  if (wording) {
    const noun = wording[1].trim();
    const found = TERMINOLOGY_NOUNS.find(([re]) => re.test(noun));
    if (found) {
      return { lines: [normaliseLine({ actionType: 'rename_terminology', terminologyKey: found[1], terminologyValue: wording[2].trim(),
        sourceText: source, quantity: -1, adjustmentTarget: -1 })], clarifyingQuestion: '', unsupportedReason: '' };
    }
  }
  return null;
}

/*
 * The separate changes a person listed.
 *
 * "Please do all of the following: 1) move … 2) move … 21) issue …" is
 * twenty-one changes, and the number of them is knowable from the sentence
 * alone: a numbered marker, a semicolon or a new line starts each one. That
 * count is what the reader's answer is checked against, so an answer with one
 * line for a twenty-one-line request is caught here rather than approved as
 * a complete plan.
 */
function enumeratedClauses(instruction) {
  const clean = String(instruction || '').replace(/\r/g, '').trim();
  const body = clean.replace(/^\s*(?:please\s+)?(?:do|make|handle|process)\s+(?:all\s+(?:of\s+)?)?(?:the\s+)?following\s*[:\-–—]?\s*/i, '');
  const numbered = body.split(/(?:^|\s|;)\s*(?:\(?\d{1,2}[).:\]]|\d{1,2}\s*[-–—])\s+(?=[A-Za-z$£€])/).map((s) => s.trim()).filter(Boolean);
  if (numbered.length > 1) {
    // "Can you add two items 1: … 2: …" — the words before the first marker
    // introduce the list; they are not a third change. An introduction is
    // short, ends in a colon, or names the list ("two items", "these",
    // "the following"); a real first clause carries its own quantity or
    // place.
    const lead = numbered[0];
    const introduces = !/^\s*(?:\(?\d{1,2}[).:\]]|\d{1,2}\s*[-–—])/.test(body)
      && (/[:\-–—]\s*$/.test(lead) || /\b(?:following|these|items?|products?|things|changes|list|both|two|three|four|five|several)\b/i.test(lead) || lead.split(/\s+/).length <= 6)
      && !/\b\d+\s+\S/.test(lead.replace(/\b(?:two|three|four|five)\b/gi, ''));
    const clauses = introduces ? numbered.slice(1) : numbered;
    if (clauses.length > 1) return clauses.map((s) => s.replace(/[;.,]\s*$/, '').trim());
  }
  const separated = body.split(/\s*(?:;|\n)+\s*/).map((s) => s.trim()).filter(Boolean);
  // A heading line ending in a colon introduces the lines under it.
  if (separated.length > 2 && /[:\-–—]\s*$/.test(separated[0])) separated.shift();
  return separated.length ? separated.map((s) => s.replace(/[;.,]\s*$/, '').trim()) : [clean];
}

/*
 * One movement, as most people write it.
 *
 * "move 2 Copper Elbow 1/2 in. from Main Warehouse to Downtown Store" and
 * "issue 1 Solder Wire 500g from Downtown Store as sold" name a quantity,
 * a product, and the places, in that order. Every word of the result is
 * copied from the sentence: the product must be one this inventory has and
 * the places must be its own, or the clause is not read here at all.
 */
const ISSUE_REASONS = { sold: 'sold', sale: 'sold', delivered: 'sold', damaged: 'damaged', damage: 'damaged', scrapped: 'damaged', scrap: 'damaged',
  used: 'used', consumed: 'used', 'used in work': 'used', returned: 'returned', 'returned to supplier': 'returned' };
function movementClause(clause, context = {}) {
  const text = String(clause || '').trim().replace(/[.]+$/, '');
  const transfer = /^(?:please\s+)?(?:move|transfer|send|shift)\s+(\d+)\s+(?:units?\s+of\s+|x\s+)?(.+?)\s+from\s+(?:the\s+)?(.+?)\s+(?:to|into)\s+(?:the\s+)?(.+?)\s*$/i.exec(text);
  const issue = /^(?:please\s+)?(?:issue|take|remove|book\s+out)\s+(\d+)\s+(?:units?\s+of\s+|x\s+)?(.+?)\s+(?:from|out\s+of|at)\s+(?:the\s+)?(.+?)(?:\s+as\s+(.+?))?\s*$/i.exec(text);
  const match = transfer || issue;
  if (!match) return null;
  const sourceLocation = namedMatch(match[3].trim(), context.locationNames);
  if (!sourceLocation || sourceLocation.toLowerCase() !== match[3].trim().toLowerCase().replace(/^the\s+/, '')) return null;
  /*
   * "Move 15 Navy 4 from Main Warehouse to Downtown Store" names the variant
   * and not the product. When both places are the inventory's own, the words
   * between are the product as the person said it; the proposal builder
   * resolves them against the catalogue and asks when they fit more than one
   * or nothing. The plain movement shape used to go to a model for that, and
   * once in a while came back with the wrong figure.
   */
  const said = match[2].trim();
  const named = namedMatch(said, context.itemNames);
  // Only with a real catalogue behind it (the builder must have something
  // to resolve against), and never for words that are themselves a list —
  // "Navy 4 and 8 Navy 5" is two lines, not one product.
  const plainWords = !named && (context.itemNames || []).length > 0 && /^[A-Za-z0-9][A-Za-z0-9 '\/.&-]{0,60}$/.test(said)
    && !namedMatch(said, context.locationNames) && !/\b(?:all|every|each|rest|remaining|of\s+them|it|these|those|and|plus|with)\b|[,;]|\s\d+\s+\S+\s+\d+/i.test(said);
  if (!named && !plainWords) return null;
  const item = named || said;
  const variant = named ? removeNamed(said, named) : '';
  if (transfer) {
    const destinationLocation = namedMatch(match[4].trim(), context.locationNames);
    if (!destinationLocation || destinationLocation.toLowerCase() !== match[4].trim().toLowerCase().replace(/^the\s+/, '')) return null;
    if (destinationLocation === sourceLocation) return null;
    return normaliseLine({ actionType: 'transfer', item, variant, sourceText: text, sourceLocation, destinationLocation,
      quantity: Number(match[1]), adjustmentTarget: -1, reasonCode: '' });
  }
  const reasonWords = String(match[4] || '').trim().toLowerCase();
  if (reasonWords && !ISSUE_REASONS[reasonWords]) return null;
  return normaliseLine({ actionType: 'issue', item, variant, sourceText: text, sourceLocation,
    quantity: Number(match[1]), adjustmentTarget: -1, reasonCode: reasonWords ? ISSUE_REASONS[reasonWords] : '' });
}

/*
 * A list of movements, read without a model when every clause is one.
 *
 * A twenty-one-line transfer list took a model two minutes and came back as
 * one line. Where each clause is the plain movement grammar above, the whole
 * list is read here in the same instant, one line per clause, and nothing
 * is left for a model to lose. A single clause that fails the grammar sends
 * the entire list to the model instead — this never reads half a list.
 */
function deterministicMovementList(instruction, context = {}) {
  const clauses = enumeratedClauses(instruction);
  if (!clauses.length || clauses.length > MAX_LINES) return null;
  const lines = clauses.map((clause) => movementClause(clause, context));
  if (!lines.every(Boolean)) return null;
  return { lines, clarifyingQuestion: '', unsupportedReason: '' };
}

/*
 * A count sheet, as someone writes it after walking the room.
 *
 * "We counted the van today: 8 copper elbow 1/2 in, 12 trail ration pack,
 * 0 solder wire" names one place and then a number and a product per
 * clause. Every product must be one this inventory has, by name, and the
 * place one of its own; otherwise the sentence goes to the model as before.
 * A three-line count took a model half a minute and sometimes timed out;
 * read here it takes none and never loses a line.
 */
function deterministicCountSheet(instruction, context = {}) {
  const clean = String(instruction || '').replace(/\r/g, '').trim();
  const head = /^(?:we|i|they|staff)?\s*(?:just\s+)?(?:counted|did\s+a\s+(?:stock\s*)?count\s+(?:of|at|in)|stock\s*took|stocktake(?:\s+(?:of|at|in))?|count(?:ed)?\s+(?:at|in|of)|physical\s+count\s+(?:at|in|of))\s+(?:the\s+)?(.+?)(?:\s+(?:today|this\s+morning|this\s+afternoon|tonight|yesterday|just\s+now))?\s*[:\-–—]\s*(.+)$/is.exec(clean);
  if (!head) return null;
  // "The van" is Service Van 3 when it is the only van. The place must be
  // one of this inventory's own, by its name or by a word only it has.
  const placeWords = head[1].trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !['the', 'our', 'main', 'back', 'front'].includes(w));
  const places = (context.locationNames || []).filter((name) => {
    const lower = String(name).toLowerCase();
    return lower === head[1].trim().toLowerCase() || placeWords.some((w) => new RegExp(`\\b${escapeRegExp(w)}s?\\b`).test(lower));
  });
  const sourceLocation = namedMatch(head[1].trim(), context.locationNames) || (places.length === 1 ? places[0] : '');
  if (!sourceLocation) return null;
  const clauses = head[2].split(/\s*(?:[,;\n]|\band\b)\s*/i).map((s) => s.trim().replace(/[.]+$/, '')).filter(Boolean);
  if (!clauses.length || clauses.length > MAX_LINES) return null;
  const lines = clauses.map((clause) => {
    const m = /^(\d+)\s*(?:x|×)?\s+(?:units?\s+of\s+)?(.+?)$/i.exec(clause) || /^(.+?)\s*(?:[:=]|\s)\s*(\d+)$/i.exec(clause);
    if (!m) return null;
    const count = /^\d+$/.test(m[1]) ? Number(m[1]) : Number(m[2]);
    const named = /^\d+$/.test(m[1]) ? m[2].trim() : m[1].trim();
    // The product is the person's own words; the proposal builder resolves
    // them against the catalogue and asks when they fit more than one.
    const item = namedMatch(named, context.itemNames) || named;
    if (!item || /^\d/.test(item)) return null;
    return normaliseLine({ actionType: 'adjust', item, variant: named === item ? '' : removeNamed(named, item), sourceText: clause, sourceLocation,
      adjustmentTarget: count, quantity: -1, reasonCode: 'physical_count' });
  });
  if (!lines.every(Boolean)) return null;
  return { lines, clarifyingQuestion: '', unsupportedReason: '' };
}

/**
 * Common, fully explicit stock instructions do not need a model round trip.
 * Every product and location still comes from the workspace context and is
 * resolved again by the normal proposal builder; this parser grants no
 * authority and never supplies a missing business fact.
 */
function deterministicInstruction(instruction, context = {}) {
  const clean = String(instruction || '').trim();
  const outboundMessage = deterministicOutboundMessage(clean);
  if (outboundMessage) return outboundMessage;
  const configuration = deterministicConfiguration(clean);
  if (configuration) return configuration;
  const catalogue = deterministicCatalogueList(clean);
  if (catalogue) return catalogue;
  const movements = deterministicMovementList(clean, context);
  if (movements) return movements;
  const countSheet = deterministicCountSheet(clean, context);
  if (countSheet) return countSheet;
  const kitDefinition = /^(?:make|configure|define|set\s+up)\s+(.+?)\s+(?:as\s+)?(?:a\s+)?(?:kit|bundle|bom|bill\s+of\s+materials)\s+(?:containing|contains|with|made\s+(?:up\s+)?of)\s+(.+?)\s*$/i.exec(clean);
  if (kitDefinition) {
    const componentClauses = kitDefinition[2].split(/\s*[,;]\s*|\s+and\s+/i)
      .map((value) => value.trim()).filter(Boolean);
    const components = componentClauses.map((clause) => {
      const match = /^(\d+)\s*(?:x|×|of)?\s+(.+?)\s*$/i.exec(clause);
      return match ? { item: match[2].trim(), variant: '', quantity: Number(match[1]) } : null;
    });
    if (components.length && components.every(Boolean)) return {
      lines: [normaliseLine({
        actionType: 'configure_kit', item: kitDefinition[1].trim(), variant: '',
        kitComponents: components, sourceText: clean,
        quantity: -1, adjustmentTarget: -1,
      })],
      clarifyingQuestion: '', unsupportedReason: '',
    };
  }
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
    // "… into main warehouse at $4.20 each from acme": the cost and the
    // supplier ride along with the place; they were read past and dropped.
    let placeWords = received[3].trim();
    const cost = /\b(?:at|@|for)\s*\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:each|ea\.?|per unit|a piece|apiece)?\b/i.exec(placeWords);
    const from = /\bfrom\s+([A-Za-z][A-Za-z0-9&'. -]{1,60})$/i.exec(placeWords.replace(/\s*[.]\s*$/, ''));
    const supplier = from ? from[1].trim() : '';
    placeWords = placeWords.replace(/\bfrom\s+[A-Za-z][A-Za-z0-9&'. -]{1,60}$/i, '').replace(/\b(?:at|@|for)\s*\$?\s*\d+(?:\.\d{1,2})?\s*(?:each|ea\.?|per unit|a piece|apiece)?\b/i, '').trim();
    const destinationLocation = namedMatch(placeWords, context.locationNames);
    const saidItem = received[2].trim();
    const namedItem = namedMatch(saidItem, context.itemNames);
    // As for movements: a product said in the person's own words is resolved
    // by the builder, which asks when it fits nothing or more than one.
    const plainItem = !namedItem && (context.itemNames || []).length > 0 && /^[A-Za-z0-9][A-Za-z0-9 '\/.&-]{0,60}$/.test(saidItem)
      && !/\b(?:and|plus|with|all|every|each)\b|[,;]/i.test(saidItem) ? saidItem : '';
    const item = namedItem || plainItem;
    if (destinationLocation && item) return { lines: [normaliseLine({
      actionType: 'receive', item, variant: namedItem ? removeNamed(saidItem, namedItem) : '',
      sourceText: clean, destinationLocation, quantity: Number(received[1]),
      adjustmentTarget: -1, reasonCode: '', supplier,
      unitCost: cost ? Number(cost[1]) : -1,
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

  const purchase = /^(?:order|buy|purchase|(?:create|raise|write|draft|make|prepare)\s+(?:a\s+|an\s+)?(?:po|purchase\s+order)\s+for)\s+(\d+)\s+(?:more\s+)?(.+?)\.?$/i.exec(clean);
  if (purchase) {
    let productWords = purchase[2].trim();
    let supplier = '';
    const from = /^(.*?)\s+from\s+(.+)$/i.exec(productWords);
    if (from) {
      productWords = from[1].trim();
      supplier = from[2].trim();
    }
    /*
     * "12 Copper Elbow and 6 Trail Ration Pack" is two products. Each one
     * becomes its own line so the purchase step can see there are two and
     * say so, instead of a model reading one and the other vanishing.
     */
    const wanted = [`${purchase[1]} ${productWords}`, ...productWords.split(/\s*(?:,|;|\band\b)\s*(?=\d+\s)/i).slice(1)]
      .map((clause, index) => (index === 0 ? clause.replace(/\s*(?:,|;|\band\b)\s*\d+\s.*$/i, '') : clause).trim());
    const lines = wanted.map((clause) => {
      const counted = /^(\d+)\s+(?:more\s+)?(.+)$/i.exec(clause);
      if (!counted) return null;
      let words = counted[2].trim();
      let purchaseUnit = '';
      const packed = /^([^\s]+)\s+of\s+(.+)$/i.exec(words);
      if (packed) {
        purchaseUnit = packed[1].trim();
        words = packed[2].trim();
      }
      const item = namedMatch(words, context.itemNames);
      if (!item) return null;
      return normaliseLine({
        actionType: 'purchase', item, variant: removeNamed(words, item),
        sourceText: clean, quantity: Number(counted[1]), supplier, purchaseUnit,
        adjustmentTarget: -1, reasonCode: '',
      });
    });
    if (lines.length && lines.every(Boolean)) return { lines, clarifyingQuestion: '', unsupportedReason: '' };
  }
  return null;
}

const READ_MAX_TOKENS = Number(process.env.FOUNDRY_AI_READ_MAX_TOKENS || 24000);
const READ_TIMEOUT_MS = Number(process.env.FOUNDRY_AI_READ_TIMEOUT_MS || 75000);

/*
 * What the person is told when the reader fails.
 *
 * "The model ran out of room before finishing its answer" and "Provider
 * request aborted" are true and useless. Each failure becomes one sentence
 * that says what happened, that nothing changed, and what to do next. A
 * refusal keeps its own message; anything else about the provider is
 * reported as the provider being unreachable.
 */
function plainReadingError(err, clock) {
  const timedOut = clock && clock.signal.aborted;
  if (timedOut) {
    return new ValidationError('StockChief took too long to read that and stopped. Nothing changed. Your message is still in the box — try again, or send it in smaller pieces.');
  }
  if (err && err.code === 'ai_refusal') return err;
  if (err && err.code === 'ai_not_configured') return err;
  // A ceiling reached says so in its own words; it is not a service failure.
  if (err && err.status === 429) return new ValidationError(err.message);
  if (err instanceof ProviderOutputError) {
    return new ValidationError('StockChief could not read that instruction all the way through. Nothing changed. Try a shorter sentence, or put each change on its own line.');
  }
  if (err instanceof ProviderError) {
    return new ValidationError('StockChief could not reach its reading service just now. Nothing changed. Please try again in a moment.');
  }
  return err;
}

/** One clause through the model, normalised, with no coverage check. */
async function readOne(text, provider, options = {}) {
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(new Error('read_timeout')), options.readTimeoutMs || READ_TIMEOUT_MS);
  try {
    const response = await provider.complete({
      system: SYSTEM, prompt: intentPrompt(text, options.context || {}), schema: INTENT_SCHEMA,
      schemaName: 'inventory_action_intent', signal: options.signal || clock.signal,
    });
    const result = validate(toWireSchema(ACCEPTED_INTENT_SCHEMA), response.data, { key: 'action-intent-wire' });
    return result.ok ? normalise(result.data) : null;
  } finally { clearTimeout(timer); }
}

/** Turns an instruction into a validated intent. Never returns free-form SQL. */
async function readInstruction(instruction, options = {}) {
  // The ordinary command surface accepts a complete business instruction,
  // including a substantial BOM. Dedicated structured surfaces may allow
  // more, but every route still has a finite server-side limit.
  const requestedMax = Number(options.maxInstruction);
  const maxInstruction = Number.isInteger(requestedMax) && requestedMax >= MAX_INSTRUCTION
    ? Math.min(requestedMax, 20_000)
    : MAX_INSTRUCTION;
  const clean = requireText(instruction, 'Instruction', { max: maxInstruction });
  const deterministic = deterministicInstruction(clean, options.context || {});
  if (deterministic) return deterministic;
  if (!options.provider && !config.ai.configured) {
    throw new ValidationError('StockChief needs an AI provider configured before it can read instructions.');
  }

  /*
   * A long list needs room to be written out: forty lines of structured
   * output plus the reasoning that precedes it is more than the general
   * budget, and running out of room came back as a two-minute wait ending in
   * "the model ran out of room". The reader gets its own budget, and its
   * own clock: past the limit it stops, says so plainly, and nothing changes.
   */
  const provider = options.provider || createProviderForTier('standard', { maxTokens: READ_MAX_TOKENS });
  const clock = options.signal ? null : new AbortController();
  const timer = clock ? setTimeout(() => clock.abort(new Error('read_timeout')), options.readTimeoutMs || READ_TIMEOUT_MS) : null;
  const request = {
    system: SYSTEM,
    prompt: intentPrompt(clean, options.context || {}),
    schema: INTENT_SCHEMA,
    schemaName: 'inventory_action_intent',
    signal: options.signal || clock.signal,
  };
  let response;
  try {
    response = await provider.complete(request);
  } catch (err) {
    throw plainReadingError(err, clock);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const result = validate(toWireSchema(ACCEPTED_INTENT_SCHEMA), response.data, { key: 'action-intent-wire' });
  if (!result.ok) {
    return {
      lines: [],
      clarifyingQuestion: 'StockChief could not work out what that meant. Could you say it another way?',
      unsupportedReason: '',
    };
  }
  const intent = normalise(result.data);
  const expanded = needsNumberedClauseRetry(clean, intent) ? expandSimpleNumberedTransfer(clean, intent) : null;
  if (expanded) return expanded;
  /*
   * Every listed change, or none.
   *
   * The reader is not trusted to have read the whole list: the number of
   * changes the sentence lists is counted here and compared with the number
   * of lines that came back. Fewer lines than clauses used to become a
   * perfectly correct-looking proposal for the first change, approved as if
   * it were all of them.
   */
  let clauses = enumeratedClauses(clean);
  const readsAsChanges = intent.lines.length > 0 && !intent.lines.some((line) => ['clarify', 'unsupported'].includes(line.actionType));
  /*
   * "We sold 3 sweater navy 4 at the store and 2 copper elbow from the van"
   * is two changes in one sentence, joined by "and" before a number. When
   * the reader returned one line for it, the sentence is split there and
   * each half is read with the sentence's own verb in front — "we sold 2
   * copper elbow from the van" — exactly as a numbered list is.
   */
  if (readsAsChanges && clauses.length === 1 && needsNumberedClauseRetry(clean, intent)) {
    const halves = clean.split(/\s*[,;]?\s+(?:and|then|plus|also)\s+(?=\d)/i).map((s) => s.trim()).filter(Boolean);
    const lead = (/^(.*?)\s*\b\d/.exec(halves[0]) || [])[1] || '';
    if (halves.length > 1 && lead) clauses = [halves[0], ...halves.slice(1).map((half) => `${lead} ${half}`)];
  }
  if (readsAsChanges && clauses.length > 1 && intent.lines.length < clauses.length) {
    /*
     * The list is read again, one clause at a time.
     *
     * A reader given two products returned one; given one at a time it
     * returns one each. Each clause is read with the list's introduction in
     * front of it ("add two items" + "sol shoes size 32 …"), and the lines
     * are joined only when every clause came back as exactly one change of
     * the kind the whole list was read as. Otherwise the person is told
     * which clauses were not read — in their own words, not in a template.
     */
    const intro = clean.slice(0, clean.indexOf(clauses[0])).replace(/\s*(?:\(?\d{1,2}[).:\]]|\d{1,2}\s*[-–—])\s*$/, '').trim();
    const each = await Promise.all(clauses.map(async (clause) => {
      try {
        const one = await readOne(`${intro ? `${intro.replace(/[:\-–—]\s*$/, '')}: ` : ''}${clause}`, provider, options);
        if (!one || one.lines.length !== 1 || ['clarify', 'unsupported'].includes(one.lines[0].actionType)) return null;
        // The line must be about this clause: a name from it, or its number.
        const got = one.lines[0];
        const named = [got.item, got.productName, got.recordName, got.supplier, got.recipient].map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
        const about = named.some((name) => clause.toLowerCase().includes(name))
          || (got.quantity > 0 && new RegExp(`\\b${got.quantity}\\b`).test(clause))
          || (got.adjustmentTarget >= 0 && new RegExp(`\\b${got.adjustmentTarget}\\b`).test(clause));
        return about ? got : null;
      } catch { return null; }
    }));
    if (each.every(Boolean)) return { lines: each.map((line, i) => ({ ...line, sourceText: clauses[i] })), clarifyingQuestion: '', unsupportedReason: '' };
    const unread = clauses.filter((clause, i) => !each[i]);
    return {
      lines: [],
      clarifyingQuestion:
        `That lists ${clauses.length} things and StockChief could read ${clauses.length - unread.length} of them, so it prepared none — it will not do part of a list.`
        + ` It could not read: ${unread.slice(0, 5).map((c) => `“${c.slice(0, 90)}”`).join('; ')}${unread.length > 5 ? ` and ${unread.length - 5} more` : ''}.`
        + ' Say that part another way, or send it on its own.',
      unsupportedReason: '',
    };
  }
  if (needsNumberedClauseRetry(clean, intent)) return {
    lines: [],
    clarifyingQuestion:
      'That names more than one thing to do and StockChief could only read one of them, so it prepared none. Put each change on its own line and send them again.',
    unsupportedReason: '',
  };
  return intent;
}

module.exports = {
  INTENT_SCHEMA,
  LINE_SCHEMA,
  MAX_LINES,
  enumeratedClauses,
  deterministicMovementList,
  deterministicCountSheet,
  ACTION_TYPES,
  SYSTEM,
  MAX_INSTRUCTION,
  readInstruction,
  normalise,
  normaliseLine,
  needsNumberedClauseRetry,
  expandSimpleNumberedTransfer,
  deterministicInstruction,
  deterministicOutboundMessage,
  deterministicCatalogueList,
  intentPrompt,
};
