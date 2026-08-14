'use strict';

/**
 * Reorder policies: the settings a business can pin down, when it wants to.
 *
 * Every field is optional, and a product with no policy at all is the normal
 * case. That is deliberate — requiring a reorder point on every line before
 * Foundry will help would mean it helps nobody on the first day, which is
 * exactly when a new customer most needs it. Where nothing is set, the
 * replenishment engine derives figures from real usage and labels them as
 * derived; a policy simply replaces a derived number with a decided one.
 *
 * Foundry may propose policies from history. It never writes them by itself:
 * a proposal is shown with the figures it came from, and a person accepts it.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const repo = require('../domain/repository');
const signalEngine = require('../signals/signal-engine');

const FIELDS = [
  'reorderPoint',
  'targetStock',
  'safetyStock',
  'preferredSupplierId',
  'defaultOrderQuantity',
  'leadTimeDays',
];

function emptyPolicy(skuId) {
  return {
    id: null,
    skuId,
    locationId: null,
    reorderPoint: null,
    targetStock: null,
    safetyStock: null,
    preferredSupplierId: null,
    defaultOrderQuantity: null,
    leadTimeDays: null,
    source: null,
    notes: null,
    isSet: false,
  };
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skuId: row.sku_id,
    locationId: row.location_id,
    reorderPoint: row.reorder_point,
    targetStock: row.target_stock,
    safetyStock: row.safety_stock,
    preferredSupplierId: row.preferred_supplier_id,
    defaultOrderQuantity: row.default_order_quantity,
    leadTimeDays: row.lead_time_days,
    source: row.source,
    notes: row.notes,
    isSet: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function optionalInt(value, field, { min = 0, max = 1000000 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a whole number between ${min} and ${max}.`, { field });
  }
  return n;
}

/** The policy that applies to a SKU, or an empty one. */
function effectivePolicy(db, workspaceId, skuId) {
  const row = db
    .prepare(
      'SELECT * FROM reorder_policies WHERE workspace_id = ? AND sku_id = ? AND location_id IS NULL'
    )
    .get(workspaceId, skuId);
  return row ? hydrate(row) : emptyPolicy(skuId);
}

/** Every policy in the workspace, keyed by SKU, so a sweep reads them once. */
function policiesBySku(db, workspaceId) {
  const rows = db
    .prepare('SELECT * FROM reorder_policies WHERE workspace_id = ? AND location_id IS NULL')
    .all(workspaceId);
  return new Map(rows.map((row) => [row.sku_id, hydrate(row)]));
}

function setPolicy(db, ctx, membership, skuId, input) {
  permissions.assertCan(membership, permissions.MANAGE_REPLENISHMENT, 'set reorder policies');
  const sku = repo.requireSku(db, ctx.workspaceId, skuId);
  const now = nowIso();

  const values = {
    reorderPoint: optionalInt(input.reorderPoint, 'Reorder point'),
    targetStock: optionalInt(input.targetStock, 'Target stock'),
    safetyStock: optionalInt(input.safetyStock, 'Safety stock'),
    defaultOrderQuantity: optionalInt(input.defaultOrderQuantity, 'Default order quantity'),
    leadTimeDays: optionalInt(input.leadTimeDays, 'Lead time', { max: 365 }),
    preferredSupplierId: trimOrNull(input.preferredSupplierId),
    notes: trimOrNull(input.notes),
    source: input.source === 'foundry' ? 'foundry' : 'manual',
  };

  if (values.preferredSupplierId) {
    const supplier = db
      .prepare('SELECT id FROM suppliers WHERE id = ? AND workspace_id = ?')
      .get(values.preferredSupplierId, ctx.workspaceId);
    if (!supplier) throw new NotFoundError('That supplier is not in this inventory.');
  }
  if (values.targetStock !== null && values.reorderPoint !== null && values.targetStock < values.reorderPoint) {
    throw new ValidationError(
      'The target stock level has to be at least the reorder point, or every order would arrive already short.',
      { field: 'targetStock' }
    );
  }

  const existing = db
    .prepare('SELECT id FROM reorder_policies WHERE workspace_id = ? AND sku_id = ? AND location_id IS NULL')
    .get(ctx.workspaceId, sku.id);

  if (existing) {
    db.prepare(
      `UPDATE reorder_policies
          SET reorder_point = ?, target_stock = ?, safety_stock = ?, preferred_supplier_id = ?,
              default_order_quantity = ?, lead_time_days = ?, source = ?, notes = ?, updated_at = ?
        WHERE id = ?`
    ).run(
      values.reorderPoint, values.targetStock, values.safetyStock, values.preferredSupplierId,
      values.defaultOrderQuantity, values.leadTimeDays, values.source, values.notes, now, existing.id
    );
  } else {
    db.prepare(
      `INSERT INTO reorder_policies (
         id, workspace_id, sku_id, location_id, reorder_point, target_stock, safety_stock,
         preferred_supplier_id, default_order_quantity, lead_time_days, source, notes, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      newId('rpol'), ctx.workspaceId, sku.id, values.reorderPoint, values.targetStock, values.safetyStock,
      values.preferredSupplierId, values.defaultOrderQuantity, values.leadTimeDays,
      values.source, values.notes, now, now
    );
  }
  return effectivePolicy(db, ctx.workspaceId, sku.id);
}

function clearPolicy(db, ctx, membership, skuId) {
  permissions.assertCan(membership, permissions.MANAGE_REPLENISHMENT, 'set reorder policies');
  db.prepare('DELETE FROM reorder_policies WHERE workspace_id = ? AND sku_id = ? AND location_id IS NULL')
    .run(ctx.workspaceId, skuId);
  return emptyPolicy(skuId);
}

/**
 * A policy Foundry would suggest for a line, from what it has actually seen.
 *
 * Returned as a proposal with the figures it was derived from, never written.
 * A line without enough usage history gets no proposal rather than a made-up
 * one — the honest answer there is that nobody knows yet.
 */
function proposePolicy(db, workspaceId, skuId, options = {}) {
  const replenishment = require('./replenishment');
  const now = options.now || Date.now();
  const [sku] = signalEngine.skuSignals(db, workspaceId, { skuIds: [skuId], now });
  if (!sku) return null;
  if (!sku.estimated.hasUsageEvidence) {
    return {
      skuId,
      displayName: sku.displayName,
      canPropose: false,
      because: `Only ${sku.measured.issuedInWindow} issued in the last ${sku.measured.windowDays} days — not enough to derive a policy from.`,
    };
  }

  const suppliers = require('./supplier-service').suppliersForSku(db, workspaceId, skuId);
  const leadTime =
    (suppliers[0] && suppliers[0].effectiveLeadTimeDays) || replenishment.DEFAULTS.leadTimeDays;
  const usage = sku.estimated.averageDailyUsage;

  const safetyStock = Math.ceil(usage * replenishment.DEFAULTS.safetyDays);
  const reorderPoint = Math.ceil(usage * (leadTime + replenishment.DEFAULTS.reviewPeriodDays)) + safetyStock;
  const targetStock = reorderPoint + Math.ceil(usage * replenishment.DEFAULTS.coverDays);

  return {
    skuId,
    displayName: sku.displayName,
    canPropose: true,
    proposal: {
      reorderPoint,
      targetStock,
      safetyStock,
      leadTimeDays: leadTime,
      preferredSupplierId: suppliers.length ? suppliers[0].supplierId : null,
      source: 'foundry',
    },
    derivedFrom: [
      { label: `Issued in last ${sku.measured.windowDays} days`, value: sku.measured.issuedInWindow },
      { label: 'Average usage', value: `${usage} a day` },
      { label: 'Lead time', value: `${leadTime} days` },
      { label: 'Safety margin', value: `${replenishment.DEFAULTS.safetyDays} days of usage` },
      { label: 'Cover beyond reorder point', value: `${replenishment.DEFAULTS.coverDays} days` },
    ],
  };
}

module.exports = {
  FIELDS,
  emptyPolicy,
  hydrate,
  effectivePolicy,
  policiesBySku,
  setPolicy,
  clearPolicy,
  proposePolicy,
};
