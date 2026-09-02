'use strict';

/*
 * Telling the customer their order shipped.
 *
 * Foundry already knew everything this message says — what was in the box,
 * which carrier took it, the tracking number and the link that resolves it —
 * and told nobody. The person actually waiting for the parcel was the one
 * party the system could not reach.
 *
 * Two rules shape the whole file.
 *
 * The body is built from records, never from a model. A shipping notice is
 * read by somebody who is owed goods: an invented tracking number or a
 * cheerfully guessed delivery date is worse than no notice at all. So every
 * line here is a field read out, and a field Foundry does not have simply
 * produces no line rather than a hedge.
 *
 * Preparing is not sending. The default is that Foundry writes the message
 * and the owner presses send, exactly as supplier communication works. A
 * workspace can say "send these for me", and that is a setting somebody chose
 * rather than a default they inherited.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const carriers = require('./carriers');

const DEFAULT_POLICY = {
  shippingNotice: 'prepare',
  connectorId: null,
  businessName: null,
  replyTo: null,
  signature: null,
};

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    customerId: row.customer_id,
    salesOrderId: row.sales_order_id,
    shipmentId: row.shipment_id,
    channel: row.channel,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    transport: row.transport,
    externalMessageId: row.external_message_id,
    externalThreadId: row.external_thread_id,
    messageKind: row.message_kind,
    connectorId: row.connector_id,
    approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at,
    idempotencyKey: row.idempotency_key,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    queuedAt: row.queued_at,
    sentAt: row.sent_at,
    updatedAt: row.updated_at,
  };
}

function policy(db, workspaceId) {
  const row = db.prepare('SELECT * FROM customer_communication_policy WHERE workspace_id = ?').get(workspaceId);
  if (!row) return { ...DEFAULT_POLICY };
  return {
    shippingNotice: row.shipping_notice,
    connectorId: row.connector_id,
    businessName: row.business_name,
    replyTo: row.reply_to,
    signature: row.signature,
  };
}

function setPolicy(db, ctx, input = {}) {
  const mode = trimOrNull(input.shippingNotice) || 'prepare';
  if (!['off', 'prepare', 'send'].includes(mode)) {
    throw new ValidationError('Choose whether Foundry writes shipping notices, sends them, or leaves them alone.');
  }
  const connectorId = trimOrNull(input.connectorId);
  if (mode === 'send' && !connectorId) {
    throw new ValidationError('Choose which mailbox these are sent from before asking Foundry to send them for you.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO customer_communication_policy
      (workspace_id, shipping_notice, connector_id, business_name, reply_to, signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id) DO UPDATE SET
      shipping_notice = excluded.shipping_notice, connector_id = excluded.connector_id,
      business_name = excluded.business_name, reply_to = excluded.reply_to,
      signature = excluded.signature, updated_at = excluded.updated_at`)
    .run(ctx.workspaceId, mode, connectorId, trimOrNull(input.businessName),
      trimOrNull(input.replyTo), trimOrNull(input.signature), now, now);
  return policy(db, ctx.workspaceId);
}

function get(db, workspaceId, id) {
  return hydrate(db.prepare('SELECT * FROM customer_communications WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId));
}

function forShipment(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT * FROM customer_communications
    WHERE workspace_id = ? AND shipment_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId, shipmentId).map(hydrate);
}

function forOrder(db, workspaceId, orderId) {
  return db.prepare(`SELECT * FROM customer_communications
    WHERE workspace_id = ? AND sales_order_id = ? ORDER BY created_at DESC, rowid DESC`)
    .all(workspaceId, orderId).map(hydrate);
}

/**
 * Everything Foundry has written to customers and not yet sent.
 */
function waiting(db, workspaceId) {
  return db.prepare(`SELECT cc.*, c.name AS customer_name, so.order_number, sh.shipment_number
    FROM customer_communications cc
    LEFT JOIN customers c ON c.id = cc.customer_id
    LEFT JOIN sales_orders so ON so.id = cc.sales_order_id
    LEFT JOIN sales_shipments sh ON sh.id = cc.shipment_id
    WHERE cc.workspace_id = ? AND cc.status IN ('PREPARED','QUEUED','FAILED')
    ORDER BY cc.created_at, cc.rowid`).all(workspaceId)
    .map((row) => ({ ...hydrate(row), customerName: row.customer_name,
      orderNumber: row.order_number, shipmentNumber: row.shipment_number }));
}

const LINE = (label, value) => (value ? `${label}: ${value}` : null);

/**
 * The words, built entirely from fields.
 *
 * Every paragraph below is a record read out. A field Foundry does not hold
 * produces no line at all — there is no sentence here that survives its own
 * data being missing, because that is exactly how a system ends up promising
 * a delivery date nobody committed to.
 */
function composeShippingNotice(db, workspaceId, shipmentId) {
  const shipment = db.prepare(`SELECT sh.*, so.order_number, so.id AS order_id, c.id AS customer_id,
      c.name AS customer_name, c.email AS customer_email
    FROM sales_shipments sh
    JOIN sales_orders so ON so.id = sh.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE sh.id = ? AND sh.workspace_id = ?`).get(shipmentId, workspaceId);
  if (!shipment) throw new NotFoundError('That shipment is not in this inventory.');

  const lines = db.prepare(`SELECT ssl.quantity, i.name AS item_name, i.unit_label,
      s.code AS sku_code, s.variant_label
    FROM sales_shipment_lines ssl
    JOIN skus s ON s.id = ssl.sku_id
    JOIN items i ON i.id = s.item_id
    WHERE ssl.shipment_id = ? AND ssl.workspace_id = ?
    ORDER BY i.name, s.variant_label`).all(shipmentId, workspaceId);

  const settings = policy(db, workspaceId);
  const businessName = settings.businessName
    || (db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId) || {}).name
    || null;

  const carrierName = carriers.displayName(shipment.carrier);
  const trackingUrl = shipment.tracking_url
    || carriers.trackingUrlFor(shipment.carrier, shipment.tracking_number);

  /*
   * What is still owed on this order after this box.
   *
   * A customer who ordered eighteen and receives twelve will count them. Being
   * told the remaining six are still coming is the difference between a
   * shipping notice and a complaint.
   */
  const totals = db.prepare(`SELECT COALESCE(SUM(quantity_ordered), 0) AS ordered,
      COALESCE(SUM(quantity_fulfilled), 0) AS fulfilled
    FROM sales_order_lines WHERE sales_order_id = ? AND workspace_id = ?`)
    .get(shipment.order_id, workspaceId);
  const outstanding = Number(totals.ordered) - Number(totals.fulfilled);

  const body = [
    `Hello${shipment.customer_name ? ` ${shipment.customer_name}` : ''},`,
    '',
    `Your order ${shipment.order_number} is on its way.`,
    '',
    'In this shipment:',
    ...lines.map((line) => {
      const name = line.variant_label ? `${line.item_name} / ${line.variant_label}` : line.item_name;
      return `- ${name}${line.sku_code ? ` (${line.sku_code})` : ''}: ${line.quantity}`;
    }),
    '',
    ...[
      LINE('Carrier', carrierName ? [carrierName, trimOrNull(shipment.service)].filter(Boolean).join(' ') : null),
      LINE('Tracking number', shipment.tracking_number),
      trackingUrl ? `Track it here: ${trackingUrl}` : null,
      LINE('Expected delivery', shipment.expected_delivery_date),
      shipment.package_count && Number(shipment.package_count) > 1
        ? `This order is travelling in ${shipment.package_count} packages.` : null,
    ].filter(Boolean),
    outstanding > 0
      ? ['', `${outstanding} ${outstanding === 1 ? 'item' : 'items'} on this order have not shipped yet. We will let you know when they do.`].join('\n')
      : null,
    '',
    'Thank you.',
    settings.signature || businessName,
  ].filter((part) => part !== null && part !== undefined).join('\n');

  return {
    shipment,
    customerId: shipment.customer_id,
    recipient: trimOrNull(shipment.customer_email),
    subject: `Your order ${shipment.order_number} has shipped`,
    body,
  };
}

/**
 * Write the notice down. Idempotent per shipment: one box, one notice.
 */
function prepareShippingNotice(db, ctx, shipmentId) {
  const workspaceId = ctx.workspaceId;
  const key = `shipment:${shipmentId}:shipped`;
  const existing = db.prepare('SELECT * FROM customer_communications WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  const draft = composeShippingNotice(db, workspaceId, shipmentId);
  const settings = policy(db, workspaceId);
  const now = nowIso();

  if (existing) {
    // Only a message still waiting is rewritten. What has gone is what went.
    if (existing.status === 'PREPARED') {
      db.prepare(`UPDATE customer_communications SET recipient = ?, subject = ?, body = ?,
        connector_id = ?, updated_at = ? WHERE id = ?`)
        .run(draft.recipient, draft.subject, draft.body, settings.connectorId, now, existing.id);
    }
    return get(db, workspaceId, existing.id);
  }

  const id = newId('ccom');
  db.prepare(`INSERT INTO customer_communications
      (id, workspace_id, customer_id, sales_order_id, shipment_id, channel, recipient, subject, body,
       status, message_kind, connector_id, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', 'shipping_notice', ?, ?, ?, ?)`)
    .run(id, workspaceId, draft.customerId, draft.shipment.order_id, shipmentId,
      draft.recipient, draft.subject, draft.body, settings.connectorId, key, now, now);
  return get(db, workspaceId, id);
}

function updateDraft(db, workspaceId, id, input = {}) {
  const message = get(db, workspaceId, id);
  if (!message) throw new NotFoundError('That message is not in this inventory.');
  if (message.status !== 'PREPARED') {
    throw new ValidationError('This message has already been sent. Write a new one instead of changing it.');
  }
  const subject = trimOrNull(input.subject) || message.subject;
  const body = input.body === undefined ? message.body : String(input.body);
  if (!body.trim()) throw new ValidationError('A message needs something in it.');
  db.prepare(`UPDATE customer_communications SET subject = ?, body = ?, recipient = ?,
    connector_id = COALESCE(?, connector_id), updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(subject, body, trimOrNull(input.recipient) || message.recipient,
      trimOrNull(input.connectorId), nowIso(), id, workspaceId);
  return get(db, workspaceId, id);
}

function cancel(db, workspaceId, id, reason = null) {
  const message = get(db, workspaceId, id);
  if (!message) throw new NotFoundError('That message is not in this inventory.');
  if (message.status === 'SENT') {
    throw new ValidationError('This message has already gone. It cannot be unsent.');
  }
  db.prepare(`UPDATE customer_communications SET status = 'CANCELLED', error_message = COALESCE(?, error_message),
    updated_at = ? WHERE id = ? AND workspace_id = ?`).run(trimOrNull(reason), nowIso(), id, workspaceId);
  return get(db, workspaceId, id);
}

/**
 * Send it, through the workspace's own mailbox.
 *
 * Every reason this can refuse is stated rather than swallowed, because a
 * customer who was never told is indistinguishable from a customer who was,
 * unless the system says which.
 */
async function sendThroughMailbox(db, workspaceId, id, actorId = null) {
  const message = get(db, workspaceId, id);
  if (!message) throw new NotFoundError('That message is not in this inventory.');
  if (message.status === 'SENT') return message;
  if (message.status === 'CANCELLED') {
    throw new ValidationError('This message was cancelled. Prepare a new one to tell the customer.');
  }
  if (!message.recipient) {
    throw new ValidationError('There is no email address for this customer. Add one, or tell them yourself.');
  }
  const connectorId = message.connectorId || policy(db, workspaceId).connectorId;
  if (!connectorId) {
    throw new ValidationError('Choose which mailbox this is sent from before sending it.');
  }
  const state = require('../autopilot/modes').get(db, workspaceId);
  if (state.paused || state.suspended) {
    throw new ValidationError('Foundry is paused. Nothing was sent to the customer.');
  }

  const now = nowIso();
  db.prepare(`UPDATE customer_communications SET status = 'SENDING', transport = ?, connector_id = ?,
    approved_by_user_id = COALESCE(approved_by_user_id, ?), approved_at = COALESCE(approved_at, ?),
    updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(connectorId, connectorId, actorId, actorId ? now : null, now, id, workspaceId);
  try {
    const result = await require('../connections/provider-service')
      .sendMailboxMessage(db, workspaceId, connectorId, { ...message, connectorId });
    const sentAt = nowIso();
    db.prepare(`UPDATE customer_communications SET status = 'SENT', external_message_id = ?,
      external_thread_id = ?, error_message = NULL, sent_at = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(result?.externalMessageId || null, result?.externalThreadId || null, sentAt, sentAt, id, workspaceId);
  } catch (error) {
    db.prepare(`UPDATE customer_communications SET status = 'FAILED', error_message = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ?`)
      .run(String(error.message || error), nowIso(), id, workspaceId);
    throw error;
  }
  return get(db, workspaceId, id);
}

/**
 * What happens the moment a box ships.
 *
 * This is called from `ship`, and it must never be able to undo it. A parcel
 * that has physically left is a fact; an email problem is not a reason to
 * pretend otherwise. So this only ever *writes* the notice - synchronously,
 * inside the same flow, so the shipment and the message it explains are
 * created together - and every failure is swallowed.
 *
 * Sending is deliberately somebody else's job. It is slow, it can fail
 * halfway, and its outcome is something a person needs told in words, so it
 * belongs to the request that can wait for it and report back.
 */
function onShipped(db, ctx, shipmentId) {
  try {
    if (policy(db, ctx.workspaceId).shippingNotice === 'off') return null;
    return prepareShippingNotice(db, ctx, shipmentId);
  } catch {
    return null; // the shipment stands either way
  }
}

/**
 * Send it now if the workspace has said Foundry may. Returns what happened in
 * words, because "we told them" and "we could not" must not look alike.
 */
async function autoSend(db, ctx, message) {
  if (!message || message.status !== 'PREPARED') return { sent: false, reason: null };
  if (policy(db, ctx.workspaceId).shippingNotice !== 'send') return { sent: false, reason: null };
  try {
    const sent = await sendThroughMailbox(db, ctx.workspaceId, message.id, ctx.actorId || null);
    return { sent: sent.status === 'SENT', reason: null, message: sent };
  } catch (error) {
    return { sent: false, reason: String(error.message || error), message: get(db, ctx.workspaceId, message.id) };
  }
}

module.exports = {
  DEFAULT_POLICY, policy, setPolicy,
  get, forShipment, forOrder, waiting,
  composeShippingNotice, prepareShippingNotice, updateDraft, cancel,
  sendThroughMailbox, onShipped, autoSend,
};
