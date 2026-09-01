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
    messageKind: row.message_kind || 'purchase_order', connectorId: row.connector_id,
    externalThreadId: row.external_thread_id, approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
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
  const supplier = supplierService.getSupplier(db, workspaceId, order.supplierId);
  const lines = (order.lines || []).map((line) =>
    `- ${line.displayName}: ${line.quantityPurchaseUnits} ${line.purchaseUnit}${line.quantityPurchaseUnits === 1 ? '' : 's'} (${line.quantityUnits} units)` +
      (line.unitCost === null || line.unitCost === undefined ? '' : ` @ ${order.currency} ${Number(line.unitCost).toFixed(2)} each`)
  );
  const subject = `Purchase order ${order.poNumber}`;
  const body = `Hello${supplier.contactName ? ` ${supplier.contactName}` : ''},\n\nPlease find our purchase order ${order.poNumber}:\n${lines.join('\n')}\n\nThank you.`;
  const now = nowIso();
  if (existing) {
    if (existing.status === 'PREPARED') {
      db.prepare(`UPDATE supplier_communications SET recipient = ?, subject = ?, body = ?, connector_id = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`)
        .run(supplier.email || null, subject, body, supplier.watchedConnectorId || null, now, existing.id, workspaceId);
    }
    return get(db, workspaceId, existing.id);
  }
  const id = newId('scom');
  db.prepare(
    `INSERT INTO supplier_communications
       (id, workspace_id, supplier_id, purchase_order_id, channel, recipient, subject, body,
        status, idempotency_key, connector_id, message_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', ?, ?, 'purchase_order', ?, ?)`
  ).run(id, workspaceId, supplier.id, order.id, supplier.email || null,
    subject, body,
    key, supplier.watchedConnectorId || null, now, now);
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

async function sendThroughMailbox(db, workspaceId, id, actorId = null) {
  const message = get(db, workspaceId, id);
  if (!message) throw new Error('Communication not found.');
  if (message.status === 'SENT') return message;
  if (!message.connectorId) throw new Error('Choose the supplier mailbox before sending.');
  const modes = require('../autopilot/modes');
  const state = modes.get(db, workspaceId);
  if (state.paused || state.suspended) throw new Error('Foundry is paused. No supplier communication was sent.');
  const now = nowIso();
  db.prepare(`UPDATE supplier_communications SET status = 'SENDING', transport = ?,
    approved_by_user_id = COALESCE(approved_by_user_id, ?), approved_at = COALESCE(approved_at, ?), updated_at = ?
    WHERE id = ? AND workspace_id = ?`).run(message.connectorId, actorId, actorId ? now : null, now, id, workspaceId);
  try {
    const result = await require('../connections/provider-service').sendMailboxMessage(db, workspaceId, message.connectorId, message);
    const sentAt = nowIso();
    db.prepare(`UPDATE supplier_communications SET status = 'SENT', external_message_id = ?, external_thread_id = ?,
      error_message = NULL, sent_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(result?.externalMessageId || null, result?.externalThreadId || null, sentAt, sentAt, id, workspaceId);
    require('../connections/service').resolveIssues(db, workspaceId, message.connectorId,
      'SUPPLIER_FOLLOW_UP_APPROVAL', id);
    if (message.purchaseOrderId) require('./po-service').recordEvent(db, workspaceId, message.purchaseOrderId,
      'supplier_communication_sent', { communicationId: id, recipient: message.recipient,
        externalMessageId: result?.externalMessageId || null }, actorId);
  } catch (error) {
    db.prepare("UPDATE supplier_communications SET status = 'FAILED', error_message = ?, updated_at = ? WHERE id = ? AND workspace_id = ?")
      .run(String(error.message || error), nowIso(), id, workspaceId);
    throw error;
  }
  return get(db, workspaceId, id);
}

async function dispatchAutomaticForOrder(db, workspaceId, purchaseOrderId) {
  const order = require('./po-service').get(db, workspaceId, purchaseOrderId);
  const supplier = supplierService.getSupplier(db, workspaceId, order.supplierId);
  const state = require('../autopilot/modes').get(db, workspaceId);
  if (!supplier.autoSendEnabled || !supplier.watchedConnectorId || !state.canAutomate) return forOrder(db, workspaceId, purchaseOrderId);
  const amountMinor = Math.round(Number(order.subtotal || 0) * 100);
  const connection = require('../connections/service').get(db, workspaceId, supplier.watchedConnectorId);
  if (!order.hasCosts) {
    require('../connections/service').issue(db, { workspaceId, connectorId: connection.id,
      issueType: 'SUPPLIER_ORDER_PRICE_MISSING', fingerprint: `supplier-price:${purchaseOrderId}`,
      title: `${order.poNumber} needs a price before Foundry can send it automatically`,
      detail: `At least one line for ${supplier.name} has no known unit cost. Nothing was sent.`,
      resolutionHint: 'Review the purchase order and supplier price, then approve the message yourself.' });
    return forOrder(db, workspaceId, purchaseOrderId);
  }
  if (supplier.minimumOrderAmount !== null && Number(order.subtotal) < Number(supplier.minimumOrderAmount)) {
    require('../connections/service').issue(db, { workspaceId, connectorId: connection.id,
      issueType: 'SUPPLIER_MINIMUM_NOT_MET', fingerprint: `supplier-minimum:${purchaseOrderId}`,
      title: `${order.poNumber} is below ${supplier.name}'s minimum order`,
      detail: `${supplier.currency} ${order.subtotal.toFixed(2)} is below the saved minimum of ${supplier.currency} ${Number(supplier.minimumOrderAmount).toFixed(2)}. Nothing was sent.`,
      resolutionHint: 'Add needed products, confirm an exception with the supplier, or send the reviewed order yourself.' });
    return forOrder(db, workspaceId, purchaseOrderId);
  }
  if (supplier.autoSendLimitMinor === null || amountMinor > supplier.autoSendLimitMinor) {
    require('../connections/service').issue(db, { workspaceId, connectorId: connection.id,
      issueType: 'SUPPLIER_SEND_APPROVAL', fingerprint: `supplier-send:${purchaseOrderId}`,
      title: `${order.poNumber} for ${supplier.currency} ${order.subtotal.toFixed(2)} is ready for ${supplier.name}`,
      detail: `The automatic sending limit is ${supplier.currency} ${Number(supplier.autoSendLimit || 0).toFixed(2)}. Nothing was sent.`,
      resolutionHint: 'Open the purchase order, review it, then approve and send.',
      candidates: [{ kind: 'supplier_communication', purchaseOrderId, supplierId: supplier.id }] });
    return forOrder(db, workspaceId, purchaseOrderId);
  }
  for (const message of forOrder(db, workspaceId, purchaseOrderId).filter((row) => ['PREPARED', 'QUEUED', 'FAILED'].includes(row.status))) {
    await sendThroughMailbox(db, workspaceId, message.id, null);
  }
  return forOrder(db, workspaceId, purchaseOrderId);
}

function prepareDueFollowups(db, workspaceId, options = {}) {
  const now = new Date(options.now || Date.now());
  const rows = db.prepare(`SELECT po.id, po.po_number, po.ordered_at, po.expected_date,
      s.id AS supplier_id, s.name AS supplier_name, s.contact_name, s.email, s.follow_up_days,
      s.watched_connector_id, s.auto_send_enabled
    FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id
    WHERE po.workspace_id = ? AND po.status IN ('ORDERED','PARTIALLY_RECEIVED')
      AND s.prepare_communications = 1`).all(workspaceId);
  const prepared = [];
  for (const row of rows) {
    const latestEvidence = db.prepare(`SELECT MAX(processed_at) AS at FROM supplier_documents
      WHERE workspace_id = ? AND purchase_order_id = ?`).get(workspaceId, row.id).at;
    const latestFollowUp = db.prepare(`SELECT MAX(created_at) AS at FROM supplier_communications
      WHERE workspace_id = ? AND purchase_order_id = ? AND message_kind IN ('confirmation_follow_up','late_delivery_follow_up')`)
      .get(workspaceId, row.id).at;
    const baseline = [latestEvidence, latestFollowUp, row.ordered_at].filter(Boolean)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    if (!baseline) continue;
    const due = new Date(Date.parse(baseline) + Number(row.follow_up_days || 2) * 86400000);
    const lateDelivery = row.expected_date && row.expected_date < now.toISOString().slice(0, 10);
    if (!lateDelivery && due > now) continue;
    const period = now.toISOString().slice(0, 10);
    const kind = lateDelivery ? 'late_delivery_follow_up' : 'confirmation_follow_up';
    const key = `purchase-order:${row.id}:${kind}:${period}`;
    const existing = db.prepare('SELECT * FROM supplier_communications WHERE workspace_id = ? AND idempotency_key = ?')
      .get(workspaceId, key);
    if (existing) continue;
    const id = newId('scom'); const at = now.toISOString();
    const reason = lateDelivery ? `the delivery expected ${row.expected_date}` : 'confirmation of the order';
    db.prepare(`INSERT INTO supplier_communications
      (id, workspace_id, supplier_id, purchase_order_id, channel, recipient, subject, body, status,
       connector_id, message_kind, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, row.supplier_id, row.id, row.email,
        `Following up on ${row.po_number}`,
        `Hello${row.contact_name ? ` ${row.contact_name}` : ''},\n\nWe're following up on ${reason} for ${row.po_number}. Please let us know the current status and expected date.\n\nThank you.`,
        row.watched_connector_id, kind, key, at, at);
    require('./po-service').recordEvent(db, workspaceId, row.id, 'supplier_follow_up_prepared',
      { communicationId: id, reason: kind }, null);
    if (!row.auto_send_enabled && row.watched_connector_id) {
      require('../connections/service').issue(db, {
        workspaceId, connectorId: row.watched_connector_id,
        issueType: 'SUPPLIER_FOLLOW_UP_APPROVAL', fingerprint: `supplier-follow-up:${id}`,
        title: `${row.po_number} follow-up is ready for ${row.supplier_name}`,
        detail: lateDelivery
          ? `${row.po_number} was expected ${row.expected_date}. Foundry prepared a concise status request but has no authority to send it.`
          : `${row.po_number} has not been confirmed. Foundry prepared a concise status request but has no authority to send it.`,
        resolutionHint: `Open ${row.po_number}, review the prepared message, then approve and send it.`,
        candidates: [{ kind: 'supplier_communication', communicationId: id, purchaseOrderId: row.id }],
      });
    }
    prepared.push(get(db, workspaceId, id));
  }
  return prepared;
}

module.exports = { hydrate, get, forOrder, prepareForOrder, queueForOrder, registerTransport, send,
  sendThroughMailbox, dispatchAutomaticForOrder, prepareDueFollowups, _transports: transports };
