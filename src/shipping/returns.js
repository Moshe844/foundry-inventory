'use strict';

/* Carrier labels for an authorised customer return.
 *
 * This module owns postage evidence only. A delivered tracking scan does not
 * receive stock, decide condition, or issue money; the mature RMA workflow
 * remains the only owner of those effects.
 */

const { ValidationError, NotFoundError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');
const providers = require('./provider');
const accounts = require('./accounts');
const shipping = require('./service');

function get(db, workspaceId, returnId) {
  return db.prepare(`SELECT rl.*, r.return_number, r.status AS return_status,
      so.order_number, c.name AS customer_name
    FROM customer_return_labels rl
    JOIN customer_returns r ON r.id = rl.customer_return_id
    JOIN sales_orders so ON so.id = r.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE rl.workspace_id = ? AND rl.customer_return_id = ?`).get(workspaceId, returnId) || null;
}

function ratesFor(db, workspaceId, returnId) {
  return db.prepare(`SELECT * FROM customer_return_rates WHERE workspace_id = ?
    AND customer_return_id = ? ORDER BY amount_minor, delivery_days`).all(workspaceId, returnId)
    .map((row) => ({ id: row.id, provider: row.provider, providerRateId: row.provider_rate_id,
      providerShipmentIds: JSON.parse(row.provider_shipments || '[]'), carrier: row.carrier,
      service: row.service, amountMinor: Number(row.amount_minor), currency: row.currency,
      deliveryDays: row.delivery_days === null ? null : Number(row.delivery_days),
      deliveryDate: row.delivery_date, guaranteed: Boolean(row.guaranteed), quotedAt: row.quoted_at }));
}

function requireReturn(db, workspaceId, returnId) {
  const row = db.prepare(`SELECT r.*, so.order_number FROM customer_returns r
    JOIN sales_orders so ON so.id = r.sales_order_id
    WHERE r.workspace_id = ? AND r.id = ?`).get(workspaceId, returnId);
  if (!row) throw new NotFoundError('That customer return could not be found.');
  if (!['AUTHORIZED', 'PARTIALLY_RECEIVED'].includes(row.status)) {
    throw new ValidationError('Authorize the return before purchasing its carrier label.');
  }
  return row;
}

function outboundFor(db, workspaceId, salesOrderId, shipmentId = null) {
  const row = shipmentId
    ? db.prepare(`SELECT * FROM sales_shipments WHERE workspace_id = ? AND sales_order_id = ?
        AND id = ? AND status IN ('SHIPPED','DELIVERED')`).get(workspaceId, salesOrderId, shipmentId)
    : db.prepare(`SELECT * FROM sales_shipments WHERE workspace_id = ? AND sales_order_id = ?
        AND status IN ('SHIPPED','DELIVERED') ORDER BY shipped_at DESC LIMIT 1`).get(workspaceId, salesOrderId);
  if (!row) throw new ValidationError('StockChief needs the original fulfilled shipment before it can prove the return addresses and parcel.');
  return row;
}

async function quote(db, ctx, returnId, options = {}) {
  const rma = requireReturn(db, ctx.workspaceId, returnId);
  const outbound = outboundFor(db, ctx.workspaceId, rma.sales_order_id, options.outboundShipmentId);
  const held = accounts.contextFor(db, ctx);
  if (!held) throw new ValidationError('Connect this business’s shipping account before buying a return label.');
  const providerName = held.account.provider;
  const provider = options.provider || providers.get(providerName);
  const points = shipping.endpoints(db, ctx.workspaceId, outbound);
  if (!points.to.complete || !points.from.complete) {
    throw new ValidationError('The original customer and warehouse addresses must both be complete before StockChief can reverse the route.');
  }
  const packages = shipping.packagesFor(db, ctx.workspaceId, outbound.id);
  if (!packages.some((box) => Number(box.weightGrams) > 0)) {
    throw new ValidationError('The return parcel needs an evidenced weight before StockChief can request rates.');
  }
  const result = await provider.quote(held.ctx, {
    from: points.to, to: points.from,
    packages: packages.map((box) => ({ weightGrams: box.weightGrams,
      lengthMm: box.lengthMm, widthMm: box.widthMm, heightMm: box.heightMm })),
  });
  const now = nowIso();
  db.prepare('DELETE FROM customer_return_rates WHERE workspace_id = ? AND customer_return_id = ?')
    .run(ctx.workspaceId, returnId);
  const insert = db.prepare(`INSERT INTO customer_return_rates
    (id, workspace_id, customer_return_id, provider, provider_rate_id, provider_shipments,
     carrier, service, amount_minor, currency, delivery_days, delivery_date, guaranteed, quoted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const rate of result.rates || []) {
    insert.run(newId('rmarate'), ctx.workspaceId, returnId, providerName,
      (rate.rateIds || [rate.rateId]).join(','), JSON.stringify(result.providerShipmentIds || []),
      rate.carrier, rate.service, rate.amountMinor, rate.currency || 'USD', rate.deliveryDays,
      rate.deliveryDate, rate.guaranteed ? 1 : 0, now);
  }
  return { rma, outbound, providerName, provider, held, rates: ratesFor(db, ctx.workspaceId, returnId) };
}

async function buy(db, ctx, returnId, options = {}) {
  const existing = get(db, ctx.workspaceId, returnId);
  if (existing) {
    if (['PURCHASED','IN_TRANSIT','DELIVERED'].includes(existing.status)) return { label: existing, replayed: true };
    if (['PENDING','REVIEW'].includes(existing.status)) {
      throw new ValidationError('This return-label purchase is still being verified. StockChief will not retry it and risk buying twice.');
    }
  }
  const rma = requireReturn(db, ctx.workspaceId, returnId);
  const outbound = outboundFor(db, ctx.workspaceId, rma.sales_order_id, options.outboundShipmentId);
  const held = accounts.contextFor(db, ctx);
  if (!held) throw new ValidationError('Connect this business’s shipping account before buying a return label.');
  const providerName = held.account.provider;
  const provider = options.provider || providers.get(providerName);
  const available = ratesFor(db, ctx.workspaceId, returnId);
  if (!available.length) throw new ValidationError('Compare current return rates before buying a label.');
  const selected = options.rateId
    ? available.find((rate) => rate.id === options.rateId)
    : null;
  if (!selected) throw new ValidationError('Choose a rate the carrier just quoted for this return.');
  if (options.maxCostMinor !== undefined && Number(selected.amountMinor) > Number(options.maxCostMinor)) {
    throw new ValidationError('The return rate is above the approved amount. Nothing was purchased.');
  }
  const id = existing?.id || newId('rmalabel');
  const key = options.idempotencyKey || `customer-return-label:${returnId}`;
  const now = nowIso();
  if (!existing) {
    db.prepare(`INSERT INTO customer_return_labels
      (id, workspace_id, customer_return_id, outbound_shipment_id, provider, status,
       idempotency_key, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, returnId, outbound.id, providerName,
        key, ctx.actorId || null, now, now);
  }
  let bought;
  try {
    bought = await provider.buy(held.ctx, {
      providerShipmentIds: selected.providerShipmentIds,
      rateIds: String(selected.providerRateId).split(',').filter(Boolean), idempotencyKey: key,
    });
  } catch (error) {
    const definitive = Number(error.status) >= 400 && Number(error.status) < 500;
    db.prepare(`UPDATE customer_return_labels SET status = ?, updated_at = ? WHERE id = ?`)
      .run(definitive ? 'FAILED' : 'REVIEW', nowIso(), id);
    throw error;
  }
  db.prepare(`UPDATE customer_return_labels SET status = 'PURCHASED', provider_reference = ?,
    carrier = ?, service = ?, tracking_number = ?, tracking_url = ?, label_url = ?, label_format = ?,
    amount_minor = ?, currency = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(bought.providerLabelIds || bought.providerShipmentIds
      || [bought.providerShipmentId].filter(Boolean)), bought.carrier, bought.service,
      bought.trackingNumber, bought.trackingUrl, bought.labelUrl, bought.labelFormat,
      bought.amountMinor, bought.currency || 'USD', nowIso(), id);
  try {
    const ledger = require('../accounting/ledger');
    if (bought.amountMinor > 0 && ledger.settings(db, ctx.workspaceId).enabled) {
      ledger.post(db, ctx, {
        postingDate: nowIso().slice(0, 10), description: `Return postage for ${rma.return_number}`,
        sourceType: 'customer_return_postage', sourceRecordType: 'customer_return',
        sourceRecordId: returnId, sourceKey: `customer-return-postage:${returnId}`,
        createdByType: ctx.actorId ? 'USER' : 'SYSTEM', approvedByUserId: ctx.actorId || null,
        lines: [{ accountKey: 'SHIPPING_EXPENSE', debitMinor: bought.amountMinor, memo: 'Return postage' },
          { accountKey: 'CASH', creditMinor: bought.amountMinor, memo: 'Paid to carrier' }],
      });
    }
  } catch (error) { console.error('[shipping] return postage was not posted', error.message); }
  return { label: get(db, ctx.workspaceId, returnId), replayed: false, rates: available, selected };
}

async function refresh(db, ctx, returnId, options = {}) {
  const label = get(db, ctx.workspaceId, returnId);
  if (!label || !label.tracking_number) throw new ValidationError('This return has no tracking number.');
  const held = accounts.contextFor(db, ctx);
  const provider = options.provider || providers.get(label.provider);
  const tracked = await provider.track(held ? held.ctx : ctx,
    { trackingNumber: label.tracking_number, carrier: label.carrier });
  if (!tracked) return { label, updated: false };
  return applyTracking(db, ctx, label, tracked);
}

function applyTracking(db, ctx, label, tracked) {
  const now = nowIso();
  const insert = db.prepare(`INSERT OR IGNORE INTO customer_return_label_events
    (id, workspace_id, return_label_id, external_event_id, status, detail, location, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const event of tracked.events || []) {
    if (event.occurredAt) insert.run(newId('rmashipevt'), ctx.workspaceId, label.id,
      event.externalEventId || `${label.id}:${event.occurredAt}:${event.status}`,
      event.status, event.detail || null, event.location || null, event.occurredAt, now);
  }
  const next = tracked.status === 'DELIVERED' ? 'DELIVERED'
    : ['FAILURE','RETURNED','CANCELLED'].includes(tracked.status) ? 'FAILED'
      : tracked.status === 'PRE_TRANSIT' ? 'PURCHASED' : 'IN_TRANSIT';
  db.prepare('UPDATE customer_return_labels SET status = ?, tracking_url = COALESCE(?, tracking_url), updated_at = ? WHERE id = ?')
    .run(next, tracked.trackingUrl || null, now, label.id);
  return { label: get(db, ctx.workspaceId, label.customer_return_id), updated: true,
    needsPhysicalReceipt: next === 'DELIVERED' };
}

function receiveEvent(db, ctx, providerName, event, options = {}) {
  const provider = options.provider || providers.get(providerName);
  const tracked = provider.readEvent(event);
  const label = db.prepare(`SELECT * FROM customer_return_labels WHERE workspace_id = ?
    AND (tracking_number = ? OR provider_reference LIKE ?) ORDER BY created_at DESC LIMIT 1`)
    .get(ctx.workspaceId, tracked.trackingNumber || '', tracked.providerShipmentId ? `%${tracked.providerShipmentId}%` : '__none__');
  if (!label) return { applied: false, outcome: 'No customer return label matches that carrier event.' };
  const result = applyTracking(db, ctx, label, tracked);
  return { applied: true, outcome: `Recorded ${tracked.status.toLowerCase().replace(/_/g, ' ')} for a customer return.`, ...result };
}

module.exports = { get, ratesFor, quote, buy, refresh, applyTracking, receiveEvent };
