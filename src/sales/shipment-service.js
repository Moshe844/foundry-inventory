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
  const row = db.prepare(`SELECT sh.*, so.order_number, so.customer_id, so.delivery_method,
      c.name AS customer_name,
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
  const regular = db.prepare(`SELECT ssl.*, NULL AS kit_component_id,
      i.name AS item_name, i.unit_label, i.tracking_mode, s.code AS sku_code,
      s.variant_label, l.name AS location_name
    FROM sales_shipment_lines ssl
    JOIN skus s ON s.id = ssl.sku_id
    JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = ssl.location_id
    WHERE ssl.shipment_id = ? AND ssl.workspace_id = ?
    ORDER BY l.name, i.name, s.variant_label`).all(shipmentId, workspaceId);
  const components = db.prepare(`SELECT ssl.*, parent_s.code AS kit_sku_code, parent_i.name AS kit_name,
      i.name AS item_name, i.unit_label, i.tracking_mode, s.code AS sku_code,
      s.variant_label, l.name AS location_name
    FROM sales_shipment_kit_lines ssl
    JOIN sales_order_lines parent_line ON parent_line.id = ssl.sales_order_line_id
    JOIN skus parent_s ON parent_s.id = parent_line.sku_id
    JOIN items parent_i ON parent_i.id = parent_s.item_id
    JOIN skus s ON s.id = ssl.sku_id
    JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = ssl.location_id
    WHERE ssl.shipment_id = ? AND ssl.workspace_id = ?
    ORDER BY l.name, parent_i.name, i.name, s.variant_label`).all(shipmentId, workspaceId);
  return [...regular, ...components].sort((a, b) => String(a.location_name).localeCompare(String(b.location_name))
    || String(a.kit_name || a.item_name).localeCompare(String(b.kit_name || b.item_name))
    || String(a.item_name).localeCompare(String(b.item_name)));
}

/**
 * What actually happened to this box, in words that match the record.
 *
 * A parcel with a courier and a tracking number was shipped. A box the
 * customer put in their own car was collected, and calling that "shipped to"
 * an address nobody entered is how StockChief ended up asserting a delivery that
 * never took place. Shipments recorded before the question existed say the
 * only true thing left to say about them.
 */
function wentBy(row) {
  if (!['SHIPPED', 'DELIVERED'].includes(row.status)) return null;
  if (row.handover === 'COLLECTED') return 'Collected by the customer';
  if (row.handover === 'DELIVERED_BY_US') return 'Delivered by us';
  if (row.handover === 'CARRIER' || row.carrier || row.tracking_number) {
    const named = carriers.displayName(row.carrier);
    return named ? `Sent by ${named}` : 'Sent by carrier';
  }
  return 'Left stock — how it went was not recorded';
}

/**
 * One word for what happened to everything that has left this order.
 *
 * The order page has to finish a sentence — "34 units ___" — and there is no
 * single word that is true of every order. Goods a customer collected were
 * not shipped; goods with no method recorded were not necessarily shipped
 * either. "Gone" is the word that is true when the others are not, and it is
 * deliberately less flattering than the one StockChief used to reach for.
 */
function wordForOrder(db, workspaceId, orderId) {
  const rows = db.prepare(`SELECT DISTINCT handover FROM sales_shipments
    WHERE workspace_id = ? AND sales_order_id = ? AND status IN ('SHIPPED','DELIVERED')`)
    .all(workspaceId, orderId).map((row) => row.handover);
  if (!rows.length) return 'gone';
  if (rows.every((how) => how === 'COLLECTED')) return 'collected';
  if (rows.every((how) => how === 'DELIVERED_BY_US')) return 'delivered';
  if (rows.every((how) => how === 'CARRIER')) return 'shipped';
  return 'gone';
}

function decorate(db, workspaceId, row) {
  const lines = shipmentLines(db, workspaceId, row.id);
  return {
    ...row,
    lines,
    units: lines.reduce((sum, line) => sum + Number(line.quantity), 0),
    carrierName: carriers.displayName(row.carrier),
    wentBy: wentBy(row),
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
  const kitRows = db.prepare(`SELECT ssl.kit_component_id, ssl.location_id, SUM(ssl.quantity) AS claimed
    FROM sales_shipment_kit_lines ssl
    JOIN sales_shipments sh ON sh.id = ssl.shipment_id
    WHERE sh.sales_order_id = ? AND sh.workspace_id = ?
      AND sh.status IN ('PICKING','PACKED')
    GROUP BY ssl.kit_component_id, ssl.location_id`).all(orderId, workspaceId);
  for (const row of kitRows) claimed.set(`kit:${row.kit_component_id}:${row.location_id}`, Number(row.claimed));
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
  const componentRows = db.prepare(`SELECT ka.id AS allocation_id,
      kc.sales_order_line_id, kc.id AS kit_component_id, ka.location_id, ka.quantity,
      kc.component_sku_id AS sku_id, i.name AS item_name, i.unit_label, i.tracking_mode,
      s.code AS sku_code, s.variant_label, l.name AS location_name,
      kit_i.name AS kit_name, kit_s.code AS kit_sku_code
    FROM sales_order_kit_allocations ka
    JOIN sales_order_kit_components kc ON kc.id = ka.kit_component_id
    JOIN sales_order_lines sol ON sol.id = kc.sales_order_line_id
    JOIN skus kit_s ON kit_s.id = sol.sku_id JOIN items kit_i ON kit_i.id = kit_s.item_id
    JOIN skus s ON s.id = kc.component_sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = ka.location_id
    WHERE sol.sales_order_id = ? AND ka.workspace_id = ?
    ORDER BY l.name, kit_i.name, i.name, s.variant_label`).all(orderId, workspaceId);
  return [...rows, ...componentRows].map((row) => {
    const key = row.kit_component_id
      ? `kit:${row.kit_component_id}:${row.location_id}`
      : `${row.sales_order_line_id}:${row.location_id}`;
    const taken = claimed.get(key) || 0;
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
    if (order.customer_decision_required || order.delivery_decision_required) {
      throw new ValidationError('Resolve the customer and delivery details before picking this order.');
    }
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
      ? new Map(input.lines.map((line) => [line.kitComponentId
        ? `kit:${line.kitComponentId}:${line.locationId}`
        : `${line.lineId}:${line.locationId}`, positive(line.quantity)]))
      : null;
    const chosen = [];
    for (const row of offered) {
      const key = row.kit_component_id
        ? `kit:${row.kit_component_id}:${row.location_id}`
        : `${row.sales_order_line_id}:${row.location_id}`;
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
    // Pickup is a confirmed absence of a carrier destination, not a missing
    // address to be repaired from the customer's profile. Once the order says
    // pickup, a historical/default shipping address must not leak into its box.
    const shipTo = order.delivery_method === 'PICKUP' ? null
      : trimOrNull(input.shipToAddress)
        || trimOrNull(order.ship_to_address)
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
    const insertKit = db.prepare(`INSERT INTO sales_shipment_kit_lines
      (id, workspace_id, shipment_id, kit_component_id, sales_order_line_id,
       sku_id, location_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of chosen) {
      if (row.kit_component_id) {
        insertKit.run(newId('shkl'), ctx.workspaceId, id, row.kit_component_id,
          row.sales_order_line_id, row.sku_id, row.location_id, row.quantity, now, now);
      } else {
        insert.run(newId('shl'), ctx.workspaceId, id, row.sales_order_line_id, row.sku_id,
          row.location_id, row.quantity, now, now);
      }
    }
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, id));
  });
}

/**
 * Change what is in the box while it is still open.
 */
function setLineQuantity(db, ctx, shipmentId, lineId, locationId, quantity, kitComponentId = null) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (!OPEN_SHIPMENT.includes(shipment.status)) {
      throw new ValidationError('This shipment has already gone. Its contents cannot be changed.');
    }
    const existing = kitComponentId
      ? db.prepare(`SELECT * FROM sales_shipment_kit_lines
        WHERE shipment_id = ? AND kit_component_id = ? AND location_id = ? AND workspace_id = ?`)
        .get(shipmentId, kitComponentId, locationId, ctx.workspaceId)
      : db.prepare(`SELECT * FROM sales_shipment_lines
        WHERE shipment_id = ? AND sales_order_line_id = ? AND location_id = ? AND workspace_id = ?`)
        .get(shipmentId, lineId, locationId, ctx.workspaceId);
    const wanted = Number(quantity);
    if (!Number.isInteger(wanted) || wanted < 0) throw new ValidationError('Quantity must be a whole number.');
    if (wanted === 0) {
      if (existing) db.prepare(`DELETE FROM ${kitComponentId ? 'sales_shipment_kit_lines' : 'sales_shipment_lines'} WHERE id = ?`).run(existing.id);
      return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
    }
    // What this line may hold is its own quantity plus whatever is still free.
    const free = pickable(db, ctx.workspaceId, shipment.sales_order_id)
      .find((row) => row.sales_order_line_id === lineId && row.location_id === locationId
        && String(row.kit_component_id || '') === String(kitComponentId || ''));
    const ceiling = (existing ? Number(existing.quantity) : 0) + (free ? free.available : 0);
    if (wanted > ceiling) {
      throw new ValidationError(`Only ${ceiling} of that is allocated and free to pick.`);
    }
    const now = nowIso();
    if (existing) {
      db.prepare(`UPDATE ${kitComponentId ? 'sales_shipment_kit_lines' : 'sales_shipment_lines'} SET quantity = ?, updated_at = ? WHERE id = ?`)
        .run(wanted, now, existing.id);
    } else if (kitComponentId) {
      const component = db.prepare(`SELECT c.component_sku_id FROM sales_order_kit_components c
        WHERE c.id = ? AND c.sales_order_line_id = ? AND c.workspace_id = ?`)
        .get(kitComponentId, lineId, ctx.workspaceId);
      if (!component) throw new NotFoundError('That kit component is not on this sales order.');
      db.prepare(`INSERT INTO sales_shipment_kit_lines
        (id, workspace_id, shipment_id, kit_component_id, sales_order_line_id,
         sku_id, location_id, quantity, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('shkl'), ctx.workspaceId, shipmentId, kitComponentId, lineId,
          component.component_sku_id, locationId, wanted, now, now);
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
function setDestination(db, ctx, shipmentId, input = {}) {
  return inTransaction(db, () => {
    const shipment = requireShipment(db, ctx.workspaceId, shipmentId);
    if (!OPEN_SHIPMENT.includes(shipment.status)) throw new ValidationError('A completed handover keeps its original destination. It needs a separately recorded correction, not a rewritten shipment history.');
    if (shipment.label_url || shipment.tracking_number) throw new ValidationError('This box already has carrier evidence. Resolve its label or tracking details before changing its destination.');
    const order = orders.resolveDelivery(db, ctx, shipment.sales_order_id, {
      deliveryMethod: input.deliveryMethod, shippingAddress: input.shippingAddress,
    });
    db.prepare('UPDATE sales_shipments SET ship_to_address = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(order.delivery_method === 'PICKUP' ? null : order.ship_to_address, nowIso(), shipmentId, ctx.workspaceId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });
}

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
/*
 * How the goods left, in the three ways goods actually leave a small business.
 *
 * StockChief used to accept a shipment with nothing said about it, and then tell
 * the owner the order was "shipped". Shipped where? By whom? Nobody had said,
 * and StockChief had not asked — it had simply moved the stock and picked the
 * most flattering word for what it had done.
 *
 * So the method is required and has no default. It is one click either way,
 * and now the click means something.
 */
const HANDOVER = {
  CARRIER: { label: 'Sent by carrier', past: 'shipped', needsAddress: true },
  COLLECTED: { label: 'Collected by the customer', past: 'collected', needsAddress: false },
  DELIVERED_BY_US: { label: 'Delivered by us', past: 'delivered', needsAddress: true },
};

function requireHandover(input, shipment = null) {
  const given = trimOrNull(input.handover);
  if (given && HANDOVER[given]) return given;
  /*
   * A tracking number is somebody telling us it went with a carrier, so it
   * answers the question on its own. Nothing else is inferred: a shipment with
   * no method stated is a shipment nobody has described, and StockChief says so
   * rather than choosing on their behalf.
   */
  if (trimOrNull(input.trackingNumber) || trimOrNull(input.carrier)) return 'CARRIER';
  /* Carry the delivery choice made on the order into fulfilment. Older orders
     predate that field, and their explicit "ship" action historically meant
     carrier, so they remain compatible without asking the owner twice. */
  if (shipment?.delivery_method === 'PICKUP') return 'COLLECTED';
  if (shipment?.delivery_method === 'DELIVER') return 'DELIVERED_BY_US';
  if (shipment?.delivery_method === 'SHIP') return 'CARRIER';
  throw new ValidationError('Say how these goods left: sent by carrier, collected by the customer, or delivered by us. StockChief will not record a shipment it cannot describe.');
}

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

  const handover = requireHandover(input, shipment);
  if (HANDOVER[handover].needsAddress && !trimOrNull(shipment.ship_to_address)) {
    throw new ValidationError('This box has no delivery address. Enter its destination before recording a carrier handover or delivery. Nothing has left stock.');
  }
  const trackingNumber = trimOrNull(input.trackingNumber) || trimOrNull(shipment.tracking_number);
  const detected = trackingNumber ? carriers.detect(trackingNumber) : null;
  const carrierCode = trimOrNull(input.carrier) || trimOrNull(shipment.carrier)
    || (detected ? detected.code : null);
  const cost = input.shippingCostMinor === undefined || input.shippingCostMinor === null
    || input.shippingCostMinor === '' ? shipment.shipping_cost_minor : Math.round(Number(input.shippingCostMinor));

  const fulfillmentLines=[];
  for(const line of lines){
    const base={lineId:line.sales_order_line_id,locationId:line.location_id,
      kitComponentId:line.kit_component_id||null};
    if(line.tracking_mode==='quantity'){fulfillmentLines.push({...base,quantity:Number(line.quantity)});continue;}
    const scans=db.prepare(`SELECT s.quantity,s.lot_id,s.serial_unit_id FROM fulfillment_wave_scans s
      JOIN fulfillment_wave_lines l ON l.id=s.line_id AND l.workspace_id=s.workspace_id
      WHERE s.workspace_id=? AND l.shipment_line_id=? AND s.status='ACCEPTED' ORDER BY s.seq`).all(ctx.workspaceId,line.id);
    if(line.tracking_mode==='serial'){
      const serialUnitIds=scans.map((scan)=>scan.serial_unit_id).filter(Boolean);
      if(serialUnitIds.length!==Number(line.quantity))throw new ValidationError('Every serial unit in this shipment must be scan-verified before it can leave.');
      fulfillmentLines.push({...base,quantity:serialUnitIds.length,serialUnitIds});
    }else{
      const byLot=new Map();scans.forEach((scan)=>{if(scan.lot_id)byLot.set(scan.lot_id,(byLot.get(scan.lot_id)||0)+Number(scan.quantity));});
      if([...byLot.values()].reduce((n,q)=>n+q,0)!==Number(line.quantity))throw new ValidationError('Every lot quantity in this shipment must be scan-verified before it can leave.');
      for(const [lotId,quantity] of byLot)fulfillmentLines.push({...base,quantity,lotId});
    }
  }
  orders.fulfill(db, ctx, shipment.sales_order_id, {
    lines: fulfillmentLines,
  }, { idempotencyKey: `sales-shipment:${shipmentId}`, handover, destinationAddress: shipment.ship_to_address });

  const result = inTransaction(db, () => {
    const now = nowIso();
    const trackingUrl = trimOrNull(shipment.tracking_url)
      || carriers.trackingUrlFor(carrierCode, trackingNumber);
    db.prepare(`UPDATE sales_shipments SET status = 'SHIPPED', handover = ?, carrier = ?, service = ?,
      tracking_number = ?, tracking_url = ?, shipping_cost_minor = ?, currency = ?,
      expected_delivery_date = ?, shipped_at = ?, packed_at = COALESCE(packed_at, ?),
      package_count = COALESCE(package_count, 1), notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?`)
      .run(handover, carrierCode, trimOrNull(input.service) || trimOrNull(shipment.service), trackingNumber,
        trackingUrl, cost,
        trimOrNull(input.currency) || trimOrNull(shipment.currency) || 'USD',
        trimOrNull(input.expectedDeliveryDate) || trimOrNull(shipment.expected_delivery_date),
        trimOrNull(input.shippedAt) || now, now, trimOrNull(input.notes), now, shipmentId);
    return decorate(db, ctx.workspaceId, requireShipment(db, ctx.workspaceId, shipmentId));
  });

  /*
   * Record the physical box in the same evidence chain as the order and the
   * inventory issues it caused. The fulfillment event already owns the exact
   * movement IDs, so this is a deterministic link rather than a time-based
   * guess. It also lets the owner-facing story name SHP-1001 instead of the
   * opaque internal event called "fulfilled".
   */
  try {
    const graph = require('../provenance/service');
    graph.record(db, ctx.workspaceId, {
      type: 'FULFILLED_BY',
      from: { type: 'sales_order', id: shipment.sales_order_id },
      to: { type: 'shipment', id: shipmentId },
      basis: 'DIRECT_RECORD',
    });
    const event = db.prepare(`SELECT id, detail FROM sales_order_events
      WHERE workspace_id = ? AND idempotency_key = ?`).get(
      ctx.workspaceId, `sales-shipment:${shipmentId}`);
    let detail = {};
    try { detail = JSON.parse(event?.detail || '{}'); } catch { detail = {}; }
    for (const line of detail.fulfilled || []) {
      for (const movementId of line.movementIds || []) {
        graph.record(db, ctx.workspaceId, {
          type: 'CAUSED_MOVEMENT',
          from: { type: 'shipment', id: shipmentId },
          to: { type: 'inventory_movement', id: movementId },
          basis: 'DIRECT_RECORD',
        });
      }
    }
  } catch { /* shipment truth is already committed; graph repair is idempotent */ }

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

  /*
   * The amount the customer agreed to pay for delivery is deliberately not
   * netted against carrier postage. One is revenue/receivable; the other is a
   * selling expense/cash payment. Keeping both facts lets margin and carrier
   * adjustments reconcile without pretending the provider charged the same
   * amount the customer paid.
   */
  const customerShipping = Number(result.customer_shipping_minor || 0);
  if (customerShipping > 0) {
    try {
      const ledger = require('../accounting/ledger');
      if (ledger.settings(db, ctx.workspaceId).enabled) {
        ledger.post(db, ctx, {
          postingDate: String(result.shipped_at || nowIso()).slice(0, 10),
          description: `Customer delivery charge for ${result.shipment_number}`,
          sourceType: 'customer_shipping_charge',
          sourceRecordType: 'sales_shipment',
          sourceRecordId: shipmentId,
          sourceKey: `customer-shipping-charge:${shipmentId}`,
          createdByType: ctx.actorId ? 'USER' : 'SYSTEM',
          approvedByUserId: ctx.actorId || null,
          metadata: { salesOrderId: result.sales_order_id,
            customerShippingMinor: customerShipping },
          lines: [
            { accountKey: 'ACCOUNTS_RECEIVABLE', debitMinor: customerShipping,
              customerId: order.customer_id, memo: result.shipment_number },
            { accountKey: 'SALES_REVENUE', creditMinor: customerShipping,
              customerId: order.customer_id, memo: 'Customer delivery charge' },
          ],
        });
      }
    } catch (error) {
      console.error('[shipping] customer delivery charge was not posted', error.message);
    }
  }
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
    if (shipment.label_url && shipment.label_status !== 'VOIDED') {
      throw new ValidationError('This parcel has paid postage. Void the carrier label first so the charge is not abandoned.');
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
    /*
     * The state is a key the rest of the product compares against; the label
     * is what a person reads. They differ because goods a customer collected
     * were never shipped, and the page should not say they were just because
     * the state machine calls this step SHIPPED.
     */
    const word = wordForOrder(db, workspaceId, order.id);
    return { state: 'Shipped', detail: null,
      label: word === 'collected' ? 'Collected' : word === 'delivered' ? 'Delivered'
        : word === 'shipped' ? 'Shipped' : 'Gone' };
  }
  if (count('PACKED')) return { state: 'Packed', detail: 'Boxed and waiting for a carrier.' };
  if (count('PICKING')) return { state: 'Picking', detail: 'Someone is walking this one now.' };
  if (Number(totals.fulfilled) > 0) {
    return { state: 'Partly shipped', label: 'Partly gone', detail: 'Some of this order has gone; the rest has not.' };
  }
  const free = pickable(db, workspaceId, order.id);
  if (free.length) {
    const units = free.reduce((sum, row) => sum + row.available, 0);
    return { state: 'Ready to pick', detail: `${units} allocated and waiting.` };
  }
  return { state: 'Waiting for stock', detail: 'Nothing is allocated to this order yet.' };
}

module.exports = { HANDOVER, wentBy, wordForOrder,
  OPEN_SHIPMENT, CLOSED_SHIPMENT,
  startPicking, setLineQuantity, setDestination, markPacked, ship, shipInOneStep, markDelivered, cancelShipment,
  pickable, pickList, listForOrder, getShipment, workQueue, fulfilmentState,
  nextShipmentNumber,
};
