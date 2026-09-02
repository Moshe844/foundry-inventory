'use strict';

/*
 * Shipments: the physical half of a sales order.
 *
 * An order is a promise. A shipment is a box. One order can leave in three
 * boxes on three different days, and a customer asking "where is my order" is
 * really asking about a box, so the two are kept apart.
 *
 * Where stock moves, and where it does not
 * ---------------------------------------
 * Creating a shipment moves nothing. Packing moves nothing. Allocation
 * already means "spoken for, still here" - which is precisely the state of
 * goods sitting picked on a packing bench - so picking and packing need no
 * new physical state and invent no new number.
 *
 * The inventory issue happens once, at `ship`, and it happens by calling the
 * sales order's own `fulfill`. That keeps one movement per physical
 * departure, puts COGS on the day control actually transferred, and means
 * fulfilment has exactly one implementation rather than a second one that
 * drifts.
 */

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const orders = require('./sales-order-service');
const carriers = require('./carriers');
const paymentTerms = require('./payment-terms');

const OPEN_SHIPMENT = ['PICKING', 'PACKED'];
const CLOSED_SHIPMENT = ['SHIPPED', 'DELIVERED', 'CANCELLED'];

const positive = (value, label = 'Quantity') => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label} must be a positive whole number.`);
  return n;
};

function nextShipmentNumber(db, workspaceId) {
  const rows = db.prepare('SELECT shipment_number FROM sales_shipments WHERE workspace_id = ?').all(workspaceId);
  let highest = 1000;
  for (const row of rows) {
    const match = String(row.shipment_number || '').match(/^SHP-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `SHP-${highest + 1}`;
}

function requireShipment(db, workspaceId, shipmentId) {
  const row = db.prepare(`SELECT sh.*, so.order_number, so.customer_id, c.name AS customer_name,
      l.name AS ship_from_location_name
    FROM sales_shipments sh
    JOIN sales_orders so ON so.id = sh.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN locations l ON l.id = sh.ship_from_location_id
    WHERE sh.id = ? AND sh.workspace_id = ?`).get(shipmentId, workspaceId);
  if (!row) throw new NotFoundError('That shipment is not in this inventory.');
  return row;
}

function shipmentLines(db, workspaceId, shipmentId) {
  return db.prepare(`SELECT ssl.*, i.name AS item_name, i.unit_label, s.code AS sku_code,
      s.variant_label, l.name AS location_name
    FROM sales_shipment_lines ssl
    JOIN skus s ON s.id = ssl.sku_id
    JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = ssl.location_id
    WHERE ssl.shipment_id = ? AND ssl.workspace_id = ?
    ORDER BY l.name, i.name, s.variant_label`).all(shipmentId, workspaceId);
}

function decorate(db, workspaceId, row) {
  const lines = shipmentLines(db, workspaceId, row.id);
  return {
    ...row,
    lines,
    units: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
    carrierName: carriers.displayName(row.carrier),
    trackingUrl: row.tracking_url || carriers.trackingUrlFor(row.carrier, row.tracking_number),
  };
}

/**
 * What each allocation still has spare for a new shipment.
 *
 * Allocated stock can already be claimed by a box that is picked but not yet
 * gone. Counting only the allocation would let the same two units be packed
 * into two boxes, and the second one would fail at ship time - after somebody
 * had already taped it shut.
 */
function claimedByOpenShipments(db, workspaceId, orderId) {
  const rows = db.prepare(`SELECT ssl.sales_order_line_id, ssl.location_id, SUM(ssl.quantity) AS claimed
    FROM sales_shipment_lines ssl
    JOIN sales_shipments sh ON sh.id = ssl.shipment_id
    WHERE sh.sales_order_id = ? AND sh.workspace_id = ?
      AND sh.status IN ('PICKING','PACKED')
    GROUP BY ssl.sales_order_line_id, ssl.location_id`).all(orderId, workspaceId);
  const claimed = new Map();
  for (const row of rows) claimed.set(`${row.sales_order_line_id}:${row.location_id}`, Number(row.claimed));
  return claimed;
}

/**
 * Everything that could go into a new box right now, and where to walk to get it.
 */
function pickable(db, workspaceId, orderId) {
  const claimed = claimedByOpenShipments(db, workspaceId, orderId);
  const rows = db.prepare(`SELECT soa.id AS allocation_id, soa.sales_order_line_id, soa.location_id,
      soa.quantity, sol.sku_id, i.name AS item_name, i.unit_label, i.tracking_mode,
      s.code AS sku_code, s.variant_label, l.name AS location_name
    FROM sales_order_allocations soa
    JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
    JOIN skus s ON s.id = sol.sku_id
    JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = soa.location_id
    WHERE sol.sales_order_id = ? AND soa.workspace_id = ?
    ORDER BY l.name, i.name, s.variant_label`).all(orderId, workspaceId);
  return rows.map((row) => {
    const taken = claimed.get(`${row.sales_order_line_id}:${row.location_id}`) || 0;
    return {
      ...row,
      quantity: Number(row.quantity),
      claimed: taken,
      available: Math.max(0, Number(row.quantity) - taken),
    };
  }).filter((row) => row.available > 0);
}

/**
 * A pick list, grouped the way a person walks a warehouse: by location first,
 * because the cost of picking is footsteps, not keystrokes.
 */
function pickList(db, workspaceId, shipmentId) {
  const shipment = requireShipment(db, workspaceId, shipmentId);
  const lines = shipmentLines(db, workspaceId, shipmentId);
  const byLocation = new Map();
  for (const line of lines) {
    if (!byLocation.has(line.location_id)) {
      byLocation.set(line.location_id, {
        locationId: line.location_id, locationName: line.location_name, lines: [],
      });
    }
    byLocation.get(line.location_id).lines.push(line);
  }
  return {
    shipment,
    stops: [...byLocation.values()],
    units: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
  };
}

/**
 * Start a box. Lines default to everything pickable, because the common case
 * is "send what we have" and making somebody retype it is a way to get it wrong.
 */
function startPicking(db, ctx, orderId, input = {}) {
  return inTransaction(db, () => {
    const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
      .get(orderId, ctx.workspaceId);
    if (!order) throw new NotFoundError('That sales order is not in this inventory.');
    if (!orders.OPEN.includes(order.status)) {
      throw new ValidationError('Confirm this sales order before picking it.');
    }
    /*
     * Money can hold this before a box is opened.
     *
     * Checked here rather than only at shipping because the whole point of
     * "pays before we pick" is that nobody spends an hour walking a warehouse
     * for an order that is not going to leave.
     */
    const payment = paymentTerms.positionForOrder(db, ctx.workspaceId, order);
    if (payment.blocksPicking) {
      throw new ValidationError(`${payment.heldReason.pick} Take the payment, or approve this one order to go anyway.`);
    }

    const offered = pickable(db, ctx.workspaceId, orderId);
    if (!offered.length) {
      throw new ValidationError('Nothing is allocated to this order that is not already in a box.');
    }
    const asked = Array.isArray(input.lines) && input.lines.length
      ? new Map(input.lines.map((line) => [`${line.lineId}:${line.locationId}`, positive(line.quantity)]))
      : null;
    const chosen = [];
    for (const row of offered) {
      const key = `${row.sales_order_line_id}:${row.location_id}`;
      const quantity = asked ? Number(asked.get(key) || 0) : row.available;
      if (!quantity) continue;
      if (quantity > row.available) {
        throw new ValidationError(`Only ${row.available} of ${row.item_name} at ${row.location_name} is free to pick - the rest is already in another box.`);
      }
      chosen.push({ ...row, quantity });
    }
    if (!chosen.length) throw new ValidationError('Choose at least one line to pick.');

    const now = nowIso();
    const id = newId('shp');
    const shipFrom = trimOrNull(input.shipFromLocationId)
      || (new Set(chosen.map((row) => row.location_id)).size === 1 ? chosen[0].location_id : null);
    /*
     * The destination is copied onto the box rather than read through to the
     * customer, because a customer who moves next year must not silently
     * rewrite where last year's parcel was sent.
     */
    const customer = order.customer_id
      ? db.prepare('SELECT shipping_address FROM customers WHERE id = ? AND workspace_id = ?')
        .get(order.customer_id, ctx.workspaceId)
      : null;
    const shipTo = trimOrNull(input.shipToAddress)
      || (customer ? trimOrNull(customer.shipping_address) : null);
    db.prepare(`INSERT INTO sales_shipments
      (id, workspace_id, sales_order_id, shipment_number, status, ship_from_location_id,
       ship_to_address, notes, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PICKING', ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.workspaceId, orderId, nextShipmentNumber(db, ctx.workspaceId), shipFrom,
        shipTo, trimOrNull(input.notes), ctx.actorId || null, now, now);
    const insert = db.prepare(`INSERT INTO sales_shipment_lines
      (id, workspace_id, shipment_id, sales_order_line_id, sku_id, location_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of chosen) {
      insert.run(newId('shl'), ctx.workspaceId, id, row.sales_order_line_id, row.sku_id,
        row.location_id, row.quantity, now, now);
    }
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, id));
  });
}

/**
 * Change what is in the box while it is still open.
 */
function setLineQuantity(db, ctx, shipmentId, lineId, locationId, quantity) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (!OPEN_SHIPMENT.includes(shipment.status)) {
      throw new ValidationError('This shipment has already gone. Its contents cannot be changed.');
    }
    const existing = db.prepare(`SELECT * FROM sales_shipment_lines
      WHERE shipment_id = ? AND sales_order_line_id = ? AND location_id = ? AND workspace_id = ?`)
      .get(shipmentId, lineId, locationId, ctx.workspaceId);
    const wanted = Number(quantity);
    if (!Number.isInteger(wanted) || wanted < 0) throw new ValidationError('Quantity must be a whole number.');
    if (wanted === 0) {
      if (existing) db.prepare('DELETE FROM sales_shipment_lines WHERE id = ?').run(existing.id);
      return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
    }
    // What this line may hold is its own quantity plus whatever is still free.
    const free = pickable(db, ctx.workspaceId, shipment.sales_order_id)
      .find((row) => row.sales_order_line_id === lineId && row.location_id === locationId);
    const ceiling = (existing ? Number(existing.quantity) : 0) + (free ? free.available : 0);
    if (wanted > ceiling) {
      throw new ValidationError(`Only ${ceiling} of that is allocated and free to pick.`);
    }
    const now = nowIso();
    if (existing) {
      db.prepare('UPDATE sales_shipment_lines SET quantity = ?, updated_at = ? WHERE id = ?')
        .run(wanted, now, existing.id);
    } else {
      const line = db.prepare('SELECT sku_id FROM sales_order_lines WHERE id = ? AND workspace_id = ?')
        .get(lineId, ctx.workspaceId);
      if (!line) throw new NotFoundError('That product is not on this sales order.');
      db.prepare(`INSERT INTO sales_shipment_lines
        (id, workspace_id, shipment_id, sales_order_line_id, sku_id, location_id, quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('shl'), ctx.workspaceId, shipmentId, lineId, line.sku_id, locationId, wanted, now, now);
    }
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });
}

/**
 * Packed: the box is closed and weighed. Still nothing has left the building.
 */
function markPacked(db, ctx, shipmentId, input = {}) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (shipment.status === 'PACKED') return decorate(db, ctx.workspaceId, shipment);
    if (shipment.status !== 'PICKING') {
      throw new ValidationError('Only a shipment still being picked can be marked packed.');
    }
    const lines = shipmentLines(db, ctx.workspaceId, shipmentId);
    if (!lines.length) throw new ValidationError('This box is empty. Add what is going in it before packing.');
    const now = nowIso();
    db.prepare(`UPDATE sales_shipments SET status = 'PACKED', package_count = ?, weight_grams = ?,
      notes = COALESCE(?, notes), packed_at = ?, updated_at = ? WHERE id = ?`)
      .run(input.packageCount ? positive(input.packageCount, 'Package count') : 1,
        input.weightGrams ? positive(input.weightGrams, 'Weight') : null,
        trimOrNull(input.notes), now, now, shipmentId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });
}

/**
 * Ship: the one place stock actually leaves.
 *
 * This delegates to the sales order's own fulfilment, so there is a single
 * implementation of "goods left the building" - one movement, one COGS
 * posting, one set of events for everything downstream. Fulfilment runs
 * first: if the stock cannot actually be issued, nothing about this shipment
 * should read as though it went.
 */
function ship(db, ctx, shipmentId, input = {}) {
  const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
  if (shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED') {
    return decorate(db, ctx.workspaceId, shipment);
  }
  if (!OPEN_SHIPMENT.includes(shipment.status)) {
    throw new ValidationError('A cancelled shipment cannot be shipped.');
  }
  const lines = shipmentLines(db, ctx.workspaceId, shipmentId);
  if (!lines.length) throw new ValidationError('This box is empty. There is nothing to ship.');

  /*
   * The last gate, and the one that matters.
   *
   * Shipping is where the goods stop being ours, so a balance that was allowed
   * to sit through picking and packing is checked once more here. The box stays
   * packed and nothing is lost; only the parcel waits.
   */
  const order = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?')
    .get(shipment.sales_order_id, ctx.workspaceId);
  const payment = paymentTerms.positionForOrder(db, ctx.workspaceId, order);
  if (payment.blocksShipping) {
    throw new ValidationError(`${payment.heldReason.ship} The box stays packed until it is paid, or until you approve this one order to go anyway.`);
  }

  const trackingNumber = trimOrNull(input.trackingNumber);
  const detected = trackingNumber ? carriers.detect(trackingNumber) : null;
  const carrierCode = trimOrNull(input.carrier) || (detected ? detected.code : null);
  const cost = input.shippingCostMinor === undefined || input.shippingCostMinor === null
    || input.shippingCostMinor === '' ? null : Math.round(Number(input.shippingCostMinor));

  orders.fulfill(db, ctx, shipment.sales_order_id, {
    lines: lines.map((line) => ({
      lineId: line.sales_order_line_id,
      locationId: line.location_id,
      quantity: Number(line.quantity),
    })),
  }, { idempotencyKey: `sales-shipment:${shipmentId}` });

  const result = inTransaction(db, () => {
    const now = nowIso();
    db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', carrier = ?, service = ?,
      tracking_number = ?, tracking_url = ?, shipping_cost_minor = ?, currency = ?,
      expected_delivery_date = ?, shipped_at = ?, packed_at = COALESCE(packed_at, ?),
      package_count = COALESCE(package_count, 1), notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?`)
      .run(carrierCode, trimOrNull(input.service), trackingNumber,
        carriers.trackingUrlFor(carrierCode, trackingNumber), cost,
        trimOrNull(input.currency) || 'USD', trimOrNull(input.expectedDeliveryDate),
        trimOrNull(input.shippedAt) || now, now, trimOrNull(input.notes), now, shipmentId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });

  /*
   * Tell the customer, and let nothing about that undo this.
   *
   * The parcel has physically left; that is now a fact. Writing the notice is
   * a separate, later thing, and every way it can fail is recorded on the
   * message rather than thrown from here - a mail problem must never make a
   * shipped box look unshipped.
   */
  result.customerNotice = null;
  try {
    result.customerNotice = require('./customer-communications').onShipped(db, ctx, shipmentId);
  } catch { /* the box went; that is not in question here */ }
  return result;
}

/**
 * Ship without opening a box first.
 *
 * The order page has always had a fast path — "record the items as shipped" —
 * for the shop that picks an order in ninety seconds and does not want a
 * picking screen for it. That path called the sales order's fulfil directly,
 * which moved the stock and recorded nothing else. The result was an order
 * reading "7 shipped" beside "0 shipments": no address, no tracking, no notice
 * to the customer, and no answer to "where did it go?".
 *
 * So the fast path is still one click, and it still produces a shipment. The
 * box is opened and closed in the same breath rather than not existing.
 */
function shipInOneStep(db, ctx, orderId, input = {}) {
  const box = startPicking(db, ctx, orderId, { lines: input.lines });
  return ship(db, ctx, box.id, input);
}

function markDelivered(db, ctx, shipmentId, input = {}) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (shipment.status === 'DELIVERED') return decorate(db, ctx.workspaceId, shipment);
    if (shipment.status !== 'SHIPPED') {
      throw new ValidationError('Only a shipment that has left can be marked delivered.');
    }
    const now = nowIso();
    db.prepare('UPDATE sales_shipments SET status = \'DELIVERED\', delivered_at = ?, updated_at = ? WHERE id = ?')
      .run(trimOrNull(input.deliveredAt) || now, now, shipmentId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });
}

/**
 * Cancelling a box releases nothing physical, because nothing physical moved.
 * The allocation it was holding simply becomes pickable again.
 */
function cancelShipment(db, ctx, shipmentId, reason = null) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (CLOSED_SHIPMENT.includes(shipment.status)) {
      throw new ValidationError('This shipment has already gone. Record a return instead of cancelling it.');
    }
    const now = nowIso();
    db.prepare('UPDATE sales_shipments SET status = \'CANCELLED\', notes = COALESCE(?, notes), updated_at = ? WHERE id = ?')
      .run(trimOrNull(reason), now, shipmentId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });
}

function listForOrder(db, workspaceId, orderId) {
  return db.prepare(`SELECT sh.*, l.name AS ship_from_location_name
    FROM sales_shipments sh
    LEFT JOIN locations l ON l.id = sh.ship_from_location_id
    WHERE sh.sales_order_id = ? AND sh.workspace_id = ?
    ORDER BY sh.created_at, sh.id`).all(orderId, workspaceId)
    .map((row) => decorate(db, workspaceId, row));
}

function getShipment(db, workspaceId, shipmentId) {
  return decorate(db, workspaceId, requireShipment(db, workspaceId, shipmentId));
}

/**
 * The fulfilment queue: every box that still needs a person, oldest first,
 * plus every confirmed order with stock allocated and no box started.
 */
function workQueue(db, workspaceId) {
  const open = db.prepare(`SELECT sh.*, so.order_number, c.name AS customer_name,
      l.name AS ship_from_location_name
    FROM sales_shipments sh
    JOIN sales_orders so ON so.id = sh.sales_order_id
    LEFT JOIN customers c ON c.id = so.customer_id
    LEFT JOIN locations l ON l.id = sh.ship_from_location_id
    WHERE sh.workspace_id = ? AND sh.status IN ('PICKING','PACKED')
    ORDER BY sh.created_at, sh.id`).all(workspaceId)
    .map((row) => decorate(db, workspaceId, row));

  const ready = db.prepare(`SELECT so.id, so.order_number, so.needed_by, c.name AS customer_name
    FROM sales_orders so
    LEFT JOIN customers c ON c.id = so.customer_id
    WHERE so.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY so.needed_by IS NULL, so.needed_by, so.order_date, so.order_number`).all(workspaceId)
    .map((row) => ({ ...row, pickable: pickable(db, workspaceId, row.id) }))
    .filter((row) => row.pickable.length)
    .map((row) => ({ ...row, units: row.pickable.reduce((sum, line) => sum + line.available, 0) }));

  return { open, ready };
}

/**
 * The single word for where an order physically stands.
 *
 * Derived, never stored: a stored status is a second place for the truth to
 * live, and it is always the one that goes stale.
 */
function fulfilmentState(db, workspaceId, order) {
  if (order.status === 'CANCELLED') return { state: 'Cancelled', detail: null };
  if (order.status === 'DRAFT') return { state: 'Not confirmed', detail: 'Confirm this order before picking it.' };

  const counts = db.prepare(`SELECT status, COUNT(*) AS n FROM sales_shipments
    WHERE sales_order_id = ? AND workspace_id = ? GROUP BY status`).all(order.id, workspaceId);
  const count = (status) => Number((counts.find((row) => row.status === status) || {}).n || 0);
  const totals = db.prepare(`SELECT COALESCE(SUM(quantity_ordered), 0) AS ordered,
      COALESCE(SUM(quantity_fulfilled), 0) AS fulfilled
    FROM sales_order_lines WHERE sales_order_id = ? AND workspace_id = ?`).get(order.id, workspaceId);
  const allGone = Number(totals.ordered) > 0 && Number(totals.fulfilled) >= Number(totals.ordered);

  if (allGone) {
    if (count('SHIPPED') === 0 && count('DELIVERED') > 0) return { state: 'Delivered', detail: null };
    return { state: 'Shipped', detail: null };
  }
  if (count('PACKED')) return { state: 'Packed', detail: 'Boxed and waiting for a carrier.' };
  if (count('PICKING')) return { state: 'Picking', detail: 'Someone is walking this one now.' };
  if (Number(totals.fulfilled) > 0) {
    return { state: 'Partly shipped', detail: 'Some of this order has gone; the rest has not.' };
  }
  const free = pickable(db, workspaceId, order.id);
  if (free.length) {
    const units = free.reduce((sum, row) => sum + row.available, 0);
    return { state: 'Ready to pick', detail: `${units} allocated and waiting.` };
  }
  return { state: 'Waiting for stock', detail: 'Nothing is allocated to this order yet.' };
}

module.exports = {
  OPEN_SHIPMENT, CLOSED_SHIPMENT,
  startPicking, setLineQuantity, markPacked, ship, shipInOneStep, markDelivered, cancelShipment,
  pickable, pickList, listForOrder, getShipment, workQueue, fulfilmentState,
  nextShipmentNumber,
};
