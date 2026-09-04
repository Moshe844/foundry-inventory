'use strict';

/**
 * What a column can mean, and how to recognise it without asking a model.
 *
 * Inventory exports are not arbitrary: "QTY ON HAND", "Qty", "On Hand" and
 * "Quantity" are the same column, and a lookup table settles that instantly,
 * for free, identically every time. The model is worth asking about the columns
 * this file cannot name — "Whse 3 Bal", "Descr 2" — not about the ones it can.
 *
 * Nothing here decides anything on its own. A mapping is a proposal shown to a
 * person before a single record is created.
 */

/**
 * The fields Foundry can actually import into. Deliberately short: every entry
 * corresponds to something Mission 1 stores. A file's "Unit Cost" or "Supplier"
 * column is recognised below as *ignorable* rather than mapped somewhere close,
 * because inventing a home for it would be pretending Foundry does purchasing.
 */
const FIELDS = [
  { id: 'name', label: 'Product name' },
  { id: 'code', label: 'Code or SKU' },
  { id: 'barcode', label: 'Barcode (GTIN, UPC, EAN)' },
  { id: 'description', label: 'Description' },
  { id: 'unitLabel', label: 'Unit of measure' },
  { id: 'variant1', label: 'Variant (1)' },
  { id: 'variant2', label: 'Variant (2)' },
  { id: 'variant3', label: 'Variant (3)' },
  { id: 'quantity', label: 'Quantity' },
  { id: 'sellingPrice', label: 'Selling price' },
  /*
   * What the stock cost, as opposed to what it sells for.
   *
   * This was deliberately ignored — "Foundry does not track supplier cost" —
   * and the consequence was a supplier invoice importing 250 pairs of shoes
   * that were worth nothing at all. The books showed stock with no value, and
   * the first sale of any of it would stop dead on "Foundry has no recorded
   * cost for this product". A cost the supplier wrote on their own invoice is
   * not a figure Foundry is guessing at; it is the one number that makes the
   * inventory it just created mean anything.
   */
  { id: 'unitCost', label: 'Unit cost' },
  { id: 'currency', label: 'Currency' },
  { id: 'location', label: 'Location' },
  { id: 'serial', label: 'Serial number' },
  { id: 'lotCode', label: 'Lot or batch' },
  { id: 'expiresAt', label: 'Expiration date' },
  { id: 'receivedAt', label: 'Received date' },
  { id: 'notes', label: 'Notes' },
];

const FIELD_IDS = FIELDS.map((field) => field.id);
const FIELD_LABEL = Object.fromEntries(FIELDS.map((field) => [field.id, field.label]));
const VARIANT_FIELDS = ['variant1', 'variant2', 'variant3'];

const DETECTED_TYPES = [
  'catalog',
  'inventory',
  'variant_inventory',
  'serials',
  'lots',
  'receiving',
  'unknown',
];

/**
 * Header wordings, most specific first. Matching is scored by how much of the
 * header a pattern explains, so "Item Code" lands on `code` rather than `name`
 * even though both patterns match part of it.
 */
const PATTERNS = {
  sellingPrice: [
    /\b(?:selling|sale|retail|customer|list)\s*price\b/,
    /\b(?:msrp|rrp)\b/,
    /^price(?:\s*each)?$/,
  ],
  currency: [/\b(?:currency|currency\s*code)\b/],
  /*
   * The code a scanner reads off the product.
   *
   * These wordings used to sit inside `code`, so a file carrying both an SKU
   * and a Barcode column had two columns competing for one field. SKU won, and
   * forty real GTINs were dropped as a column Foundry could find no home for.
   *
   * They are different facts: one is what the business calls the product, the
   * other is what is printed on the box. Anything that ever scans needs the
   * second, and it cannot be recovered later from a file nobody kept.
   */
  barcode: [
    /\b(?:barcode|bar\s*code|gtin|upc|ean|jan|isbn)\b/,
  ],
  code: [
    /\b(?:sku|mpn)\b/,
    /*
     * "Style #" is how a shoe or garment supplier writes a product code, and
     * it was being read as a variation because the word "style" also names an
     * axis. A real invoice arrived with Style #, Colour and Size; the style
     * number became a third variant, nothing named a product, and all 65 rows
     * came back "No product name or code in this row" — with SH-1001 sitting
     * in every one of them.
     *
     * The number marker is what separates the two meanings. Bare "Style" is
     * still an axis; "Style #", "Style No" and "Style Code" are the code.
     */
    // The trailing boundary sits inside each alternative on purpose: "#" is
    // not a word character, so a \b after it never matches at the end of a
    // heading — and "Style #" is exactly where a heading ends.
    /\b(?:style|art(?:icle)?|model|design|pattern)\s*(?:#|nos?\.?\b|num(?:ber)?\b|code\b|id\b)/,
    /\b(?:item|product|part|catalog(?:ue)?|stock|material)\s*(?:code|no\.?|num(?:ber)?|id|#)\b/,
    /\b(?:code|part\s*#|ref(?:erence)?)\b/,
  ],
  name: [
    /\b(?:item|product|part|material)\s*(?:name|title|desc(?:ription)?)\b/,
    /\b(?:name|title)\b/,
    /^(?:item|product|part)$/,
  ],
  description: [/\b(?:description|descr?\.?|details?|long\s*desc)\b/],
  unitCost: [
    /\b(?:unit\s*cost|cost\s*(?:price|each|per\s*unit)|wholesale\s*(?:cost|price)|buy(?:ing)?\s*price|purchase\s*price|landed\s*cost)\b/,
    // A bare "Cost" usually is one, but "Line Cost" and "Total Cost" are the
    // row's arithmetic rather than the price of one unit, so they rank below.
    /^costs?$/,
  ],
  quantity: [
    /\b(?:qty|quantity)\b/,
    /\b(?:on\s*hand|onhand|in\s*stock|stock\s*(?:level|count)|available|balance|count(?:ed)?)\b/,
    /\b(?:units?|pieces?|pcs)\b/,
  ],
  location: [
    /\b(?:location|warehouse|whse|wh|site|store|branch|bin|shelf|room|zone|area|facility)\b/,
    // Plain English for the same column. Consolidation matches headings
    // deterministically rather than asking a model, so a file headed "Where"
    // had no location at all, and the same product counted in two files looked
    // like two different positions and was added together instead of compared.
    /\b(?:where|held\s*(?:at|in)?|stored\s*(?:at|in)?|kept\s*(?:at|in)?|depot|premises|place)\b/,
  ],
  serial: [/\b(?:serial|imei|s\/n|sn)\b/],
  lotCode: [/\b(?:lot|batch)\b/],
  expiresAt: [/\b(?:expir\w*|exp\.?|best\s*before|use\s*by|sell\s*by|bbd)\b/],
  receivedAt: [/\b(?:received?|receipt|date\s*in|goods\s*in|arriv\w*|intake)\b/],
  unitLabel: [/\b(?:uom|unit\s*of\s*measure|unit\s*type|measure)\b/, /^units?$/],
  notes: [/\b(?:notes?|comments?|remarks?)\b/],
  variant1: [
    /\b(?:size|colou?r|style|width|length|height|material|finish|flavou?r|capacity|model|fit|pack)\b/,
    /\b(?:variant|option)\s*\d*\b/,
  ],
};
PATTERNS.variant2 = PATTERNS.variant1;
PATTERNS.variant3 = PATTERNS.variant1;

/**
 * Columns Foundry understands but does not import.
 *
 * Naming them is the point: a preview that says "Unit Cost and Supplier were
 * left out — Foundry does not track those" is honest, where silently dropping
 * them looks like a bug and mapping them somewhere would be a lie.
 */
/*
 * Money a supplier charges that is not the goods.
 *
 * Shipping, handling, insurance, duty, a fuel surcharge, a restocking fee.
 * These were read as "supplier cost or calculated pricing" and dropped, so a
 * real invoice put $702.50 of freight and fees nowhere at all: the Money page
 * showed an empty Expenses section beside stock that had genuinely cost more
 * than it said.
 *
 * Recognised as charges rather than mapped to a field, because they do not
 * belong to a product. They belong to the document, and each is kept in the
 * supplier's own wording.
 */
const CHARGE_PATTERNS = [
  { kind: 'freight', pattern: /\b(?:shipping|freight|carriage|delivery|postage|fuel\s*surcharge)\b/ },
  { kind: 'insurance', pattern: /\binsurance\b/ },
  { kind: 'duty', pattern: /\b(?:duty|duties|customs|import|tariff|brokerage)\b/ },
  { kind: 'tax', pattern: /\b(?:vat|gst|hst|tax)\b/ },
  { kind: 'discount', pattern: /\b(?:discount|credit|allowance|rebate)\b/ },
  { kind: 'other', pattern: /\b(?:handling|surcharge|processing|warehouse|packaging|packing|fee)\b/ },
];

/** Which kind of charge a heading or a label names, or null. */
function chargeKindFor(text) {
  const clean = normalise(text);
  if (!clean) return null;
  const hit = CHARGE_PATTERNS.find((entry) => entry.pattern.test(clean));
  return hit ? hit.kind : null;
}

const IGNORED_PATTERNS = [
  { label: 'supplier cost or calculated pricing', pattern: /\b(?:unit\s*cost|purchase\s*price|cost|wholesale|margin|value|amount|total|tax|vat)\b/ },
  { label: 'suppliers', pattern: /\b(?:supplier|vendor|manufacturer|brand|purchase\s*order|\bpo\b)\b/ },
  { label: 'categories', pattern: /\b(?:category|categories|class|group|department|dept|type|family|collection)\b/ },
  { label: 'reorder settings', pattern: /\b(?:reorder|min(?:imum)?\s*(?:qty|level|stock)|max(?:imum)?\s*(?:qty|level)|safety\s*stock|lead\s*time)\b/ },
  { label: 'sales figures', pattern: /\b(?:sold|sales|revenue|orders?|shipped|invoice)\b/ },
  { label: 'weights and sizes', pattern: /\b(?:weight|volume|cubic|dimension|kg|lbs?)\b/ },
];

const normalise = (text) =>
  String(text || '')
    .toLowerCase()
    .replace(/[_\-.]+/g, ' ')
    .replace(/[^a-z0-9/#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** How much of the header one pattern explains, 0 when it does not match. */
function score(header, pattern) {
  const match = pattern.exec(header);
  if (!match) return 0;
  return match[0].length / Math.max(header.length, 1);
}

function bestFieldScores(header) {
  const clean = normalise(header);
  if (!clean) return [];
  const scores = [];
  for (const field of FIELD_IDS) {
    const patterns = PATTERNS[field];
    if (!patterns) continue;
    let best = 0;
    let bestRank = 0;
    patterns.forEach((pattern, rank) => {
      // Earlier patterns are the more specific wordings, so a match on one
      // outranks a looser match further down the list.
      const value = score(clean, pattern) * (1 - rank * 0.08);
      if (value > best) { best = value; bestRank = rank; }
    });
    // The last pattern for a field is its catch-all — "ref", "code", a bare
    // "item", "units". Those wordings really do appear on columns that are
    // something else, so a match there is a guess, not a recognition.
    if (best > 0) {
      scores.push({ field, score: best, rank: bestRank, weak: bestRank >= patterns.length - 1 && patterns.length > 1 });
    }
  }
  return scores.sort((a, b) => b.score - a.score);
}

/** Which recognised-but-unimportable thing this column holds, if any. */
function ignorableAs(header) {
  const clean = normalise(header);
  const hit = IGNORED_PATTERNS.find((entry) => entry.pattern.test(clean));
  return hit ? hit.label : null;
}

const NUMBERISH = /^-?\s*[\d,]+(?:\.\d+)?$/;

/** What the values in a column look like — used to break header ties. */
function profileColumn(rows, index) {
  const values = rows.map((row) => String(row.cells[index] ?? '').trim()).filter((v) => v !== '');
  const numeric = values.filter((v) => NUMBERISH.test(v)).length;
  const unique = new Set(values.map((v) => v.toLowerCase()));
  return {
    filled: values.length,
    fillRate: rows.length ? values.length / rows.length : 0,
    numericRate: values.length ? numeric / values.length : 0,
    distinct: unique.size,
    samples: values.slice(0, 4),
  };
}

/**
 * Values that are codes rather than words.
 *
 * A letter and a digit together: SH-1001, AB12, 7L665-1. Deliberately not
 * "anything with a digit in it", because a size column of 10.5 and 11 would
 * qualify and become a product code, which is a worse failure than the one
 * this recovers from.
 */
function looksLikeCodes(samples = []) {
  const values = samples.map((value) => String(value || '').trim()).filter(Boolean);
  if (values.length < 2) return false;
  return values.every((value) => /^[a-z0-9][a-z0-9._/-]{2,}$/i.test(value)
    && /[a-z]/i.test(value) && /\d/.test(value));
}

/**
 * Every row must be able to say which product it is about.
 *
 * Foundry refused a whole spreadsheet — 65 rows, every one of them — for
 * having "no product name or code", while every row carried SH-1001 and a
 * description of the shoe. The columns were there; they had been filed under
 * headings that do not identify a product, and nothing looked again.
 *
 * So this looks again, and only ever at what the file already contains. A
 * description is a name when there is no name. A code-shaped column is a code
 * when nothing else identifies anything. Neither invents a value, and each one
 * is stated as an assumption, because a reader has to be able to disagree.
 */
function ensureIdentity(mappings, { columns, profilesByIndex }) {
  const assumptions = [];
  const named = (index) => {
    const column = columns.find((entry) => entry.index === index);
    return column ? column.name : `column ${index + 1}`;
  };

  // Very common shape: one "Description" column and no name at all. That column
  // *is* the product name, and refusing to import until someone renames a
  // header would be Foundry making its own problem the customer's.
  if (mappings.name === undefined && mappings.description !== undefined) {
    mappings.name = mappings.description;
    delete mappings.description;
    assumptions.push(`“${named(mappings.name)}” read as the product name — the file has no separate name column.`);
  }

  if (mappings.name !== undefined || mappings.code !== undefined) return assumptions;

  /*
   * Still nothing to identify a product by, and the import would import
   * nothing at all. A variation whose values are codes is the code.
   */
  for (const field of VARIANT_FIELDS) {
    const index = mappings[field];
    if (index === undefined) continue;
    const profile = profilesByIndex ? profilesByIndex[index] : null;
    if (!profile || !looksLikeCodes(profile.samples)) continue;
    mappings.code = index;
    delete mappings[field];
    assumptions.push(`“${named(index)}” read as the product code — its values look like codes, and nothing else in the file names a product.`);
    break;
  }
  return assumptions;
}

/**
 * The deterministic mapping: header wording, with column contents settling ties.
 *
 * One column per field and one field per column. Anything left unclaimed is
 * reported as unnamed, which is exactly the list worth asking a model about.
 */
function guessMappings(columns, rows) {
  const profiles = columns.map((column) => profileColumn(rows, column.index));

  const claims = [];
  columns.forEach((column, position) => {
    const profile = profiles[position];
    for (const candidate of bestFieldScores(column.name)) {
      let weight = candidate.score;

      // "Units" is a quantity when it holds numbers and a unit of measure when
      // it holds words. The header alone genuinely cannot tell you.
      if (candidate.field === 'quantity') {
        if (profile.filled && profile.numericRate < 0.5) weight -= 0.6;
        else weight += 0.15;
      }
      if (candidate.field === 'unitLabel' && profile.numericRate > 0.5) weight -= 0.6;
      // A serial column that repeats itself is not serial numbers.
      if (candidate.field === 'serial' && profile.filled > 2 && profile.distinct < profile.filled * 0.9) {
        weight -= 0.4;
      }
      if (weight > 0) {
        claims.push({ field: candidate.field, index: column.index, weight, weak: candidate.weak === true });
      }
    }
  });

  claims.sort((a, b) => b.weight - a.weight || a.index - b.index);

  const mappings = {};
  const usedColumns = new Set();
  const confident = new Set();
  for (const claim of claims) {
    if (mappings[claim.field] !== undefined || usedColumns.has(claim.index)) continue;
    // The variant axes are positional: the second variant-ish column is
    // variant2 whether or not its header is the one that scored highest.
    if (VARIANT_FIELDS.includes(claim.field)) continue;
    mappings[claim.field] = claim.index;
    usedColumns.add(claim.index);
    // Matched by a specific wording, which is a real recognition. A catch-all
    // match is left out, so the model is asked about it and may overrule it.
    if (!claim.weak) confident.add(claim.field);
  }

  // Variant axes, in the order the file presents them.
  const variantColumns = columns
    .filter((column) => !usedColumns.has(column.index))
    .filter((column) => bestFieldScores(column.name).some((c) => VARIANT_FIELDS.includes(c.field)))
    .slice(0, VARIANT_FIELDS.length);
  variantColumns.forEach((column, position) => {
    mappings[VARIANT_FIELDS[position]] = column.index;
    usedColumns.add(column.index);
    confident.add(VARIANT_FIELDS[position]);
  });

  if (mappings.name === undefined && mappings.description !== undefined) confident.delete('description');
  const assumptions = ensureIdentity(mappings, { columns, profilesByIndex: profiles });

  const ignored = columns
    .filter((column) => !usedColumns.has(column.index))
    .map((column) => ({ index: column.index, name: column.name, because: ignorableAs(column.name) }));

  return {
    mappings,
    confident: [...confident],
    // Mapped, but on a wording that could mean something else. These are worth
    // a second opinion, because the values usually settle what the header cannot.
    weak: Object.keys(mappings).filter((field) => !confident.has(field)),
    unnamed: ignored.filter((column) => !column.because),
    ignored: ignored.filter((column) => column.because),
    assumptions,
    profiles: columns.map((column, position) => ({ ...column, ...profiles[position] })),
  };
}

/** What kind of file this is, from what the mapping found in it. */
function detectType(mappings) {
  if (mappings.serial !== undefined) return 'serials';
  if (mappings.lotCode !== undefined) return 'lots';
  const hasQuantity = mappings.quantity !== undefined;
  const hasVariant = VARIANT_FIELDS.some((field) => mappings[field] !== undefined);
  if (hasQuantity && hasVariant) return 'variant_inventory';
  if (hasQuantity) return 'inventory';
  if (mappings.name !== undefined || mappings.code !== undefined) return 'catalog';
  return 'unknown';
}

module.exports = {
  CHARGE_PATTERNS, chargeKindFor,
  ensureIdentity, looksLikeCodes,
  FIELDS,
  FIELD_IDS,
  FIELD_LABEL,
  VARIANT_FIELDS,
  DETECTED_TYPES,
  PATTERNS,
  IGNORED_PATTERNS,
  normalise,
  bestFieldScores,
  ignorableAs,
  profileColumn,
  guessMappings,
  detectType,
};
