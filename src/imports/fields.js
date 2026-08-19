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
  { id: 'description', label: 'Description' },
  { id: 'unitLabel', label: 'Unit of measure' },
  { id: 'variant1', label: 'Variant (1)' },
  { id: 'variant2', label: 'Variant (2)' },
  { id: 'variant3', label: 'Variant (3)' },
  { id: 'quantity', label: 'Quantity' },
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
  code: [
    /\b(?:sku|upc|ean|gtin|mpn|barcode)\b/,
    /\b(?:item|product|part|catalog(?:ue)?|stock|material)\s*(?:code|no\.?|num(?:ber)?|id|#)\b/,
    /\b(?:code|part\s*#|ref(?:erence)?)\b/,
  ],
  name: [
    /\b(?:item|product|part|material)\s*(?:name|title|desc(?:ription)?)\b/,
    /\b(?:name|title)\b/,
    /^(?:item|product|part)$/,
  ],
  description: [/\b(?:description|descr?\.?|details?|long\s*desc)\b/],
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
const IGNORED_PATTERNS = [
  { label: 'pricing', pattern: /\b(?:price|cost|msrp|retail|wholesale|margin|value|amount|total|currency|tax|vat)\b/ },
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

  const assumptions = [];

  // Very common shape: one "Description" column and no name at all. That column
  // *is* the product name, and refusing to import until someone renames a
  // header would be Foundry making its own problem the customer's.
  if (mappings.name === undefined && mappings.description !== undefined) {
    mappings.name = mappings.description;
    delete mappings.description;
    // Inferred rather than read off a header, so the model may still disagree.
    confident.delete('description');
    const column = columns.find((c) => c.index === mappings.name);
    assumptions.push(`“${column ? column.name : 'Description'}” read as the product name — the file has no separate name column.`);
  }

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
