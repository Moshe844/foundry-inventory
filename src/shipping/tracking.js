'use strict';

/*
 * Where the parcel actually is.
 *
 * A shipment used to be finished the moment it was marked shipped. Everything
 * after that — in transit, out for delivery, delivered, or the one that
 * matters, "we tried and nobody was in" — happened on the carrier's website
 * and nowhere in Foundry. So an order said "Shipped" for three weeks and a
 * parcel that had been sitting at a depot since Tuesday looked exactly like
 * one that arrived on Wednesday.
 *
 * The carrier tells us. Webhooks are the way this is meant to work — the
 * carrier knows the instant a scan happens and says so — and polling is the
 * recovery path for when a webhook was missed, an endpoint was unreachable, or
 * a tracking number was typed in by hand rather than bought here.
 *
 * Nothing here decides anything about the business. It records what the
 * carrier said, moves the shipment to delivered when the carrier says
 * delivered, and when something has gone wrong it puts a person in front of
 * it — because "the parcel came back" is a conversation with a customer, not
 * a status.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const providers = require('./provider');
const carriers = require('../sales/carriers');

/** The shipment a carrier's message is about, found the ways it can be found. */
function shipmentFor(db, workspaceId, read = {}) {
  const find = (sql, ...params) => db.prepare(sql).get(...params) || null;
  if (read.providerShipmentId) {
    const byShipment = find(`SELECT * FROM sales_shipments
      WHERE workspace_id = ? AND provider_shipment_id LIKE ?`,
    workspaceId, `%${read.providerShipmentId}%`);
    if (byShipment) return byShipment;
  }
  if (read.trackingNumber) {
    const byTracking = find(`SELECT * FROM sales_shipments
      WHERE workspace_id = ? AND tracking_number = ?`, workspaceId, read.trackingNumber);
    if (byTracking) return byTracking;
  }
  return null;
}

/*
 * Statuses in the order a parcel passes through them.
 *
 * Used to refuse to move a shipment backwards. Carriers deliver scans out of
 * order more often than anyone would like, and a delivered parcel that flips
 * back to "in transit" because a depot scan arrived late is a support call.
 */
const ORDER = { UNKNOWN: 0, PRE_TRANSIT: 1, IN_TRANSIT: 2, OUT_FOR_DELIVERY: 3,
  DELIVERED: 4, RETURNED: 4, FAILURE: 4, CANCELLED: 4 };

const rank = (status) => ORDER[String(status || 'UNKNOWN')] ?? 0;

/**
 * Take what the carrier said, and let the order show it.
 *
 * Idempotent on the carrier's own event id, so the same scan arriving by
 * webhook and again by the nightly sweep is one event and one update.
 */
function apply(db, ctx, shipment, read = {}) {
  const now = nowIso();
  const events = (read.events || []).filter((entry) => entry.occurredAt);
  const workspaceId = ctx.workspaceId;

  const recorded = inTransaction(db, () => {
    const insert = db.prepare(`INSERT OR IGNORE INTO shipment_tracking_events
      (id, workspace_id, shipment_id, provider, external_event_id, status, detail, location,
       occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    for (const entry of events) {
      const result = insert.run(newId('trkevt'), workspaceId, shipment.id,
        shipment.provider || read.provider || 'unknown',
        entry.externalEventId || `${shipment.id}:${entry.occurredAt}:${entry.status}`,
        entry.status, trimOrNull(entry.detail), trimOrNull(entry.location),
        entry.occurredAt, now);
      added += result.changes;
    }

    /*
     * The status only moves forward. A late depot scan must not un-deliver a
     * parcel the customer already has.
     */
    const current = shipment.tracking_status || 'UNKNOWN';
    const next = rank(read.status) >= rank(current) ? read.status : current;

    db.prepare(`UPDATE sales_shipments SET tracking_status = ?, tracking_status_detail = ?,
      tracked_at = ?, tracking_url = COALESCE(?, tracking_url),
      expected_delivery_date = COALESCE(?, expected_delivery_date),
      exception_reason = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(next, trimOrNull(read.detail), now, trimOrNull(read.trackingUrl),
        trimOrNull(read.estimatedDeliveryDate),
        providers.TROUBLE.includes(next) ? (trimOrNull(read.detail) || next) : null,
        now, shipment.id, workspaceId);
    return { added, status: next };
  });

  /*
   * Delivered is a business fact, not just a scan, so it goes through the
   * shipment service — which is what closes the shipment and lets the order
   * say the goods arrived.
   */
  if (recorded.status === 'DELIVERED' && shipment.status !== 'DELIVERED') {
    const delivered = events.filter((entry) => entry.status === 'DELIVERED')
      .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)))[0];
    try {
      require('../sales/shipment-service').markDelivered(db, ctx, shipment.id,
        { deliveredAt: delivered ? delivered.occurredAt : now });
    } catch { /* the scan is recorded either way; a closed shipment is not undone by this */ }
  }

  return recorded;
}

/**
 * A carrier message, from the door to the record.
 *
 * The raw message is written down before anything is made of it, in the same
 * discipline as payment events: a message Foundry could not understand should
 * be visible rather than lost.
 */
function receiveEvent(db, ctx, providerName, rawEvent, options = {}) {
  const provider = options.provider || providers.get(providerName);
  const read = provider.readEvent(rawEvent);
  const now = nowIso();
  const externalId = read.externalEventId || `${providerName}:${now}`;

  const already = db.prepare(`SELECT id, outcome FROM shipping_provider_events
    WHERE workspace_id = ? AND provider = ? AND external_event_id = ?`)
    .get(ctx.workspaceId, providerName, externalId);
  if (already) return { applied: false, replayed: true, outcome: already.outcome };

  const shipment = shipmentFor(db, ctx.workspaceId, read);
  const outcome = shipment
    ? `Recorded ${read.status.toLowerCase().replace(/_/g, ' ')} for ${shipment.shipment_number}.`
    : 'No shipment in this inventory matches that tracking number.';

  db.prepare(`INSERT INTO shipping_provider_events
    (id, workspace_id, provider, external_event_id, event_type, shipment_id, payload, outcome, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('shipevt'), ctx.workspaceId, providerName, externalId, trimOrNull(read.type),
      shipment ? shipment.id : null, JSON.stringify(rawEvent || {}), outcome, now);

  if (!shipment) return { applied: false, outcome };
  const result = apply(db, ctx, shipment, { ...read, provider: providerName });
  return { applied: true, outcome, shipmentId: shipment.id, ...result };
}

/**
 * Ask the carrier where things are, for shipments nobody has heard about.
 *
 * The fallback, and it says so. Only shipments that are actually in flight,
 * and only those that have gone quiet, because polling a carrier about a
 * parcel that reported an hour ago is asking a question you already have the
 * answer to.
 */
async function sweep(db, ctx, options = {}) {
  const providerName = options.providerName || providers.configured();
  if (!providerName) return { checked: 0, updated: 0, reason: 'no shipping account is connected' };
  const provider = options.provider || providers.get(providerName);
  const quietFor = Number(options.quietForMs || 6 * 60 * 60_000);
  const cutoff = new Date(Date.now() - quietFor).toISOString();

  const rows = db.prepare(`SELECT * FROM sales_shipments
    WHERE workspace_id = ? AND status = 'SHIPPED' AND tracking_number IS NOT NULL
      AND (tracking_status IS NULL OR tracking_status NOT IN ('DELIVERED','RETURNED','CANCELLED'))
      AND (tracked_at IS NULL OR tracked_at < ?)
    ORDER BY shipped_at LIMIT ?`).all(ctx.workspaceId, cutoff, Number(options.limit || 25));

  let updated = 0;
  for (const shipment of rows) {
    try {
      const read = await provider.track(ctx, {
        trackingNumber: shipment.tracking_number,
        carrier: shipment.carrier,
        providerShipmentId: shipment.provider_shipment_id,
      });
      if (!read) continue;
      const result = apply(db, ctx, shipment, { ...read, provider: providerName });
      if (result.added > 0) updated += 1;
    } catch {
      // A carrier that will not answer is not a reason to stop asking about
      // the next parcel, and the shipment keeps whatever it last knew.
    }
  }
  return { checked: rows.length, updated };
}

/**
 * "Track 1Z999…" — a number somebody has, for a parcel Foundry did not buy.
 *
 * Attaches it to a shipment when one is obviously waiting for it, and
 * otherwise says so rather than creating a shipment out of a string. A parcel
 * with no goods, no order and no customer is not a shipment; it is a number.
 */
async function trackNumber(db, ctx, trackingNumber, options = {}) {
  const number = String(trackingNumber || '').trim();
  if (!number) return { tracked: false, because: 'No tracking number was given.' };
  const detected = carriers.detect(number);

  const existing = db.prepare(`SELECT * FROM sales_shipments
    WHERE workspace_id = ? AND tracking_number = ?`).get(ctx.workspaceId, number);
  let shipment = existing;

  if (!shipment && options.shipmentId) {
    shipment = db.prepare('SELECT * FROM sales_shipments WHERE id = ? AND workspace_id = ?')
      .get(options.shipmentId, ctx.workspaceId);
    if (shipment) {
      db.prepare(`UPDATE sales_shipments SET tracking_number = ?, carrier = COALESCE(carrier, ?),
        tracking_url = COALESCE(tracking_url, ?), updated_at = ? WHERE id = ? AND workspace_id = ?`)
        .run(number, detected ? detected.code : null,
          carriers.trackingUrlFor(detected ? detected.code : shipment.carrier, number),
          nowIso(), shipment.id, ctx.workspaceId);
      shipment = db.prepare('SELECT * FROM sales_shipments WHERE id = ?').get(shipment.id);
    }
  }

  if (!shipment) {
    return { tracked: false, carrier: detected ? detected.name : null,
      because: 'Foundry has no shipment with that tracking number. Open the shipment it belongs to '
        + 'and add it there, so the number is attached to goods and a customer rather than to nothing.' };
  }

  const providerName = options.providerName || providers.configured();
  if (!providerName) {
    return { tracked: true, shipmentId: shipment.id, live: false,
      carrier: detected ? detected.name : carriers.displayName(shipment.carrier),
      because: 'The number is on the shipment and the tracking link works. Foundry cannot follow it '
        + 'automatically without a shipping account connected.' };
  }
  const provider = options.provider || providers.get(providerName);
  const read = await provider.track(ctx, { trackingNumber: number, carrier: shipment.carrier });
  if (!read) {
    return { tracked: true, shipmentId: shipment.id, live: false,
      because: 'The carrier has nothing for that number yet.' };
  }
  const result = apply(db, ctx, shipment, { ...read, provider: providerName });
  return { tracked: true, live: true, shipmentId: shipment.id, status: result.status,
    carrier: read.carrier || shipment.carrier };
}

/** The scans on one shipment, newest first. */
function eventsFor(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT * FROM shipment_tracking_events
    WHERE workspace_id = ? AND shipment_id = ? ORDER BY occurred_at DESC, rowid DESC`)
    .all(workspaceId, shipmentId);
}

/**
 * Parcels that are not going to arrive when they were supposed to.
 *
 * Two shapes: the carrier has said something is wrong, or the promised date
 * has passed and the parcel is still moving. Both are things a customer finds
 * out before the shop does unless somebody looks.
 */
function troubled(db, workspaceId, options = {}) {
  const today = String(options.today || nowIso()).slice(0, 10);
  return db.prepare(`SELECT s.*, o.order_number, c.name AS customer_name, c.email AS customer_email
    FROM sales_shipments s
    JOIN sales_orders o ON o.id = s.sales_order_id
    LEFT JOIN customers c ON c.id = o.customer_id
    WHERE s.workspace_id = ? AND s.status = 'SHIPPED'
      AND (s.tracking_status IN ('RETURNED','FAILURE')
        OR (s.expected_delivery_date IS NOT NULL AND s.expected_delivery_date < ?
            AND (s.tracking_status IS NULL OR s.tracking_status NOT IN ('DELIVERED','RETURNED','CANCELLED'))))
    ORDER BY s.expected_delivery_date`).all(workspaceId, today)
    .map((row) => ({
      ...row,
      late: Boolean(row.expected_delivery_date && row.expected_delivery_date < today
        && !providers.SETTLED.includes(row.tracking_status)),
      wrong: providers.TROUBLE.includes(row.tracking_status),
    }));
}

module.exports = { apply, receiveEvent, sweep, trackNumber, eventsFor, troubled, shipmentFor, rank };
