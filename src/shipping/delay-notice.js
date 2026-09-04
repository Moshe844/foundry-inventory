'use strict';

/*
 * Telling a customer their parcel is late, before they ask.
 *
 * I argued against writing this on the grounds that what to say about a late
 * parcel depends on things Foundry cannot see — whether this customer is owed
 * an apology, a refund, or a replacement sent today. That reasoning was about
 * the wrong thing. Deciding what to *do* does need a person. Saying where the
 * parcel is does not, and it is the part the customer is actually waiting for.
 *
 * So the message is written from the carrier's own scans and the order's own
 * dates, and it says only those. It offers nothing, promises nothing and
 * apologises for nothing on the owner's behalf — the decision that follows is
 * still theirs, and it is still in Needs You. What has changed is that when
 * they open it, the message they would have had to write is already written.
 *
 * Two shapes, because they are two different conversations:
 *
 *   late       still moving, past the date it should have arrived
 *   returned   the carrier has given up and is bringing it back
 *
 * Never sent by this file. Sending is `customer-communications`, under the
 * owner's communication authority, exactly as with a shipping notice.
 */

const { newId, nowIso } = require('../lib/util');
const carriers = require('../sales/carriers');
const providers = require('./provider');

const WORDS = {
  PRE_TRANSIT: 'has a label but has not been collected yet',
  IN_TRANSIT: 'is in transit',
  OUT_FOR_DELIVERY: 'is out for delivery',
  RETURNED: 'is on its way back to us',
  FAILURE: 'has run into a problem in the carrier\'s network',
  CANCELLED: 'has been cancelled by the carrier',
  UNKNOWN: 'has not been scanned recently',
};

/** The last thing the carrier actually said, and when. */
function lastScan(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT status, detail, location, occurred_at
    FROM shipment_tracking_events WHERE workspace_id = ? AND shipment_id = ?
    ORDER BY occurred_at DESC, rowid DESC LIMIT 1`).get(workspaceId, shipmentId) || null;
}

/**
 * The message, out of the records and nothing else.
 *
 * Every sentence is a fact somebody can check: the order number, the date the
 * customer was given, the carrier's own words, the tracking link. There is no
 * new delivery date in it, because nobody has one — a carrier that has missed
 * its estimate has not issued another, and inventing one is how a late parcel
 * becomes a lost customer.
 */
function compose(db, workspaceId, shipmentId) {
  const shipment = db.prepare(`SELECT sh.*, so.order_number, so.id AS order_id,
      c.id AS customer_id, c.name AS customer_name, c.email AS customer_email
    FROM sales_shipments sh
    JOIN sales_orders so ON so.id = sh.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE sh.id = ? AND sh.workspace_id = ?`).get(shipmentId, workspaceId);
  if (!shipment) return null;

  const returned = providers.TROUBLE.includes(shipment.tracking_status);
  const scan = lastScan(db, workspaceId, shipmentId);
  const carrierName = carriers.displayName(shipment.carrier) || 'the carrier';
  const trackingUrl = shipment.tracking_url
    || carriers.trackingUrlFor(shipment.carrier, shipment.tracking_number);
  const where = WORDS[shipment.tracking_status] || WORDS.UNKNOWN;

  const middle = returned
    ? [
      `${carrierName} ${where}${scan && scan.detail ? `, and gave the reason as "${scan.detail}"` : ''}.`,
      '',
      'Nothing has gone missing and you have not been charged twice. I wanted you to hear it from '
        + 'us rather than from a tracking page.',
    ]
    : [
      `It was due ${shipment.expected_delivery_date}, and ${carrierName} ${where}`
        + `${scan && scan.location ? `, last scanned in ${scan.location}` : ''}`
        + `${scan ? ` on ${String(scan.occurred_at).slice(0, 10)}` : ''}.`,
      '',
      `${carrierName} has not given a new date. I am not going to guess one — as soon as they do, `
        + 'or the parcel moves, I will let you know.',
    ];

  const body = [
    `Hello${shipment.customer_name ? ` ${shipment.customer_name}` : ''},`,
    '',
    returned
      ? `I am writing about your order ${shipment.order_number}, which is coming back to us.`
      : `I am writing about your order ${shipment.order_number}, which has not arrived when it should have.`,
    '',
    ...middle,
    '',
    ...(shipment.tracking_number
      ? [`Tracking: ${shipment.tracking_number}`,
        ...(trackingUrl ? [trackingUrl] : []), '']
      : []),
    returned
      ? 'Tell me where you would like it sent, or whether you would rather not have it, and I will sort it out.'
      : 'If you would rather not wait, tell me and I will sort something out.',
    '',
    'Thanks for your patience,',
  ].join('\n');

  return {
    customerId: shipment.customer_id,
    orderId: shipment.order_id,
    recipient: shipment.customer_email,
    subject: returned
      ? `Your order ${shipment.order_number} is coming back to us`
      : `Your order ${shipment.order_number} is running late`,
    body,
    kind: returned ? 'returned' : 'late',
    shipment,
  };
}

/**
 * Write it and keep it with the shipment, unsent.
 *
 * Keyed on the shipment and what went wrong, so a parcel that stays late for a
 * week produces one message rather than one a day. If the trouble changes —
 * late, and then returned — that is a different conversation and gets its own.
 * A message somebody has already sent is never rewritten.
 */
function prepare(db, ctx, shipmentId) {
  const workspaceId = ctx.workspaceId;
  const draft = compose(db, workspaceId, shipmentId);
  if (!draft) return null;
  if (!draft.recipient) {
    return { prepared: false, because: 'Foundry has no email address for this customer.' };
  }

  const notices = require('../sales/customer-communications');
  const settings = notices.policy(db, workspaceId);
  const key = `shipment:${shipmentId}:${draft.kind}`;
  const now = nowIso();

  const existing = db.prepare(`SELECT * FROM customer_communications
    WHERE workspace_id = ? AND idempotency_key = ?`).get(workspaceId, key);
  if (existing) {
    if (existing.status === 'PREPARED') {
      db.prepare(`UPDATE customer_communications SET recipient = ?, subject = ?, body = ?,
        connector_id = ?, updated_at = ? WHERE id = ?`)
        .run(draft.recipient, draft.subject, draft.body, settings.connectorId, now, existing.id);
    }
    return { prepared: true, replayed: true, message: notices.get(db, workspaceId, existing.id) };
  }

  const id = newId('ccom');
  db.prepare(`INSERT INTO customer_communications
      (id, workspace_id, customer_id, sales_order_id, shipment_id, channel, recipient, subject, body,
       status, message_kind, connector_id, idempotency_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'email', ?, ?, ?, 'PREPARED', ?, ?, ?, ?, ?)`)
    .run(id, workspaceId, draft.customerId, draft.orderId, shipmentId,
      draft.recipient, draft.subject, draft.body, `delay_notice_${draft.kind}`,
      settings.connectorId, key, now, now);
  return { prepared: true, replayed: false, message: notices.get(db, workspaceId, id) };
}

/**
 * Every parcel in trouble, with its message written.
 *
 * Runs unattended. Writing costs nothing and commits nobody — sending is a
 * separate act under the owner's communication authority, and this never
 * performs it.
 */
function prepareAll(db, ctx) {
  const tracking = require('./tracking');
  const results = [];
  for (const row of tracking.troubled(db, ctx.workspaceId)) {
    try { results.push({ shipmentId: row.id, ...(prepare(db, ctx, row.id) || {}) }); }
    catch (error) { results.push({ shipmentId: row.id, prepared: false, because: error.message }); }
  }
  return results;
}

module.exports = { compose, prepare, prepareAll, lastScan, WORDS };
