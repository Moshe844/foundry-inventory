'use strict';

/**
 * Taking in whatever the customer already has, and working out what it is.
 *
 * Everything here is deterministic and reuses the Mission 5 reader: the same
 * ZIP/XML parser, the same header location, the same column recognition. There
 * is one import engine in Foundry and this is not a second one — it is the part
 * that looks at a file *before* anyone has decided what to do with it, so that
 * Foundry can propose a configuration rather than ask for one.
 *
 * A source is immutable once stored. The hash over its bytes is what makes
 * "1,842 variants" a claim about specific bytes that can be re-checked later,
 * and what makes uploading the same file twice recognised rather than doubled.
 */

const crypto = require('crypto');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const parser = require('../imports/parser');
const fields = require('../imports/fields');

/** Purposes a file can be recognised as serving. */
const PURPOSES = {
  CATALOG: 'catalog',
  STOCK_COUNT: 'stock_count',
  INVENTORY: 'inventory',
  SERIALS: 'serials',
  LOTS: 'lots',
  SUPPLIERS: 'suppliers',
  PURCHASING: 'purchasing',
  UNKNOWN: 'unknown',
};

const PURPOSE_LABEL = {
  catalog: 'a product list',
  stock_count: 'a physical stock count',
  inventory: 'products with stock counts',
  serials: 'individually numbered units',
  lots: 'batches or lots',
  suppliers: 'a supplier list',
  purchasing: 'purchasing information',
  unknown: 'something Foundry could not identify',
};

/**
 * What a file appears to be for, from its name and its columns.
 *
 * The name is weak evidence and the columns are strong, so the columns win. A
 * file called "count.xlsx" with no quantities is not a stock count.
 */
function inferPurpose(name, mappings, columns) {
  const filename = String(name || '').toLowerCase();
  const headers = columns.map((column) => fields.normalise(column.name)).join(' ');
  const has = (field) => mappings[field] !== undefined;

  if (has('serial')) return { purpose: PURPOSES.SERIALS, confidence: 'high' };
  if (has('lotCode')) return { purpose: PURPOSES.LOTS, confidence: 'high' };

  // A supplier list is products plus who sells them, with no stock of its own.
  if (/supplier|vendor/.test(`${filename} ${headers}`) && !has('quantity')) {
    return { purpose: PURPOSES.SUPPLIERS, confidence: 'medium' };
  }
  if (/purchase order|\bpo\b|on order/.test(`${filename} ${headers}`)) {
    return { purpose: PURPOSES.PURCHASING, confidence: 'low' };
  }

  if (has('quantity')) {
    // "count" in the filename with quantities is the classic physical count —
    // and it matters, because a count is usually newer than an export.
    if (/count|stocktake|stock take|physical|audit/.test(filename)) {
      return { purpose: PURPOSES.STOCK_COUNT, confidence: 'medium' };
    }
    return { purpose: PURPOSES.INVENTORY, confidence: 'high' };
  }
  if (has('name') || has('code')) return { purpose: PURPOSES.CATALOG, confidence: 'high' };
  return { purpose: PURPOSES.UNKNOWN, confidence: 'low' };
}

/**
 * Anything in the file that says how old it is.
 *
 * Only the file's own contents count. A modification timestamp from an upload
 * says when it was saved, not when it was true, and treating one as the other
 * is how a stale count gets preferred over a fresh export.
 */
function inferFreshness(sheets) {
  const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
  const written = new RegExp(String.raw`(\d{1,2})\s+(${MONTHS})\s+(\d{4})`, 'i');
  const dateLike = /(\d{4}-\d{2}-\d{2})|(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/;
  for (const sheet of sheets) {
    // Title rows above the header often carry "Exported 12 August 2026".
    for (const row of (sheet.preamble || []).slice(0, 6)) {
      const text = row.join(' ');
      const iso = /(\d{4}-\d{2}-\d{2})/.exec(text);
      if (iso) return { observedAt: iso[1], basis: `the file says "${text.trim().slice(0, 80)}"` };

      // "Exported 14 August 2026" is how most systems date an export.
      const spelled = written.exec(text);
      if (spelled) {
        const month = MONTHS.split('|').indexOf(spelled[2].toLowerCase()) + 1;
        const day = String(spelled[1]).padStart(2, '0');
        return {
          observedAt: `${spelled[3]}-${String(month).padStart(2, '0')}-${day}`,
          basis: `the file says "${text.trim().slice(0, 80)}"`,
        };
      }
      if (dateLike.test(text) && /export|as of|count|dated|generated|run/i.test(text)) {
        return { observedAt: null, basis: `the file says "${text.trim().slice(0, 80)}"` };
      }
    }
  }
  return { observedAt: null, basis: null };
}

/**
 * Reads a file into the profile the rest of onboarding reasons about.
 *
 * No model is involved. Everything below is counted from the bytes.
 */
function profile(input) {
  const parsed = parser.parse({
    buffer: input.buffer || undefined,
    text: input.buffer ? undefined : input.text,
    filename: input.filename,
  });

  const sheets = parsed.sheets.map((sheet, index) => {
    const guess = fields.guessMappings(sheet.columns, sheet.rows);
    const mappings = guess.mappings;
    const purpose = inferPurpose(input.filename, mappings, sheet.columns);

    // The figures a reconciliation will later be measured against.
    const quantityIndex = mappings.quantity;
    let units = 0;
    let rowsWithQuantity = 0;
    const locations = new Map();
    const identifiers = new Set();

    for (const row of sheet.rows) {
      if (quantityIndex !== undefined) {
        const raw = String(row.cells[quantityIndex] ?? '').trim().replace(/[\s,](?=\d{3}\b)/g, '');
        if (/^\d+$/.test(raw)) {
          units += Number(raw);
          rowsWithQuantity += 1;
        }
      }
      if (mappings.location !== undefined) {
        const where = String(row.cells[mappings.location] ?? '').trim();
        if (where) locations.set(where, (locations.get(where) || 0) + 1);
      }
      const code = mappings.code !== undefined ? String(row.cells[mappings.code] ?? '').trim() : '';
      const name = mappings.name !== undefined ? String(row.cells[mappings.name] ?? '').trim() : '';
      if (code || name) identifiers.add((code || name).toLowerCase());
    }

    const axes = fields.VARIANT_FIELDS.filter((field) => mappings[field] !== undefined).map((field) => {
      const column = sheet.columns.find((c) => c.index === mappings[field]);
      const values = new Set();
      for (const row of sheet.rows) {
        const value = String(row.cells[mappings[field]] ?? '').trim();
        if (value) values.add(value);
      }
      return { axis: column ? column.name : field, values: [...values].slice(0, 40), count: values.size };
    });

    return {
      index,
      name: sheet.name,
      rows: sheet.rows.length,
      headerless: sheet.headerless,
      repeatedHeaderRows: sheet.repeatedHeaderRows,
      columns: sheet.columns.map((column) => ({ index: column.index, name: column.name })),
      samples: sheet.rows.slice(0, 3).map((row) => row.cells),
      mappings,
      ignoredColumns: guess.ignored,
      unnamedColumns: guess.unnamed,
      purpose: purpose.purpose,
      purposeConfidence: purpose.confidence,
      detectedType: fields.detectType(mappings),
      axes,
      totals: {
        rows: sheet.rows.length,
        rowsWithQuantity,
        units,
        distinctIdentifiers: identifiers.size,
        locations: [...locations.entries()].map(([name, rows]) => ({ name, rows })),
      },
    };
  });

  const primary = sheets.length
    ? sheets.reduce((best, sheet) => (sheet.rows > best.rows ? sheet : best), sheets[0])
    : null;

  return {
    format: parsed.format,
    sheetCount: sheets.length,
    sheets,
    primarySheetIndex: primary ? primary.index : 0,
    freshness: inferFreshness(parsed.sheets),
    totals: primary ? primary.totals : { rows: 0, units: 0, distinctIdentifiers: 0, locations: [] },
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const json = (value, fallback) => {
  try {
    return JSON.parse(value) ?? fallback;
  } catch {
    return fallback;
  }
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    kind: row.kind,
    contentHash: row.content_hash,
    bytes: row.bytes,
    profile: json(row.profile, {}),
    inferredPurpose: row.inferred_purpose,
    purposeLabel: PURPOSE_LABEL[row.inferred_purpose] || 'data',
    purposeConfidence: row.purpose_confidence,
    observedAt: row.observed_at,
    freshnessBasis: row.freshness_basis,
    excluded: Boolean(row.excluded),
    createdAt: row.created_at,
  };
}

const MAX_BYTES = 32 * 1024 * 1024;

/**
 * Stores a file and what Foundry made of it.
 *
 * The same bytes uploaded twice return the source that already exists rather
 * than a second copy — somebody uploading the same export again is correcting
 * a mistake, not adding a source.
 */
function addSource(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');

  const buffer = input.buffer || null;
  const text = input.text !== undefined ? input.text : null;
  if (!buffer && !String(text || '').trim()) throw new ValidationError('There was nothing in that.');

  const bytes = buffer || Buffer.from(String(text), 'utf8');
  if (bytes.length > MAX_BYTES) throw new ValidationError('That file is larger than Foundry can read.');

  // Macro-enabled workbooks are refused outright rather than read and trusted.
  const name = trimOrNull(input.filename) || 'pasted data';
  if (/\.(xlsm|xlsb|xltm)$/i.test(name)) {
    throw new ValidationError(
      'Foundry does not open macro-enabled workbooks. Save it as .xlsx or .csv and upload that.'
    );
  }

  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const existing = db
    .prepare('SELECT * FROM migration_sources WHERE workspace_id = ? AND content_hash = ?')
    .get(ctx.workspaceId, contentHash);
  if (existing) return { source: hydrate(existing), alreadyPresent: true };

  const built = profile({ buffer, text, filename: name });
  const primary = built.sheets[built.primarySheetIndex] || built.sheets[0] || null;

  const id = newId('msrc');
  db.prepare(
    `INSERT INTO migration_sources (
       id, workspace_id, uploaded_by_user_id, name, kind, content_hash, bytes, content,
       profile, inferred_purpose, purpose_confidence, observed_at, freshness_basis, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    ctx.workspaceId,
    ctx.actorId,
    name,
    buffer ? (built.format === 'xlsx' ? 'xlsx' : 'csv') : 'paste',
    contentHash,
    bytes.length,
    bytes,
    JSON.stringify(built),
    primary ? primary.purpose : PURPOSES.UNKNOWN,
    primary ? primary.purposeConfidence : 'low',
    built.freshness.observedAt,
    built.freshness.basis,
    nowIso()
  );

  return { source: get(db, ctx.workspaceId, id), alreadyPresent: false };
}

/** The bytes as handed over, for re-reading the real rows. */
function contentOf(db, workspaceId, sourceId) {
  const row = db
    .prepare('SELECT content, name FROM migration_sources WHERE id = ? AND workspace_id = ?')
    .get(sourceId, workspaceId);
  if (!row || !row.content) throw new NotFoundError('That file is no longer stored.');
  return { buffer: Buffer.from(row.content), filename: row.name };
}

function get(db, workspaceId, sourceId) {
  const row = db
    .prepare('SELECT * FROM migration_sources WHERE id = ? AND workspace_id = ?')
    .get(sourceId, workspaceId);
  if (!row) throw new NotFoundError('That file is not part of this inventory.');
  return hydrate(row);
}

function list(db, workspaceId, { includeExcluded = false } = {}) {
  const clause = includeExcluded ? '' : ' AND excluded = 0';
  return db
    .prepare(`SELECT * FROM migration_sources WHERE workspace_id = ?${clause} ORDER BY created_at, rowid`)
    .all(workspaceId)
    .map(hydrate);
}

function setExcluded(db, ctx, membership, sourceId, excluded) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  get(db, ctx.workspaceId, sourceId);
  db.prepare('UPDATE migration_sources SET excluded = ? WHERE id = ? AND workspace_id = ?')
    .run(excluded ? 1 : 0, sourceId, ctx.workspaceId);
  return get(db, ctx.workspaceId, sourceId);
}

function remove(db, ctx, membership, sourceId) {
  permissions.assertCan(membership, permissions.OPERATE, 'bring data in');
  get(db, ctx.workspaceId, sourceId);
  db.prepare('DELETE FROM migration_sources WHERE id = ? AND workspace_id = ?').run(sourceId, ctx.workspaceId);
  return { deleted: true };
}

module.exports = {
  PURPOSES,
  PURPOSE_LABEL,
  MAX_BYTES,
  inferPurpose,
  inferFreshness,
  profile,
  contentOf,
  hydrate,
  addSource,
  get,
  list,
  setExcluded,
  remove,
};
