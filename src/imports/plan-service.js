'use strict';

/**
 * The import plan: what Foundry proposes to create, before it creates any of it.
 *
 * An import is the largest thing Foundry can be asked to do — a file can carry
 * a whole business's catalogue — so it follows exactly the same shape as a
 * single action in Mission 4: interpret, resolve deterministically, write down
 * what will happen, show it, and only then execute against a person's approval.
 *
 * The plan is stored row by row. That is what makes "17 rows skipped" a
 * statement someone can check rather than a number to take on trust, and what
 * lets an interrupted import resume from what actually happened.
 */

const crypto = require('crypto');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const parser = require('./parser');
const mappingService = require('./mapping-service');
const repo = require('../domain/repository');
const rowValidator = require('./row-validator');
const fields = require('./fields');

/** A plan a person walked away from should not be executable a week later. */
const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** A hash over what will actually be created, and nothing presentational. */
function computeIntegrityHash(plan) {
  return crypto
    .createHash('sha256')
    .update(
      stableStringify({
        sourceHash: plan.sourceHash,
        detectedType: plan.detectedType,
        sheetIndex: plan.sheetIndex,
        mappings: plan.fieldMappings,
        axisNames: (plan.transformations || {}).axisNames || {},
        defaultLocationId: plan.defaultLocationId || null,
        locationMappings: plan.locationMappings || {},
        recordsValid: plan.recordsValid,
        recordsInvalid: plan.recordsInvalid,
      })
    )
    .digest('hex');
}

/** The first sentence, so a screen shows a note rather than an essay. */
function firstSentence(text, limit) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const stop = clean.search(/[.!?](\s|$)/);
  const sentence = stop === -1 ? clean : clean.slice(0, stop + 1);
  if (sentence.length <= limit) return sentence;
  // Cut at a word, not mid-word: a note ending "Foundry's readin…" looks broken
  // rather than shortened.
  const cut = sentence.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:]$/, '')}…`;
}

const json = (value, fallback) => {
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
};

/** The stored row shape, in the vocabulary the rest of the code uses. */
function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdByUserId: row.created_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    scopeConfirmedAt: row.scope_confirmed_at,
    sourceName: row.source_name,
    sourceKind: row.source_kind,
    sourceHash: row.source_hash,
    sourceBytes: row.source_bytes,
    detectedType: row.detected_type,
    sheetName: row.sheet_name,
    sheetIndex: row.sheet_index,
    sourceColumns: json(row.source_columns, []),
    fieldMappings: json(row.field_mappings, {}),
    transformations: json(row.transformations, {}),
    trackingModel: json(row.tracking_model, {}),
    locationMappings: json(row.location_mappings, {}),
    defaultLocationId: row.default_location_id,
    recordsDetected: row.records_detected,
    recordsValid: row.records_valid,
    recordsInvalid: row.records_invalid,
    warnings: json(row.warnings, []),
    conflicts: json(row.conflicts, []),
    assumptions: json(row.assumptions, []),
    approvalStatus: row.approval_status,
    status: row.status,
    planVersion: row.plan_version,
    integrityHash: row.integrity_hash,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    isExpired: Date.parse(row.created_at) + PLAN_TTL_MS < Date.now(),
  };
}

function hydrateRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    importId: row.import_id,
    rowNumber: row.row_number,
    raw: json(row.raw, []),
    parsed: json(row.parsed, {}),
    status: row.status,
    problems: json(row.problems, []),
    resolution: row.resolution,
    itemId: row.item_id,
    skuId: row.sku_id,
    lotId: row.lot_id,
    locationId: row.location_id,
    movementIds: json(row.movement_ids, []),
    quantity: row.quantity,
    importedAt: row.imported_at,
  };
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Reads a file into a stored, previewable plan.
 *
 * Nothing here writes inventory. Every product, quantity and location in the
 * result is a proposal, and the rows are persisted so the preview shows the
 * real thing rather than a sample recomputed on each page load.
 */
async function analyse(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');

  const operationScope = input.operationScope || null;

  const buffer = input.buffer || null;
  const text = input.text !== undefined ? input.text : null;
  if (!buffer && !String(text || '').trim()) {
    throw new ValidationError('There was nothing to import.');
  }

  const bytes = buffer || Buffer.from(String(text), 'utf8');
  const sourceHash = crypto.createHash('sha256').update(bytes).digest('hex');

  // A file is read from its bytes. Passing the (absent) text alongside it would
  // make the parser choose the empty string over the buffer.
  const parsed = parser.parse(
    buffer ? { buffer, filename: input.filename } : { text, filename: input.filename }
  );
  const sheetIndex = Number.isInteger(input.sheetIndex) ? input.sheetIndex : parsed.primarySheet;
  const sheet = parsed.sheets[sheetIndex];
  if (!sheet) throw new ValidationError('That sheet is not in the file.');
  if (!sheet.rows.length) {
    throw new ValidationError(
      parsed.sheets.length > 1
        ? `“${sheet.name}” has no rows under its header. Try another sheet.`
        : 'That file has a header but no rows under it.'
    );
  }

  const sourceName = input.filename || (buffer ? 'uploaded file' : 'pasted data');
  const proposal = await mappingService.proposeMappings(
    { ...sheet, sourceName },
    { provider: input.provider, mappings: input.mappings, detectedType: input.detectedType }
  );

  if (operationScope === 'selling_price_update' && proposal.mappings.sellingPrice === undefined) {
    throw new ValidationError(
      'Foundry could not find a selling-price column in that file. Nothing was imported.'
    );
  }

  const model = require('./catalog-service').workspaceDefaults(db, ctx.workspaceId);

  // Where the stock goes when the file does not say. An inventory with exactly
  // one location has already answered this — asking anyway, and defaulting to
  // "nowhere", turns a perfectly good spreadsheet into a preview where every
  // row is rejected for having no location, in a business with only one.
  // Named locations in the file still win; this only fills the silence.
  const onlyPlace = repo.listLocations(db, ctx.workspaceId);
  const defaultLocationId =
    input.defaultLocationId || (onlyPlace.length === 1 ? onlyPlace[0].id : null);

  const validated = rowValidator.validateRows(db, ctx.workspaceId, sheet, {
    mappings: proposal.mappings,
    axisNames: proposal.axisNames,
    detectedType: proposal.detectedType,
    defaultLocationId,
    locationMappings: {},
    operationScope,
  });

  const now = nowIso();
  const id = newId('imp');
  const assumptions = [...proposal.assumptions];
  // The model is asked for one line and sometimes writes a paragraph. The
  // first sentence is the part that says something; the rest is reasoning.
  if (proposal.aiNote) assumptions.push(firstSentence(proposal.aiNote, 160));
  if (sheet.headerless) assumptions.push('That data had no header row, so the columns were read by their contents.');
  if (sheet.repeatedHeaderRows) {
    assumptions.push(`${sheet.repeatedHeaderRows} repeated header row(s) part-way down were skipped.`);
  }
  // Say so when the file, rather than the workspace's configuration, decided
  // how these products are counted.
  const fileMode = { lots: 'lot', serials: 'serial' }[proposal.detectedType];
  if (fileMode && fileMode !== model.trackingMode) {
    assumptions.push(
      fileMode === 'lot'
        ? 'These are created as lot-tracked products, because the file carries a lot code on every row.'
        : 'These are created as individually numbered products, because the file carries a serial number on every row.'
    );
  }

  for (const [field, order] of Object.entries(validated.dateOrders)) {
    if (order.certain) {
      assumptions.push(
        `${fields.FIELD_LABEL[field]} dates read as ${order.order === 'dmy' ? 'day/month/year' : 'month/day/year'}.`
      );
    }
  }

  const plan = {
    id,
    workspaceId: ctx.workspaceId,
    createdByUserId: ctx.actorId,
    sourceName,
    sourceKind: buffer ? (parsed.format === 'xlsx' ? 'xlsx' : 'csv') : 'paste',
    sourceHash,
    sourceBytes: bytes.length,
    detectedType: proposal.detectedType,
    sheetName: sheet.name,
    sheetIndex,
    sourceColumns: sheet.columns.map((column) => ({ index: column.index, name: column.name })),
    fieldMappings: proposal.mappings,
    transformations: {
      operationScope,
      axisNames: proposal.axisNames,
      aiApplied: proposal.aiApplied,
      aiRejected: proposal.aiRejected,
      aiUsed: proposal.aiUsed,
      ignoredColumns: proposal.ignoredColumns,
      unnamedColumns: proposal.unnamedColumns,
      dateOrders: validated.dateOrders,
      axes: validated.axes,
      sheetCount: parsed.sheets.length,
      sheetNames: parsed.sheets.map((s) => s.name),
    },
    trackingModel: model,
    locationMappings: {},
    defaultLocationId,
    recordsDetected: validated.summary.total,
    recordsValid: validated.summary.valid + validated.summary.needsReview,
    recordsInvalid: validated.summary.invalid,
    warnings: warningsFor(validated, proposal, operationScope),
    conflicts: validated.locationsNeeded.map((entry) => ({
      kind: 'unknown_location',
      text: entry.text,
      count: entry.count,
    })),
    assumptions,
    approvalStatus: 'AWAITING_APPROVAL',
    status: 'READY',
    planVersion: 1,
    createdAt: now,
  };
  plan.integrityHash = computeIntegrityHash(plan);

  inTransaction(db, () => {
    insertPlan(db, plan);
    insertRows(db, plan, validated.rows, now);
  });

  return { plan: hydrate(read(db, ctx.workspaceId, id)), validated };
}

function warningsFor(validated, proposal, operationScope = null) {
  const warnings = [];
  if (validated.summary.invalid) {
    warnings.push(`${validated.summary.invalid} row(s) cannot be imported as they stand.`);
  }
  if (proposal.detectedType === 'unknown') {
    warnings.push('Foundry could not tell what kind of file this is. Check the columns below.');
  }
  if (operationScope === 'selling_price_update') {
    warnings.push('Only selling prices on exact existing SKU-code matches will change. Products and stock quantities will not change.');
  } else if (proposal.mappings.quantity === undefined) {
    warnings.push('No quantity column, so this creates products without any opening stock.');
  }
  for (const rejected of proposal.aiRejected || []) {
    warnings.push(`“${rejected.column}” was not used as ${fields.FIELD_LABEL[rejected.field]}: ${rejected.because}`);
  }
  return warnings;
}

function insertPlan(db, plan) {
  db.prepare(
    `INSERT INTO import_plans (
       id, workspace_id, created_by_user_id, source_name, source_kind, source_hash, source_bytes,
       detected_type, sheet_name, sheet_index, source_columns, field_mappings, transformations,
       tracking_model, location_mappings, default_location_id,
       records_detected, records_valid, records_invalid, warnings, conflicts, assumptions,
       approval_status, status, plan_version, integrity_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    plan.id,
    plan.workspaceId,
    plan.createdByUserId,
    plan.sourceName,
    plan.sourceKind,
    plan.sourceHash,
    plan.sourceBytes,
    plan.detectedType,
    plan.sheetName,
    plan.sheetIndex,
    JSON.stringify(plan.sourceColumns),
    JSON.stringify(plan.fieldMappings),
    JSON.stringify(plan.transformations),
    JSON.stringify(plan.trackingModel),
    JSON.stringify(plan.locationMappings),
    plan.defaultLocationId,
    plan.recordsDetected,
    plan.recordsValid,
    plan.recordsInvalid,
    JSON.stringify(plan.warnings),
    JSON.stringify(plan.conflicts),
    JSON.stringify(plan.assumptions),
    plan.approvalStatus,
    plan.status,
    plan.planVersion,
    plan.integrityHash,
    plan.createdAt
  );
}

function insertRows(db, plan, rows, now) {
  const insert = db.prepare(
    `INSERT INTO import_rows (
       id, import_id, workspace_id, row_number, raw, parsed, status, problems, location_id, quantity, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      newId('irow'),
      plan.id,
      plan.workspaceId,
      row.rowNumber,
      JSON.stringify(row.raw),
      JSON.stringify(row.parsed),
      row.status,
      JSON.stringify(row.problems),
      row.parsed.locationId || null,
      row.parsed.quantity ?? null,
      now
    );
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function read(db, workspaceId, importId) {
  return db
    .prepare('SELECT * FROM import_plans WHERE id = ? AND workspace_id = ?')
    .get(importId, workspaceId);
}

function get(db, workspaceId, importId) {
  const plan = hydrate(read(db, workspaceId, importId));
  if (!plan) throw new NotFoundError('That import is not in this inventory.');
  return plan;
}

function rowsFor(db, importId, { status = null, limit = 100, offset = 0 } = {}) {
  const clause = status ? 'AND status = ?' : '';
  const params = status ? [importId, status, limit, offset] : [importId, limit, offset];
  return db
    .prepare(`SELECT * FROM import_rows WHERE import_id = ? ${clause} ORDER BY row_number LIMIT ? OFFSET ?`)
    .all(...params)
    .map(hydrateRow);
}

function countsFor(db, importId) {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM import_rows WHERE import_id = ? GROUP BY status')
    .all(importId);
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

function listFor(db, workspaceId, limit = 20) {
  return db
    .prepare('SELECT * FROM import_plans WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(workspaceId, limit)
    .map(hydrate);
}

// ---------------------------------------------------------------------------
// Changing the plan
// ---------------------------------------------------------------------------

/**
 * Re-reads every row against the workspace as it is now.
 *
 * Called when a person corrects a mapping, chooses a location, or simply comes
 * back later: a location may have been created, a product may now exist, and a
 * plan built ten minutes ago must not act on ten-minute-old assumptions.
 */
function revalidate(db, ctx, membership, importId, changes = {}) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const plan = get(db, ctx.workspaceId, importId);
  if (plan.status !== 'READY' && plan.status !== 'PARTIAL') {
    throw new ValidationError('That import can no longer be changed.');
  }

  const stored = db
    .prepare('SELECT * FROM import_rows WHERE import_id = ? ORDER BY row_number')
    .all(importId)
    .map(hydrateRow);

  const mappings = changes.mappings || plan.fieldMappings;
  const locationMappings = changes.locationMappings || plan.locationMappings;
  const defaultLocationId =
    changes.defaultLocationId !== undefined ? changes.defaultLocationId : plan.defaultLocationId;
  const detectedType = changes.detectedType || plan.detectedType;

  // The original cells are on every stored row, so re-reading needs no file.
  const sheet = {
    columns: plan.sourceColumns,
    rows: stored.map((row) => ({ sourceRow: row.rowNumber, cells: row.raw })),
  };
  const validated = rowValidator.validateRows(db, ctx.workspaceId, sheet, {
    mappings,
    axisNames: plan.transformations.axisNames,
    detectedType,
    defaultLocationId,
    locationMappings,
    operationScope: plan.transformations.operationScope || null,
  });

  const now = nowIso();
  const next = {
    ...plan,
    fieldMappings: mappings,
    locationMappings,
    defaultLocationId,
    detectedType,
    recordsValid: validated.summary.valid + validated.summary.needsReview,
    recordsInvalid: validated.summary.invalid,
  };

  inTransaction(db, () => {
    const update = db.prepare(
      'UPDATE import_rows SET parsed = ?, status = ?, problems = ?, location_id = ?, quantity = ? WHERE id = ?'
    );
    stored.forEach((row, index) => {
      const fresh = validated.rows[index];
      if (!fresh) return;
      // A row already imported, or deliberately excluded, keeps its state: a
      // re-check must never quietly queue something that has already run.
      if (['IMPORTED', 'EXCLUDED', 'SKIPPED'].includes(row.status)) return;
      update.run(
        JSON.stringify(fresh.parsed),
        fresh.status,
        JSON.stringify(fresh.problems),
        fresh.parsed.locationId || null,
        fresh.parsed.quantity ?? null,
        row.id
      );
    });

    db.prepare(
      `UPDATE import_plans
          SET field_mappings = ?, location_mappings = ?, default_location_id = ?, detected_type = ?,
              records_valid = ?, records_invalid = ?, conflicts = ?, warnings = ?,
              plan_version = plan_version + 1, integrity_hash = ?, approval_status = ?, approved_at = NULL
        WHERE id = ? AND workspace_id = ?`
    ).run(
      JSON.stringify(mappings),
      JSON.stringify(locationMappings),
      defaultLocationId,
      detectedType,
      next.recordsValid,
      next.recordsInvalid,
      JSON.stringify(
        validated.locationsNeeded.map((entry) => ({
          kind: 'unknown_location',
          text: entry.text,
          count: entry.count,
        }))
      ),
      JSON.stringify(
        warningsFor(validated, {
          detectedType,
          mappings,
          aiRejected: plan.transformations.aiRejected || [],
        }, plan.transformations.operationScope || null)
      ),
      computeIntegrityHash({ ...next, transformations: plan.transformations }),
      // Changing what will be created invalidates any approval of the old plan.
      'AWAITING_APPROVAL',
      importId,
      ctx.workspaceId
    );
  });

  return { plan: get(db, ctx.workspaceId, importId), validated, changedAt: now };
}

/** Takes one row out of the import without changing anything else. */
function excludeRow(db, ctx, membership, importId, rowId, excluded = true) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const plan = get(db, ctx.workspaceId, importId);
  const row = db
    .prepare('SELECT * FROM import_rows WHERE id = ? AND import_id = ? AND workspace_id = ?')
    .get(rowId, importId, ctx.workspaceId);
  if (!row) throw new NotFoundError('That row is not part of this import.');
  if (row.status === 'IMPORTED') throw new ValidationError('That row has already been imported.');

  db.prepare('UPDATE import_rows SET status = ? WHERE id = ?').run(
    excluded ? 'EXCLUDED' : JSON.parse(row.problems || '[]').some((p) => rowValidator.BLOCKING.has(p.code))
      ? 'INVALID'
      : 'VALID',
    rowId
  );
  db.prepare('UPDATE import_plans SET approval_status = ?, approved_at = NULL WHERE id = ?').run(
    'AWAITING_APPROVAL',
    importId
  );
  return get(db, ctx.workspaceId, plan.id);
}

/**
 * Approval. Re-checks the plan against the world before recording it, so an
 * approval is always an approval of something still true.
 */
function approve(db, ctx, membership, importId, { expectedHash = null } = {}) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const before = get(db, ctx.workspaceId, importId);
  if (before.isExpired) {
    throw new ValidationError('That import was prepared too long ago. Upload the file again.');
  }
  if (before.status !== 'READY') throw new ValidationError('That import is not ready to run.');
  if (expectedHash && expectedHash !== before.integrityHash) {
    throw new ValidationError('That import changed since you looked at it. Check it again.');
  }

  const { plan } = revalidate(db, ctx, membership, importId);
  if (expectedHash && plan.integrityHash !== expectedHash) {
    throw new ValidationError('The file no longer matches what you approved. Check it again.');
  }
  if (!plan.recordsValid) {
    throw new ValidationError('There is nothing in that file Foundry can import.');
  }

  db.prepare(
    `UPDATE import_plans SET approval_status = 'APPROVED', approved_by_user_id = ?, approved_at = ?
      WHERE id = ? AND workspace_id = ? AND approval_status = 'AWAITING_APPROVAL'`
  ).run(ctx.actorId, nowIso(), importId, ctx.workspaceId);

  return get(db, ctx.workspaceId, importId);
}

function cancel(db, ctx, membership, importId) {
  permissions.assertCan(membership, permissions.OPERATE, 'import data');
  const plan = get(db, ctx.workspaceId, importId);
  if (plan.status === 'EXECUTING') throw new ValidationError('That import is running.');
  db.prepare(
    `UPDATE import_plans SET approval_status = 'CANCELLED', status = 'CANCELLED' WHERE id = ? AND workspace_id = ?`
  ).run(importId, ctx.workspaceId);
  return get(db, ctx.workspaceId, importId);
}

/**
 * Has this exact file already been imported here?
 *
 * The bytes are hashed and indexed when a plan is created, with a comment
 * saying a re-upload should be recognisable — but nothing ever asked. Uploading
 * the same delivery note twice therefore read as an ordinary import and
 * doubled the stock, silently, which is the single easiest way for a customer
 * to destroy their own numbers.
 *
 * This does not block anything. A supplier really can send the same quantities
 * twice, so the person is told what already happened and decides.
 */
function earlierImportsOfSameFile(db, workspaceId, plan) {
  if (!plan || !plan.sourceHash) return [];
  return db
    .prepare(
      `SELECT id, source_name, status, created_at, approved_at
         FROM import_plans
        WHERE workspace_id = ? AND source_hash = ? AND id != ?
          AND status IN ('SUCCEEDED', 'PARTIAL')
        ORDER BY created_at DESC
        LIMIT 5`
    )
    .all(workspaceId, plan.sourceHash, plan.id || '');
}

module.exports = {
  PLAN_TTL_MS,
  earlierImportsOfSameFile,
  firstSentence,
  stableStringify,
  computeIntegrityHash,
  hydrate,
  hydrateRow,
  analyse,
  get,
  read,
  rowsFor,
  countsFor,
  listFor,
  revalidate,
  excludeRow,
  approve,
  cancel,
};
