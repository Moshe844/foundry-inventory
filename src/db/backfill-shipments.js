'use strict';

/**
 * A shipment for every order that shipped before shipments existed.
 *
 * Until fulfilment was built, "shipping" was a call into the sales order's own
 * fulfil: it moved the stock and recorded nothing about where the goods went.
 * Orders from that period read "7 shipped" beside "0 shipments", which is an
 * order page that cannot answer the first question anybody asks of it — where
 * did it go?
 *
 * Fixing the code fixed the next order. It did nothing for the ones already in
 * the database, and those are the ones somebody is looking at.
 *
 * Nothing here is invented. Every shipment is reconstructed from the order's
 * own fulfilment events, which recorded the line, the location, the quantity
 * and the movement ids at the time. What was never captured — a carrier, a
 * tracking number, the address as it stood that day — stays empty, because a
 * plausible guess about where a parcel went is worse than an honest blank.
 *
 * Runs once per order: an order that already has a shipment is left alone, so
 * this is safe on every start.
 */

const { newId, nowIso } = require('../lib/util');

const parse = (value) => { try { return JSON.parse(value) ?? {}; } catch { return {}; } };

function nextNumber(db, workspaceId) {
  const rows = db.prepare('SELECT shipment_number FROM sales_shipments WHERE workspace_id = ?').all(workspaceId);
  let highest = 1000;
  for (const row of rows) {
    const match = String(row.shipment_number || '').match(/^SHP-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `SHP-${highest + 1}`;
}

function backfillShipments(db) {
  // Orders that shipped something and have no shipment to show for it.
  let orders;
  try {
    orders = db.prepare(`SELECT so.id, so.workspace_id, so.order_number, so.customer_id,
        COALESCE(SUM(sol.quantity_fulfilled), 0) AS shipped
      FROM sales_orders so
      JOIN sales_order_lines sol ON sol.sales_order_id = so.id
      WHERE NOT EXISTS (SELECT 1 FROM sales_shipments sh WHERE sh.sales_order_id = so.id)
      GROUP BY so.id
      HAVING shipped > 0`).all();
  } catch {
    // The tables are not both there yet on a database mid-migration.
    return 0;
  }
  if (!orders.length) return 0;

  const events = db.prepare(`SELECT event_type, detail, created_at FROM sales_order_events
    WHERE sales_order_id = ? AND event_type IN ('FULFILLED', 'PARTIALLY_FULFILLED')
    ORDER BY created_at, rowid`);
  const insertShipment = db.prepare(`INSERT INTO sales_shipments
    (id, workspace_id, sales_order_id, shipment_number, status, ship_from_location_id,
     ship_to_address, notes, packed_at, shipped_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'SHIPPED', ?, ?, ?, ?, ?, ?, ?)`);
  const insertLine = db.prepare(`INSERT INTO sales_shipment_lines
    (id, workspace_id, shipment_id, sales_order_line_id, sku_id, location_id, quantity, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const customerAddress = db.prepare('SELECT shipping_address FROM customers WHERE id = ?');
  const lineExists = db.prepare('SELECT sku_id FROM sales_order_lines WHERE id = ?');

  let made = 0;
  const run = db.transaction(() => {
    for (const order of orders) {
      const history = events.all(order.id);
      if (!history.length) continue;

      const address = order.customer_id
        ? (customerAddress.get(order.customer_id) || {}).shipping_address || null
        : null;

      for (const event of history) {
        const lines = (parse(event.detail).fulfilled || [])
          .filter((line) => line && line.lineId && line.locationId && Number(line.quantity) > 0)
          // A line whose order line has since been removed cannot be rebuilt.
          .filter((line) => lineExists.get(line.lineId));
        if (!lines.length) continue;

        const shipmentId = newId('shp');
        const now = nowIso();
        const from = new Set(lines.map((line) => line.locationId));
        insertShipment.run(shipmentId, order.workspace_id, order.id,
          nextNumber(db, order.workspace_id),
          from.size === 1 ? lines[0].locationId : null,
          address,
          'Rebuilt from this order\'s own fulfilment record. Foundry did not capture a carrier '
            + 'or tracking number at the time, so it does not claim one.',
          event.created_at, event.created_at, event.created_at, now);

        for (const line of lines) {
          insertLine.run(newId('shl'), order.workspace_id, shipmentId, line.lineId,
            line.skuId || lineExists.get(line.lineId).sku_id, line.locationId,
            Number(line.quantity), event.created_at, now);
        }
        made += 1;
      }
    }
  });

  try { run(); } catch (error) {
    console.error('[foundry] could not rebuild historical shipments:', error.message);
    return 0;
  }
  if (made) console.log(`[foundry] rebuilt ${made} shipment record${made === 1 ? '' : 's'} from fulfilment history`);
  return made;
}

module.exports = { backfillShipments };
