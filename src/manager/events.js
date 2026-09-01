'use strict';

/**
 * Durable domain events for continuous management.
 *
 * The ledger/PO/policy row is the business truth. This queue is only the
 * durable promise to reconsider what that committed truth affects. Publishing
 * the same source event twice returns the original row; processing it twice
 * returns the original result.
 */

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { newId, nowIso } = require('../lib/util');

const STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  FAILED: 'FAILED',
});

const TYPES = Object.freeze({
  INVENTORY_ISSUED: 'inventory.issued',
  INVENTORY_RECEIVED: 'inventory.received',
  INVENTORY_TRANSFERRED: 'inventory.transferred',
  INVENTORY_CORRECTED: 'inventory.corrected',
  COUNT_REPORTED: 'count.reported',
  COUNT_CONFIRMED: 'count.confirmed',
  PURCHASE_ORDER_PLACED: 'purchase_order.placed',
  PURCHASE_ORDER_PARTIALLY_RECEIVED: 'purchase_order.partially_received',
  PURCHASE_ORDER_COMPLETED: 'purchase_order.completed',
  PURCHASE_ORDER_CANCELLED: 'purchase_order.cancelled',
  SALES_ORDER_CONFIRMED: 'sales_order.confirmed',
  SALES_ORDER_CHANGED: 'sales_order.changed',
  SALES_ORDER_PARTIALLY_FULFILLED: 'sales_order.partially_fulfilled',
  SALES_ORDER_FULFILLED: 'sales_order.fulfilled',
  SALES_ORDER_CANCELLED: 'sales_order.cancelled',
  CONNECTOR_SALE_COMPLETED: 'connector.sale.completed',
  CONNECTOR_RETURN_COMPLETED: 'connector.return.completed',
  SUPPLIER_UPDATED: 'supplier.updated',
  REORDER_POLICY_UPDATED: 'reorder_policy.updated',
  AUTHORITY_UPDATED: 'authority.updated',
  FOUNDRY_RESUMED: 'foundry.resumed',
  IMPORT_COMPLETED: 'inventory.import_completed',
  TIME_REEVALUATION_DUE: 'time.reevaluation_due',
});

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.event_type,
    payload: json(row.payload, {}),
    source: row.source,
    sourceRecordType: row.source_record_type,
    sourceRecordId: row.source_record_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    result: json(row.result, {}),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    processedAt: row.processed_at,
  };
}

function stableKey(type, payload = {}, options = {}) {
  if (options.idempotencyKey) return String(options.idempotencyKey);
  if (options.sourceRecordType && options.sourceRecordId) {
    return `${type}:${options.sourceRecordType}:${options.sourceRecordId}`;
  }
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify(payload || {})).digest('hex').slice(0, 24);
  return `${type}:${digest}`;
}

function publish(db, workspaceId, type, payload = {}, options = {}) {
  const key = stableKey(type, payload, options);
  const existing = db.prepare(
    'SELECT * FROM domain_events WHERE workspace_id = ? AND idempotency_key = ?'
  ).get(workspaceId, key);
  if (existing) return { event: hydrate(existing), created: false };

  const id = newId('evt');
  db.prepare(
    `INSERT INTO domain_events
       (id, workspace_id, event_type, payload, source, source_record_type,
        source_record_id, idempotency_key, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`
  ).run(
    id, workspaceId, type, JSON.stringify(payload || {}), options.source || 'foundry',
    options.sourceRecordType || null, options.sourceRecordId || null, key, nowIso()
  );
  return { event: get(db, workspaceId, id), created: true };
}

function get(db, workspaceId, eventId) {
  return hydrate(db.prepare(
    'SELECT * FROM domain_events WHERE id = ? AND workspace_id = ?'
  ).get(eventId, workspaceId));
}

function claim(db, eventId) {
  return inTransaction(db, () => {
    const row = db.prepare('SELECT * FROM domain_events WHERE id = ?').get(eventId);
    if (!row || row.status === STATUS.PROCESSED) return row ? hydrate(row) : null;
    if (row.status === STATUS.PROCESSING) return null;
    db.prepare(
      `UPDATE domain_events SET status = 'PROCESSING', attempts = attempts + 1,
       started_at = ?, error_message = NULL WHERE id = ? AND status IN ('PENDING','FAILED')`
    ).run(nowIso(), eventId);
    return hydrate(db.prepare('SELECT * FROM domain_events WHERE id = ?').get(eventId));
  });
}

function claimNext(db, workspaceId = null) {
  const row = workspaceId
    ? db.prepare("SELECT id FROM domain_events WHERE workspace_id = ? AND status = 'PENDING' ORDER BY created_at, rowid LIMIT 1").get(workspaceId)
    : db.prepare("SELECT id FROM domain_events WHERE status = 'PENDING' ORDER BY created_at, rowid LIMIT 1").get();
  return row ? claim(db, row.id) : null;
}

function finish(db, eventId, result = {}, error = null) {
  db.prepare(
    `UPDATE domain_events SET status = ?, result = ?, error_message = ?, processed_at = ? WHERE id = ?`
  ).run(
    error ? STATUS.FAILED : STATUS.PROCESSED,
    JSON.stringify(result || {}), error ? String(error.message || error) : null, nowIso(), eventId
  );
}

function recover(db) {
  return db.prepare(
    "UPDATE domain_events SET status = 'PENDING', started_at = NULL WHERE status = 'PROCESSING'"
  ).run().changes;
}

function list(db, workspaceId, { limit = 100, status = null } = {}) {
  const statuses = status ? (Array.isArray(status) ? status : [status]) : null;
  const where = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.prepare(
    `SELECT * FROM domain_events WHERE workspace_id = ?${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).all(workspaceId, ...(statuses || []), limit).map(hydrate);
}

module.exports = { STATUS, TYPES, hydrate, stableKey, publish, get, claim, claimNext, finish, recover, list };
