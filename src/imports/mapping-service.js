'use strict';

/**
 * Asking the model what the columns Foundry could not name are for.
 *
 * The deterministic pass in fields.js has already claimed everything it
 * recognises. What reaches the model is the leftovers — "Whse 3 Bal", "Descr 2",
 * "Attribute 1" — together with a few real values from each, because the values
 * are usually what gives a bad header away.
 *
 * The model returns column-to-field pairs and nothing else. It never sees the
 * database, never names a location, never supplies a quantity, and cannot
 * overturn a column the deterministic pass matched confidently. Everything it
 * says is checked against the real columns before it is kept, and the whole
 * mapping is shown to a person before a single record is created.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const fields = require('./fields');

const MAX_COLUMNS_ASKED = 40;
const MAX_SAMPLES = 3;

const MAPPING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['detectedType', 'columns', 'note'],
  properties: {
    detectedType: { type: 'string', enum: fields.DETECTED_TYPES },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['index', 'field', 'axisName'],
        properties: {
          // The column number Foundry gave you. Never a name.
          index: { type: 'integer' },
          field: { type: 'string', enum: [...fields.FIELD_IDS, 'ignore'] },
          // For a variant column only: what the values vary by ("Size").
          axisName: { type: 'string' },
        },
      },
    },
    // One short sentence on anything odd about the file, under 20 words.
    // '' when there is nothing worth saying.
    note: { type: 'string' },
  },
};

const SYSTEM = `You work out what the unclear columns of an inventory file are for.

Foundry has already settled the columns whose headings say plainly what they
are. You are asked about two kinds: the ones it could not name at all, and the
ones it matched on a word that often means something else — those are shown
with what it currently thinks, and you should say so if the values disagree.
You are reading a file, not deciding anything: a person sees your answer as a
proposal and approves it before any record exists.

The fields you may choose from:
- name: what the product is called.
- code: its SKU, part number or barcode.
- description: extra wording about the product, when a separate name column
  already exists.
- unitLabel: the unit it is counted in ("box", "kg", "each").
- variant1, variant2, variant3: columns whose values are versions of the same
  product — a size, a colour, a style. Put the thing they vary BY in axisName.
- quantity: how many there are. Must be a column of numbers.
- location: where the stock is.
- serial: an individual unit's serial number, unique to one physical unit.
- lotCode: a lot or batch code, shared by many units.
- expiresAt, receivedAt: dates.
- notes: free text.
- ignore: anything else. Use this generously.

Rules:
- Choose 'ignore' for prices, costs, suppliers, categories, reorder points,
  sales figures and anything else that is not in the list. Foundry does not
  track those, and putting them somewhere close by is worse than leaving them
  out — say so in your note instead.
- Judge by the values as much as the header. A column headed "Qty" holding
  "box", "each", "case" is unitLabel, not quantity.
- A column of values unique to every row is a serial number. A column whose
  values repeat across rows is a lot code, not a serial number.
- Only answer about the columns you are given. Do not mention the others.
- If you cannot tell what a column is, choose 'ignore'. A wrong guess becomes
  wrong inventory; leaving it out is recoverable.
- Your note is one short sentence — under twenty words — naming the one thing
  worth knowing about this file, or '' if there is nothing. It is shown to a
  person on a screen, not used as reasoning, so do not explain how you decided.
- detectedType describes the file as a whole: 'catalog' is a product list with
  no counts, 'inventory' is products with counts, 'variant_inventory' is the
  same with sizes or colours, 'serials' lists individual units, 'lots' lists
  batches, 'receiving' is a delivery or packing list of what has just arrived.`;

/** The file as the model sees it: columns, a few real values, nothing else. */
function profilePrompt(profile, asked, deterministic, weak = []) {
  const settled = Object.entries(deterministic).filter(([field]) => !weak.includes(field));

  const describe = (column) => {
    const samples = (column.samples || []).slice(0, MAX_SAMPLES);
    // A weakly-held column is presented with what Foundry currently thinks, so
    // the model is correcting a specific reading rather than guessing blind.
    const current = column.currentField
      ? ` — Foundry read this as ${fields.FIELD_LABEL[column.currentField]}, but is not certain`
      : '';
    return `- column ${column.index} “${column.name}”${current} — ${
      samples.length ? `values: ${samples.map((s) => JSON.stringify(s)).join(', ')}` : 'no values'
    }${column.filled === 0 ? ' (empty)' : ''}`;
  };

  const lines = [
    `File: ${profile.sourceName} (${profile.rowCount} rows of data).`,
    '',
    'Columns Foundry has already settled, which you are not being asked about:',
    ...(settled.length
      ? settled.map(
          ([field, index]) =>
            `- ${fields.FIELD_LABEL[field]}: column ${index} “${profile.columnName(index)}”`
        )
      : ['- none']),
    '',
    'Columns to work out:',
    ...(asked.length
      ? asked.slice(0, MAX_COLUMNS_ASKED).map(describe)
      : ['- none; only say what kind of file this is']),
  ];
  return lines.join('\n');
}

/**
 * Keeps only what the model said that survives checking against the real file.
 *
 * A column index that does not exist, a field already taken, a second serial
 * column, a quantity column full of words — all dropped, with the reason kept
 * so the preview can show that Foundry disagreed rather than silently obeyed.
 */
function reconcile(proposed, { columns, deterministic, confident, profilesByIndex }) {
  const mappings = { ...deterministic };
  const taken = new Set(Object.values(deterministic));
  const rejected = [];
  const applied = [];
  const axisNames = {};
  const fieldAt = (index) => Object.keys(mappings).find((field) => mappings[field] === index);

  for (const entry of proposed.columns || []) {
    const index = Number(entry.index);
    const column = columns.find((c) => c.index === index);
    if (!column) continue;                       // a column that is not in the file
    if (!fields.FIELD_IDS.includes(entry.field) && entry.field !== 'ignore') continue;

    const held = fieldAt(index);
    if (held && confident.includes(held)) continue;   // settled by its heading
    if (held && held !== entry.field) {
      // Held only on a catch-all wording, and the model — which saw the values
      // — reads it differently. Releasing it is the point of asking.
      delete mappings[held];
      taken.delete(index);
    }
    if (entry.field === 'ignore') continue;
    if (taken.has(index)) continue;

    if (confident.includes(entry.field)) {
      rejected.push({
        column: column.name,
        field: entry.field,
        because: `Foundry had already matched ${fields.FIELD_LABEL[entry.field]} to another column.`,
      });
      continue;
    }
    if (mappings[entry.field] !== undefined) {
      rejected.push({
        column: column.name,
        field: entry.field,
        because: `Two columns cannot both be ${fields.FIELD_LABEL[entry.field]}.`,
      });
      continue;
    }

    // A quantity has to be a number. This is the one mapping that would put a
    // wrong figure into a real balance, so it is checked against the values.
    const profile = profilesByIndex[index] || {};
    if (entry.field === 'quantity' && profile.filled > 0 && profile.numericRate < 0.6) {
      rejected.push({
        column: column.name,
        field: 'quantity',
        because: `“${column.name}” does not hold numbers.`,
      });
      continue;
    }

    mappings[entry.field] = index;
    taken.add(index);
    applied.push({ column: column.name, field: entry.field });
    if (fields.VARIANT_FIELDS.includes(entry.field)) {
      axisNames[entry.field] = String(entry.axisName || '').trim() || column.name;
    }
  }

  return { mappings, applied, rejected, axisNames };
}

/**
 * @param {{ columns, rows, sourceName }} sheet
 * @returns {Promise<{ mappings, detectedType, axisNames, ... }>}
 */
async function proposeMappings(sheet, options = {}) {
  const guess = fields.guessMappings(sheet.columns, sheet.rows);
  const profilesByIndex = Object.fromEntries(guess.profiles.map((p) => [p.index, p]));
  const axisNames = {};
  for (const field of fields.VARIANT_FIELDS) {
    if (guess.mappings[field] !== undefined) {
      axisNames[field] = (sheet.columns.find((c) => c.index === guess.mappings[field]) || {}).name;
    }
  }

  const base = {
    mappings: guess.mappings,
    detectedType: fields.detectType(guess.mappings),
    axisNames,
    assumptions: [...guess.assumptions],
    ignoredColumns: guess.ignored,
    unnamedColumns: guess.unnamed,
    aiApplied: [],
    aiRejected: [],
    aiNote: '',
    aiUsed: false,
    columnProfiles: guess.profiles,
  };

  const provider = options.provider || (config.ai.configured ? createProviderForTier('fast') : null);
  // Without a provider the deterministic mapping stands on its own. An import
  // is still perfectly possible; the person just does more of the naming.
  if (!provider) return base;

  const unnamed = guess.unnamed.map((column) => profilesByIndex[column.index] || column);
  // Unnamed columns, plus the ones matched only on a catch-all wording. Those
  // are exactly the columns where the values know better than the header.
  const weakColumns = (guess.weak || []).map((field) => ({
    ...(profilesByIndex[guess.mappings[field]] || {}),
    currentField: field,
  }));
  const askable = [...unnamed, ...weakColumns].filter((column) => column.filled > 0);

  // Nothing to ask about. Calling a model to be told what the headings already
  // said would cost a round trip and add an opinion nobody needs.
  if (!askable.length && base.detectedType !== 'unknown') {
    return { ...base, aiSkipped: 'every column was settled from its heading' };
  }

  let response;
  try {
    response = await provider.complete({
      system: SYSTEM,
      prompt: profilePrompt(
        {
          sourceName: sheet.sourceName || 'uploaded file',
          rowCount: sheet.rows.length,
          columnName: (index) => (sheet.columns.find((c) => c.index === index) || {}).name || `column ${index}`,
        },
        askable,
        guess.mappings,
        guess.weak || []
      ),
      schema: MAPPING_SCHEMA,
      schemaName: 'inventory_import_mapping',
    });
  } catch (error) {
    // The file is readable without the model. Losing it costs suggestions,
    // not the import.
    return { ...base, aiError: error.message };
  }

  const result = validate(toWireSchema(MAPPING_SCHEMA), response.data, { key: 'import-mapping-wire' });
  if (!result.ok) return base;

  const reconciled = reconcile(result.data, {
    columns: sheet.columns,
    deterministic: guess.mappings,
    confident: guess.confident,
    profilesByIndex,
  });

  const claimed = new Set(Object.values(reconciled.mappings));
  const detectedType = fields.DETECTED_TYPES.includes(result.data.detectedType)
    ? result.data.detectedType
    : fields.detectType(reconciled.mappings);

  return {
    ...base,
    mappings: reconciled.mappings,
    // The model may only refine the type, never contradict what the columns
    // plainly are: a file with no quantity column is not an inventory file.
    detectedType: reconcilableType(detectedType, reconciled.mappings),
    axisNames: { ...axisNames, ...reconciled.axisNames },
    aiApplied: reconciled.applied,
    aiRejected: reconciled.rejected,
    aiNote: String(result.data.note || '').trim(),
    aiUsed: true,
    ignoredColumns: guess.ignored.filter((column) => !claimed.has(column.index)),
    unnamedColumns: guess.unnamed.filter((column) => !claimed.has(column.index)),
  };
}

/** The model's type, unless the columns cannot support it. */
function reconcilableType(proposed, mappings) {
  const deterministic = fields.detectType(mappings);
  if (proposed === 'receiving' && mappings.quantity !== undefined) return 'receiving';
  if (proposed === deterministic) return proposed;
  if (proposed === 'unknown') return deterministic;
  // 'inventory' vs 'variant_inventory' vs 'catalog' is decided by the columns.
  return deterministic;
}

module.exports = {
  MAPPING_SCHEMA,
  SYSTEM,
  MAX_COLUMNS_ASKED,
  profilePrompt,
  reconcile,
  reconcilableType,
  proposeMappings,
};
