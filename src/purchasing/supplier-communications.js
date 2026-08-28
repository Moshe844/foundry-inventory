'use strict';

/** A pluggable supplier-communication outbox. No adapter means no send. */
const { newId, nowIso } = require('../lib/util');
const supplierService = require('./supplier-service');

const transports = new Map();
const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, supplierId: row.supplier_id,
    purchaseOrderId: row.purchase_order_id, channel: row.channel, recipient: row.recipient,
    subject: row.subject, body: row.body, status: row.status, transport: row.transport,
    externalMessageId: row.external_message_id, idempotencyKey: row.idempotency_key,
    errorMessage: row.error_message, createdAt: row.created_at, queuedAt: row.queued_at,
    sentAt: row.sent_at, updatedAt: row.updated_at,
  };
}

function get(db, workspaceId, id) {
  return hydrate(db.prepare('SELECT * FROM supplier_communications WHERE id = ? AND workspace_id = ?').get(id, workspaceId));
}

function forOrder(db, workspaceId, purchaseOrderId) {
  return db.prepare('SELECT * FROM supplier_communications WHERE workspace_id = ? AND purchase_order_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(workspaceId, purchaseOrderId).map(hydrate);
}

function prepareForOrder(db, workspaceId, order) {
  const key = `purchase-order:${order.id}:initial`;
  const existing = db.prepare('SELECT * FROM supplier_communications WHERE workspace_id = ? AND idempotency_key = ?').get(workspaceId, key);
  if (existing) return hydrate(existing);
  const supplier = supplierService.getSupplier(db, workspaceId, order.supplierId);
  const lines = (order.lines || []).map((line) =>
    `- ${line.displayName}: ${line.quantityPurchaseUnits} ${line.purchaseUnit}${line.quantityPurchaseUnits === 1 ? '' : 's'} (${line.quantityUnits} units)`
  );
  const now = nowIso();
  const id = newId('scom');
  db.prepare(
    `INSERT INTO supplier_communications
       (id, workspace_id, supplier_id, purchase_order_id, channel, recipient, subject, body,
        status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', ?, ?, ?)`
  ).run(id, workspaceId, supplier.id, order.id, supplier.email || null,
    `Purchase order ${order.poNumber}`, `Hello${supplier.contactName ? ` ${supplier.contactName}` : ''},\n\nPlease find our purchase order ${order.poNumber}:\n${lines.join('\n')}\n\nThank you.`,
    key, now, now);
  return get(db, workspaceId, id);
}

function queueForOrder(db, workspaceId, purchaseOrderId) {
  const rows = forOrder(db, workspaceId, purchaseOrderId);
  const now = nowIso();
  for (const row of rows.filter((entry) => entry.status === 'PREPARED')) {
    db.prepare("UPDATE supplier_communications SET status = 'QUEUED', queued_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(now, now, row.id, workspaceId);
  }
  return forOrder(db, workspaceId, purchaseOrderId);
}

function registerTransport(name, transport) {
  if (!name || !transport || typeof transport.send !== 'function') throw new TypeError('A communication transport needs a name and send function.');
  transports.set(String(name), transport);
  return () => transports.delete(String(name));
}

async function send(db, workspaceId, id, transportName) {
  const message = get(db, workspaceId, id);
  if (!message) throw new Error('Communication not found.');
  if (message.status === 'SENT') return message;
  const transport = transports.get(transportName);
  if (!transport) return message; // queued is truthful; absence is not success
  db.prepare("UPDATE supplier_communications SET status = 'SENDING', transport = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
    .run(transportName, nowIso(), id, workspaceId);
  try {
    const result = await transport.send(message);
    const now = nowIso();
    db.prepare("UPDATE supplier_communications SET status = 'SENT', external_message_id = ?, error_message = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(result?.externalMessageId || null, now, now, id, workspaceId);
  } catch (error) {
    db.prepare("UPDATE supplier_communications SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(String(error.message || error), nowIso(), id, workspaceId);
  }
  return get(db, workspaceId, id);
}

module.exports = { hydrate, get, forOrder, prepareForOrder, queueForOrder, registerTransport, send, _transports: transports };
