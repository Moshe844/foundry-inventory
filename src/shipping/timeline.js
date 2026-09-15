'use strict';

/*
 * One order-facing stream assembled from the durable shipping records.
 * Provider payloads stay in their audit table; the customer/order story gets
 * only canonical events whose timestamps and wording are supported by those
 * records. Nothing in this read model changes a shipment.
 */

function forOrder(db, workspaceId, orderId) {
  const labels = db.prepare(`SELECT t.id, t.operation, t.status,
      t.amount_minor, t.currency, t.detail, t.requested_at, t.completed_at,
      sh.id AS shipment_id, sh.shipment_number, sh.carrier, sh.service,
      sh.tracking_number
    FROM shipping_label_transactions t
    JOIN sales_shipments sh ON sh.id = t.shipment_id AND sh.workspace_id = t.workspace_id
    WHERE t.workspace_id = ? AND sh.sales_order_id = ?
      AND t.status IN ('SUCCEEDED','REVIEW')
    ORDER BY COALESCE(t.completed_at, t.requested_at), t.rowid`)
    .all(workspaceId, orderId).map((row) => ({
      id: row.id, kind: `LABEL_${row.operation}`, status: row.status,
      occurredAt: row.completed_at || row.requested_at,
      shipmentId: row.shipment_id, shipmentNumber: row.shipment_number,
      carrier: row.carrier, service: row.service, trackingNumber: row.tracking_number,
      amountMinor: row.amount_minor, currency: row.currency, detail: row.detail,
    }));
  const tracking = db.prepare(`SELECT e.id, e.status, e.detail, e.location,
      e.occurred_at, e.provider, sh.id AS shipment_id, sh.shipment_number,
      sh.carrier, sh.service, sh.tracking_number
    FROM shipment_tracking_events e
    JOIN sales_shipments sh ON sh.id = e.shipment_id AND sh.workspace_id = e.workspace_id
    WHERE e.workspace_id = ? AND sh.sales_order_id = ?
    ORDER BY e.occurred_at, e.rowid`).all(workspaceId, orderId).map((row) => ({
      id: row.id, kind: 'TRACKING', status: row.status,
      occurredAt: row.occurred_at, shipmentId: row.shipment_id,
      shipmentNumber: row.shipment_number, carrier: row.carrier,
      service: row.service, trackingNumber: row.tracking_number,
      detail: row.detail, location: row.location, provider: row.provider,
    }));
  return [...labels, ...tracking]
    .sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt))
      || String(a.id).localeCompare(String(b.id)));
}

module.exports = { forOrder };
