'use strict';

/*
 * Telling the customer their order shipped.
 *
 * StockChief already knew everything this message says — what was in the box,
 * which carrier took it, the tracking number and the link that resolves it —
 * and told nobody. The person actually waiting for the parcel was the one
 * party the system could not reach.
 *
 * Two rules shape the whole file.
 *
 * The body is built from records, never from a model. A shipping notice is
 * read by somebody who is owed goods: an invented tracking number or a
 * cheerfully guessed delivery date is worse than no notice at all. So every
 * line here is a field read out, and a field StockChief does not have simply
 * produces no line rather than a hedge.
 *
 * Preparing is not sending. The default is that StockChief writes the message
 * and the owner presses send, exactly as supplier communication works. A
 * workspace can say "send these for me", and that is a setting somebody chose
 * rather than a default they inherited.
 */

const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const carriers = require('./carriers');

const DEFAULT_POLICY = {
  shippingNotice: 'prepare',
  outForDeliveryNotice: 'prepare',
  deliveredNotice: 'prepare',
  exceptionNotice: 'prepare',
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
    outForDeliveryNotice: row.out_for_delivery_notice || 'prepare',
    deliveredNotice: row.delivered_notice || 'prepare',
    exceptionNotice: row.exception_notice || 'prepare',
    connectorId: row.connector_id,
    businessName: row.business_name,
    replyTo: row.reply_to,
    signature: row.signature,
  };
}

function setPolicy(db, ctx, input = {}) {
  const mode = trimOrNull(input.shippingNotice) || 'prepare';
  if (!['off', 'prepare', 'send'].includes(mode)) {
    throw new ValidationError('Choose whether StockChief writes shipping notices, sends them, or leaves them alone.');
  }
  const connectorId = trimOrNull(input.connectorId);
  const statusMode = (value, fallback, label) => {
    const selected = trimOrNull(value) || fallback;
    if (!['off', 'prepare', 'send'].includes(selected)) {
      throw new ValidationError(`Choose whether StockChief prepares, sends, or turns off ${label}.`);
    }
    return selected;
  };
  const outForDelivery = statusMode(input.outForDeliveryNotice, 'prepare', 'out-for-delivery notices');
  const delivered = statusMode(input.deliveredNotice, 'prepare', 'delivery notices');
  const exception = statusMode(input.exceptionNotice, 'prepare', 'shipping exception notices');
  if ([mode, outForDelivery, delivered, exception].includes('send') && !connectorId) {
    throw new ValidationError('Choose which mailbox these are sent from before asking StockChief to send them for you.');
  }
  const now = nowIso();
  db.prepare(`INSERT INTO customer_communication_policy
      (workspace_id, shipping_notice, out_for_delivery_notice, delivered_notice, exception_notice,
       connector_id, business_name, reply_to, signature, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id) DO UPDATE SET
      shipping_notice = excluded.shipping_notice,
      out_for_delivery_notice = excluded.out_for_delivery_notice,
      delivered_notice = excluded.delivered_notice,
      exception_notice = excluded.exception_notice, connector_id = excluded.connector_id,
      business_name = excluded.business_name, reply_to = excluded.reply_to,
      signature = excluded.signature, updated_at = excluded.updated_at`)
    .run(ctx.workspaceId, mode, outForDelivery, delivered, exception,
      connectorId, trimOrNull(input.businessName), trimOrNull(input.replyTo),
      trimOrNull(input.signature), now, now);
  return policy(db, ctx.workspaceId);
}

/**
 * Which mailbox StockChief sends from.
 *
 * There is a setting for this, and almost nobody sets it — there is no reason
 * to choose between mailboxes when you only have one. Reading the setting
 * alone meant StockChief told an owner "no mailbox is connected for sending"
 * while their Gmail sat on the Connections page marked Connected.
 *
 * So the setting is honoured when it is set, and otherwise the connected
 * mailbox is simply used. A choice is only worth asking for when there is
 * genuinely a choice to make.
 */
function sendingMailbox(db, workspaceId) {
  const chosen = policy(db, workspaceId).connectorId;
  const usable = db.prepare(`SELECT id, provider_type, provider_account_name, display_name
    FROM workspace_connectors
    WHERE workspace_id = ? AND status = 'connected' AND paused_at IS NULL
      AND provider_type IN ('gmail', 'microsoft365')
    ORDER BY created_at`).all(workspaceId);

  if (chosen) {
    const still = usable.find((row) => row.id === chosen);
    if (still) return { connectorId: still.id, mailbox: still, chosen: true, options: usable };
  }
  if (usable.length === 1) {
    return { connectorId: usable[0].id, mailbox: usable[0], chosen: false, options: usable };
  }
  return { connectorId: null, mailbox: null, chosen: false, options: usable };
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
 * Everything StockChief has written to customers and not yet sent.
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
 * Every paragraph below is a record read out. A field StockChief does not hold
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
  const collected = shipment.handover === 'COLLECTED';

  const body = [
    `Hello${shipment.customer_name ? ` ${shipment.customer_name}` : ''},`,
    '',
    collected
      ? `Your order ${shipment.order_number} was collected.`
      : `Your order ${shipment.order_number} is on its way.`,
    '',
    collected ? 'Items collected:' : 'In this shipment:',
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
      ? ['', `${outstanding} ${outstanding === 1 ? 'item' : 'items'} on this order ${collected ? 'have not been collected' : 'have not shipped'} yet. We will let you know when they do.`].join('\n')
      : null,
    '',
    'Thank you.',
    settings.signature || businessName,
  ].filter((part) => part !== null && part !== undefined).join('\n');

  return {
    shipment,
    customerId: shipment.customer_id,
    recipient: trimOrNull(shipment.customer_email),
    subject: collected
      ? `Your order ${shipment.order_number} was collected`
      : `Your order ${shipment.order_number} has shipped`,
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

const STATUS_NOTICE = {
  OUT_FOR_DELIVERY: {
    kind: 'shipping_out_for_delivery', policy: 'outForDeliveryNotice',
    subject: (order) => `${order} is out for delivery`,
    opening: (order) => `Your order ${order} is out for delivery.`,
  },
  DELIVERED: {
    kind: 'shipping_delivered', policy: 'deliveredNotice',
    subject: (order) => `${order} was delivered`,
    opening: (order) => `The carrier reports that your order ${order} was delivered.`,
  },
  FAILURE: {
    kind: 'shipping_exception', policy: 'exceptionNotice',
    subject: (order) => `An update about ${order}`,
    opening: (order) => `The carrier reported a problem with your order ${order}.`,
  },
  RETURNED: {
    kind: 'shipping_exception', policy: 'exceptionNotice',
    subject: (order) => `${order} is returning to us`,
    opening: (order) => `The carrier reports that your order ${order} is returning to us.`,
  },
};

function messagePolicy(settings, messageKind) {
  if (messageKind === 'shipping_notice') return settings.shippingNotice;
  if (messageKind === 'shipping_out_for_delivery') return settings.outForDeliveryNotice;
  if (messageKind === 'shipping_delivered') return settings.deliveredNotice;
  if (messageKind === 'shipping_exception') return settings.exceptionNotice;
  return 'prepare';
}

/** Build a carrier-stage message from recorded scans only. */
function composeStatusNotice(db, workspaceId, shipmentId, status) {
  const definition = STATUS_NOTICE[String(status || '').toUpperCase()];
  if (!definition) return null;
  const shipment = db.prepare(`SELECT sh.*, so.order_number, so.id AS order_id,
      c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
    FROM sales_shipments sh JOIN sales_orders so ON so.id = sh.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE sh.id = ? AND sh.workspace_id = ?`).get(shipmentId, workspaceId);
  if (!shipment) throw new NotFoundError('That shipment is not in this inventory.');
  const scan = db.prepare(`SELECT detail, location, occurred_at FROM shipment_tracking_events
    WHERE workspace_id = ? AND shipment_id = ? AND status = ?
    ORDER BY occurred_at DESC, rowid DESC LIMIT 1`).get(workspaceId, shipmentId, status);
  const carrierName = carriers.displayName(shipment.carrier) || shipment.carrier || 'The carrier';
  const trackingUrl = shipment.tracking_url
    || carriers.trackingUrlFor(shipment.carrier, shipment.tracking_number);
  const settings = policy(db, workspaceId);
  const businessName = settings.businessName
    || db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId)?.name;
  const facts = [
    scan?.detail ? `Carrier detail: ${scan.detail}` : null,
    scan?.location ? `Last location: ${scan.location}` : null,
    scan?.occurred_at ? `Reported: ${String(scan.occurred_at).replace('T', ' ').slice(0, 16)}` : null,
    shipment.tracking_number ? `Tracking number: ${shipment.tracking_number}` : null,
    trackingUrl ? `Track it here: ${trackingUrl}` : null,
  ].filter(Boolean);
  return {
    definition, shipment, customerId: shipment.customer_id,
    recipient: trimOrNull(shipment.customer_email),
    subject: definition.subject(shipment.order_number),
    body: [
      `Hello${shipment.customer_name ? ` ${shipment.customer_name}` : ''},`, '',
      definition.opening(shipment.order_number), '',
      `${carrierName} supplied this update.`, ...facts, '',
      'We will keep monitoring the shipment.', '', settings.signature || businessName,
    ].filter((line) => line !== null && line !== undefined).join('\n'),
  };
}

/** Prepare at most one message for each consequential carrier stage. */
function prepareStatusNotice(db, ctx, shipmentId, status) {
  const draft = composeStatusNotice(db, ctx.workspaceId, shipmentId, status);
  if (!draft) return null;
  const settings = policy(db, ctx.workspaceId);
  if (messagePolicy(settings, draft.definition.kind) === 'off') return null;
  const key = `shipment:${shipmentId}:${draft.definition.kind}`;
  const existing = db.prepare(`SELECT * FROM customer_communications
    WHERE workspace_id = ? AND idempotency_key = ?`).get(ctx.workspaceId, key);
  if (existing) return get(db, ctx.workspaceId, existing.id);
  const now = nowIso();
  const id = newId('ccom');
  db.prepare(`INSERT INTO customer_communications
      (id, workspace_id, customer_id, sales_order_id, shipment_id, channel, recipient, subject, body,
       status, message_kind, connector_id, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, draft.customerId, draft.shipment.order_id, shipmentId,
      draft.recipient, draft.subject, draft.body, draft.definition.kind,
      settings.connectorId, key, now, now);
  return get(db, ctx.workspaceId, id);
}

/**
 * The message that carries a payment link.
 *
 * Every figure in it is read back out of the payment request and the order —
 * the amount asked for, the order number, the link itself. Nothing here
 * decides what is owed; that was decided by the customer's terms long before
 * this ran, and repeating the decision in prose is how a message ends up
 * disagreeing with the order it is about.
 */
function composePaymentLink(db, workspaceId, requestId) {
  const request = db.prepare(`SELECT pr.*, so.order_number, c.name AS customer_name, c.email AS customer_email
    FROM payment_requests pr
    JOIN sales_orders so ON so.id = pr.sales_order_id
    JOIN customers c ON c.id = pr.customer_id
    WHERE pr.workspace_id = ? AND pr.id = ?`).get(workspaceId, requestId);
  if (!request) throw new NotFoundError('That payment request is not in this inventory.');
  if (!request.hosted_url) {
    throw new ValidationError('There is no payment page for this request yet, so there is nothing to send.');
  }

  const settings = policy(db, workspaceId);
  const businessName = settings.businessName
    || db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId).name;
  const amount = `${request.currency} ${(Number(request.amount_minor) / 100).toFixed(2)}`;
  const deposit = request.purpose === 'DEPOSIT';

  const body = [
    `Hello ${request.customer_name},`,
    '',
    deposit
      ? `Here is the link to pay the ${amount} deposit on order ${request.order_number}.`
      : `Here is the link to pay ${amount} on order ${request.order_number}.`,
    '',
    request.hosted_url,
    '',
    'The page is secure and handled by our payment provider.',
    '',
    'Thank you.',
    settings.signature || businessName,
  ].join('\n');

  return {
    request,
    customerId: request.customer_id,
    salesOrderId: request.sales_order_id,
    recipient: trimOrNull(request.customer_email),
    subject: deposit
      ? `Deposit for order ${request.order_number}`
      : `Payment for order ${request.order_number}`,
    body,
  };
}

/** Write it down. One request, one message, however many times this is called. */
function preparePaymentLink(db, ctx, requestId) {
  const workspaceId = ctx.workspaceId;
  const key = `payment-request:${requestId}`;
  const existing = db.prepare('SELECT * FROM customer_communications WHERE workspace_id = ? AND idempotency_key = ?')
    .get(workspaceId, key);
  const draft = composePaymentLink(db, workspaceId, requestId);
  const settings = policy(db, workspaceId);
  const now = nowIso();

  if (existing) {
    if (existing.status === 'PREPARED') {
      db.prepare(`UPDATE customer_communications SET recipient = ?, subject = ?, body = ?,
        connector_id = ?, updated_at = ? WHERE id = ?`)
        .run(draft.recipient, draft.subject, draft.body, settings.connectorId, now, existing.id);
    }
    return get(db, workspaceId, existing.id);
  }

  const id = newId('ccom');
  db.prepare(`INSERT INTO customer_communications
      (id, workspace_id, customer_id, sales_order_id, channel, recipient, subject, body,
       status, message_kind, connector_id, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', 'payment_request', ?, ?, ?, ?)`)
    .run(id, workspaceId, draft.customerId, draft.salesOrderId,
      draft.recipient, draft.subject, draft.body, settings.connectorId, key, now, now);
  return get(db, workspaceId, id);
}

/**
 * A message the owner asked for, in their own words.
 *
 * The shipping notice and the payment link are written from records; this
 * one was written by a person, through the Tell StockChief box. It lands in the
 * same table under the same statuses and leaves through the same mailbox,
 * because a message going out over the owner's name has one path out of the
 * building — not one for the messages StockChief thought of and another for the
 * ones they did.
 */
function prepareOwnerMessage(db, ctx, input = {}) {
  const workspaceId = ctx.workspaceId;
  const recipient = trimOrNull(input.recipient);
  const body = String(input.body || '').trim();
  if (!recipient) throw new ValidationError('A message needs somebody to go to.');
  if (!body) throw new ValidationError('A message needs something in it.');

  // A heading is needed to send an email at all. This one is shown on the
  // page, editable, before anything goes — it is proposed, not slipped in.
  const settings = policy(db, workspaceId);
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId);
  const subject = trimOrNull(input.subject)
    || `A message from ${settings.businessName || (workspace && workspace.name) || 'us'}`;

  const id = newId('ccom');
  const now = nowIso();
  db.prepare(`INSERT INTO customer_communications
      (id, workspace_id, customer_id, sales_order_id, channel, recipient, subject, body,
       status, message_kind, connector_id, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', 'owner_message', ?, ?, ?, ?)`)
    .run(id, workspaceId, trimOrNull(input.customerId), trimOrNull(input.salesOrderId),
      recipient, subject, body, trimOrNull(input.connectorId), `owner-message:${id}`, now, now);
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
  if (state.paused || (state.suspended && (!state.suspendedScope
      || ['sales','customer'].includes(state.suspendedScope)))) {
    throw new ValidationError('StockChief is paused. Nothing was sent to the customer.');
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
 * Send it now if the workspace has said StockChief may. Returns what happened in
 * words, because "we told them" and "we could not" must not look alike.
 */
async function autoSend(db, ctx, message) {
  if (!message || message.status !== 'PREPARED') return { sent: false, reason: null };
  if (messagePolicy(policy(db, ctx.workspaceId), message.messageKind) !== 'send') {
    return { sent: false, reason: null };
  }
  /* "Send these for me" is the explicit, workspace-scoped authority for this
     exact notice type. Requiring a second hidden autonomy policy after the
     owner selected it made the visible setting lie about what would happen. */
  try {
    const autonomous = require('../autonomous/service');
    const operation = autonomous.create(db, ctx, {
      operationType:'customer.communicate',
      idempotencyKey:`customer-communication:${message.id}`,
      sourceKind:'customer_communication', sourceId:message.id,
      title:`Tell the customer ${message.messageKind === 'shipping_notice' ? 'their order shipped' : 'what changed'}`,
      summary:'A record-grounded shipping message is ready under the saved communication policy.',
      link:message.salesOrderId ? `/orders/${message.salesOrderId}/detail?open=shipping#shipping` : '/activity',
      evidence:[{ label:'Recipient', value:message.recipient },
        { label:'Message kind', value:message.messageKind }],
      decision:{ communicationId:message.id, messageKind:message.messageKind },
      affectedEntities:{ communicationId:message.id, customerId:message.customerId,
        salesOrderId:message.salesOrderId, shipmentId:message.shipmentId },
      authorityDimensions:{ customerId:message.customerId || undefined,
        confidence:'high', risk:'high' },
      expectedOutcome:{ communicationStatus:'SENT', messageKind:message.messageKind },
    });
    const governed = await autonomous.run(db, ctx, null, operation.id);
    const sent = get(db, ctx.workspaceId, message.id);
    if (governed.operation.status !== 'COMPLETED') {
      return { sent:false, reason:governed.operation.errorMessage
        || (governed.authority?.checks || []).filter((check) => !check.passed)
          .map((check) => check.reason).join(' '), message:sent, operation:governed.operation };
    }
    return { sent: sent.status === 'SENT', reason: null, message: sent };
  } catch (error) {
    return { sent: false, reason: String(error.message || error), message: get(db, ctx.workspaceId, message.id) };
  }
}

require('../autonomous/service').registerAdapter('customer.communicate', {
  owner:'sales.customer-communications',
  authorize:({ db, ctx, operation, execution }) => {
    if (operation.decision.kind === 'mailbox_reply') {
      const draft = require('../connections/reply-drafting').getDraft(db,
        ctx.workspaceId, operation.decision.messageId);
      const checks = [
        { name:'executionState', passed:execution.allowed,
          reason:execution.because || 'Customer reply automation is active.' },
        { name:'groundedReply', passed:Boolean(operation.decision.grounded && draft),
          reason:'Only a deterministic question derived from the customer’s own request may send automatically.' },
      ];
      return { allowed:checks.every((check) => check.passed), checks };
    }
    const settings = policy(db, ctx.workspaceId);
    const mailbox = sendingMailbox(db, ctx.workspaceId);
    const checks = [
      { name:'executionState', passed:execution.allowed,
        reason:execution.because || 'Customer communication automation is active.' },
      { name:'messagePolicy', passed:messagePolicy(settings, operation.decision.messageKind) === 'send',
        reason:'The visible policy for this exact shipping message must be set to send.' },
      { name:'mailbox', passed:Boolean(mailbox.connectorId),
        reason:'A connected customer mailbox is required.' },
      { name:'groundedMessage', passed:[
        'shipping_notice', 'shipping_out_for_delivery', 'shipping_delivered', 'shipping_exception',
      ].includes(operation.decision.messageKind),
        reason:'Only record-grounded shipping lifecycle messages are enabled here.' },
    ];
    return { allowed:checks.every((check) => check.passed), checks };
  },
  execute:({ db, ctx, operation }) => operation.decision.kind === 'mailbox_reply'
    ? require('../connections/reply-drafting').send(db, ctx,
      operation.decision.messageId)
    : sendThroughMailbox(db, ctx.workspaceId, operation.decision.communicationId, null),
  verify:({ db, ctx, operation }) => {
    if (operation.decision.kind === 'mailbox_reply') {
      const draft = require('../connections/reply-drafting').getDraft(db,
        ctx.workspaceId, operation.decision.messageId);
      const passed = draft?.status === 'SENT';
      return { passed, reason:passed
        ? 'The provider returned a sent identity for the grounded customer reply.'
        : (draft?.errorMessage || 'The customer reply is not confirmed as sent.'),
      messageId:operation.decision.messageId, externalMessageId:draft?.externalMessageId || null };
    }
    const message = get(db, ctx.workspaceId, operation.decision.communicationId);
    const passed = message?.status === 'SENT';
    return { passed, reason:passed
      ? 'StockChief reread the customer message as sent and retained its provider identity.'
      : (message?.errorMessage || 'The customer message is not confirmed as sent.'),
    communicationId:message?.id || operation.decision.communicationId,
    externalMessageId:message?.externalMessageId || null };
  },
});

module.exports = {
  composePaymentLink, preparePaymentLink,
  DEFAULT_POLICY, policy, setPolicy, sendingMailbox,
  get, forShipment, forOrder, waiting,
  composeShippingNotice, prepareShippingNotice, composeStatusNotice, prepareStatusNotice,
  messagePolicy, prepareOwnerMessage, updateDraft, cancel,
  sendThroughMailbox, onShipped, autoSend,
};
