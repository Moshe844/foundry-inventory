'use strict';

const { inTransaction } = require('../db');
const { newId, nowIso, trimOrNull } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const inventory = require('../domain/inventory-engine');
const managerEvents = require('../manager/events');
const reactions = require('../manager/reactions');
const prices = require('../pricing/price-service');

const OPEN = ['CONFIRMED', 'BACKORDERED', 'PARTIALLY_FULFILLED'];
const json = (value, fallback = {}) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const positive = (value, label = 'Quantity') => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label} must be a positive whole number.`);
  return n;
};

function requireCustomer(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM customers WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new NotFoundError('That customer is not in this inventory.');
  return row;
}

function createCustomer(db, ctx, input) {
  const name = trimOrNull(input.name);
  if (!name) throw new ValidationError('Enter the customer name.');
  const existing = db.prepare('SELECT * FROM customers WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.workspaceId, name);
  if (existing) return existing;
  const id = newId('cus');
  const now = nowIso();
  db.prepare(`INSERT INTO customers
    (id, workspace_id, name, company, email, phone, shipping_address, notes, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, name, trimOrNull(input.company), trimOrNull(input.email), trimOrNull(input.phone),
      trimOrNull(input.shippingAddress), trimOrNull(input.notes), ctx.actorId, now, now);
  return requireCustomer(db, ctx.workspaceId, id);
}

function listCustomers(db, workspaceId) {
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM sales_orders so WHERE so.customer_id = c.id) AS order_count
    FROM customers c WHERE c.workspace_id = ? ORDER BY c.name COLLATE NOCASE`).all(workspaceId);
}

function getCustomer(db, workspaceId, customerId) {
  const customer = requireCustomer(db, workspaceId, customerId);
  return { ...customer, orders: listOrders(db, workspaceId, { customerId, limit: 200 }) };
}

function updateCustomer(db, ctx, customerId, input) {
  return inTransaction(db, () => {
    requireCustomer(db, ctx.workspaceId, customerId);
    const name = trimOrNull(input.name);
    if (!name) throw new ValidationError('Enter the customer name.');
    const duplicate = db.prepare(`SELECT id FROM customers
      WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id <> ?`).get(ctx.workspaceId, name, customerId);
    if (duplicate) throw new ValidationError('Another customer already uses that name.');
    db.prepare(`UPDATE customers SET name = ?, company = ?, email = ?, phone = ?,
      shipping_address = ?, notes = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(name, trimOrNull(input.company), trimOrNull(input.email), trimOrNull(input.phone),
        trimOrNull(input.shippingAddress), trimOrNull(input.notes), nowIso(), customerId, ctx.workspaceId);
    return getCustomer(db, ctx.workspaceId, customerId);
  });
}

function nextOrderNumber(db, workspaceId) {
  const rows = db.prepare('SELECT order_number FROM sales_orders WHERE workspace_id = ?').all(workspaceId);
  let highest = 1000;
  for (const row of rows) {
    const match = String(row.order_number || '').match(/^SO-(\d+)$/i);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `SO-${highest + 1}`;
}

function ensureSku(db, workspaceId, skuId) {
  const row = db.prepare(`SELECT s.*, i.name AS item_name, i.unit_label, i.tracking_mode
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.id = ? AND s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1`).get(skuId, workspaceId);
  if (!row) throw new ValidationError('Choose an active product or variant from this inventory.');
  return row;
}

function ensureLocation(db, workspaceId, locationId) {
  if (!locationId) return null;
  const row = db.prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ? AND is_active = 1')
    .get(locationId, workspaceId);
  if (!row) throw new ValidationError('Choose an active fulfillment location from this inventory.');
  return row;
}

function recordEvent(db, ctx, orderId, eventType, detail = {}, idempotencyKey = null) {
  const key = idempotencyKey || `${eventType}:${orderId}:${newId('change')}`;
  const existing = db.prepare('SELECT * FROM sales_order_events WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, key);
  if (existing) return existing;
  const id = newId('soe');
  db.prepare(`INSERT INTO sales_order_events
    (id, workspace_id, sales_order_id, event_type, detail, actor_user_id, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, orderId, eventType, JSON.stringify(detail || {}), ctx.actorId, key, nowIso());
  return db.prepare('SELECT * FROM sales_order_events WHERE id = ?').get(id);
}

function createOrder(db, ctx, input) {
  return inTransaction(db, () => {
    const customer = input.customerId
      ? requireCustomer(db, ctx.workspaceId, input.customerId)
      : createCustomer(db, ctx, { name: input.customerName, company: input.company });
    ensureLocation(db, ctx.workspaceId, input.fulfillmentLocationId);
    const lines = Array.isArray(input.lines) ? input.lines : [];
    if (!lines.length) throw new ValidationError('Add at least one product to the sales order.');
    const merged = new Map();
    for (const line of lines) {
      ensureSku(db, ctx.workspaceId, line.skuId);
      const existing = merged.get(line.skuId) || { quantity: 0, unitPriceMinor: null };
      const suppliedPrice = line.unitPriceMinor === null || line.unitPriceMinor === undefined
        ? null : Number(line.unitPriceMinor);
      if (suppliedPrice !== null && (!Number.isInteger(suppliedPrice) || suppliedPrice < 0)) {
        throw new ValidationError('An external order line price must be a non-negative whole number of minor currency units.');
      }
      if (existing.unitPriceMinor !== null && suppliedPrice !== null && existing.unitPriceMinor !== suppliedPrice) {
        throw new ValidationError('The same product cannot have two different unit prices on one sales order.');
      }
      merged.set(line.skuId, { quantity: existing.quantity + positive(line.quantity),
        unitPriceMinor: suppliedPrice === null ? existing.unitPriceMinor : suppliedPrice });
    }
    const pricedLines = [...merged].map(([skuId, entry]) => ({ skuId, quantity: entry.quantity,
      price: entry.unitPriceMinor === null ? prices.currentForSku(db, ctx.workspaceId, skuId)
        : { isSet: true, amount_minor: entry.unitPriceMinor, id: null, currency: input.currency || 'USD' } }));
    if (input.requirePrices && pricedLines.some((line) => !line.price.isSet)) {
      const missing = pricedLines.filter((line) => !line.price.isSet)
        .map((line) => prices.requireSku(db, ctx.workspaceId, line.skuId).display_name);
      throw new ValidationError(`${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not have a selling price. Set a price or enter one for this order before creating it.`, {
        reason: 'missing_sales_price', skuIds: pricedLines.filter((line) => !line.price.isSet).map((line) => line.skuId),
      });
    }
    const currencies = [...new Set(pricedLines.filter((line) => line.price.isSet).map((line) => line.price.currency))];
    if (currencies.length > 1) throw new ValidationError('This order contains selling prices in more than one currency. Use one currency per sales order.');
    const currency = prices.normaliseCurrency(input.currency || currencies[0] || 'USD');
    if (currencies.length && currencies[0] !== currency) throw new ValidationError(`These products are priced in ${currencies[0]}, not ${currency}.`);
    const discountMinor = prices.toMinor(input.discount || '0', 'Discount') || 0;
    const taxMinor = prices.toMinor(input.tax || '0', 'Tax') || 0;
    const id = newId('so');
    const now = nowIso();
    const orderNumber = trimOrNull(input.orderNumber) || nextOrderNumber(db, ctx.workspaceId);
    db.prepare(`INSERT INTO sales_orders
      (id, workspace_id, customer_id, order_number, order_date, needed_by, fulfillment_location_id,
       notes, reference, currency, discount_minor, tax_minor, status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?)`)
      .run(id, ctx.workspaceId, customer.id, orderNumber, trimOrNull(input.orderDate) || now.slice(0, 10),
        trimOrNull(input.neededBy), input.fulfillmentLocationId || null, trimOrNull(input.notes),
        trimOrNull(input.reference), currency, discountMinor, taxMinor, ctx.actorId, now, now);
    for (const line of pricedLines) {
      db.prepare(`INSERT INTO sales_order_lines
        (id, workspace_id, sales_order_id, sku_id, quantity_ordered, quantity_fulfilled,
         unit_price_minor, price_source_id, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?)`)
        .run(newId('sol'), ctx.workspaceId, id, line.skuId, line.quantity,
          line.price.isSet ? line.price.amount_minor : null, line.price.isSet ? line.price.id : null, now, now);
    }
    recordEvent(db, ctx, id, 'CREATED', { orderNumber, customerId: customer.id }, `sales-order-created:${id}`);
    return getOrder(db, ctx.workspaceId, id);
  });
}

function committedByPosition(db, workspaceId, { skuIds = null } = {}) {
  const ids = skuIds && skuIds.length ? [...new Set(skuIds)] : null;
  const clause = ids ? ` AND sol.sku_id IN (${ids.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT sol.sku_id, soa.location_id, SUM(soa.quantity) AS committed
    FROM sales_order_allocations soa
    JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
    JOIN sales_orders so ON so.id = sol.sales_order_id
    WHERE soa.workspace_id = ? AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')${clause}
    GROUP BY sol.sku_id, soa.location_id`).all(workspaceId, ...(ids || []));
}

function availabilityForSku(db, workspaceId, skuId) {
  ensureSku(db, workspaceId, skuId);
  const committed = new Map(committedByPosition(db, workspaceId, { skuIds: [skuId] })
    .map((row) => [row.location_id, Number(row.committed)]));
  const positions = db.prepare(`SELECT l.id AS location_id, l.name AS location_name, l.kind,
      COALESCE(b.on_hand, 0) AS on_hand
    FROM locations l LEFT JOIN balances b ON b.location_id = l.id AND b.sku_id = ?
    WHERE l.workspace_id = ? AND l.is_active = 1 ORDER BY l.name COLLATE NOCASE`).all(skuId, workspaceId)
    .map((row) => ({ ...row, committed: committed.get(row.location_id) || 0,
      available: Number(row.on_hand) - (committed.get(row.location_id) || 0) }));
  return {
    skuId,
    onHand: positions.reduce((n, row) => n + Number(row.on_hand), 0),
    committed: positions.reduce((n, row) => n + row.committed, 0),
    available: positions.reduce((n, row) => n + row.available, 0),
    positions,
  };
}

function allocateLine(db, workspaceId, line, preferredLocationId = null) {
  const remaining = Number(line.quantity_ordered) - Number(line.quantity_fulfilled)
    - db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM sales_order_allocations WHERE sales_order_line_id = ?')
      .get(line.id).n;
  if (remaining <= 0) return { allocated: 0, backordered: 0, allocations: [] };
  const availability = availabilityForSku(db, workspaceId, line.sku_id).positions
    .filter((row) => row.available > 0)
    .sort((a, b) => {
      if (preferredLocationId && a.location_id === preferredLocationId) return -1;
      if (preferredLocationId && b.location_id === preferredLocationId) return 1;
      return b.available - a.available || String(a.location_name).localeCompare(String(b.location_name));
    });
  let needed = remaining;
  const allocations = [];
  const now = nowIso();
  for (const position of availability) {
    if (needed <= 0) break;
    const quantity = Math.min(needed, position.available);
    if (quantity <= 0) continue;
    db.prepare(`INSERT INTO sales_order_allocations
      (id, workspace_id, sales_order_line_id, location_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sales_order_line_id, location_id) DO UPDATE SET
        quantity = quantity + excluded.quantity, updated_at = excluded.updated_at`)
      .run(newId('soa'), workspaceId, line.id, position.location_id, quantity, now, now);
    allocations.push({ locationId: position.location_id, locationName: position.location_name, quantity });
    needed -= quantity;
  }
  return { allocated: remaining - needed, backordered: needed, allocations };
}

function totalsForOrder(db, orderId) {
  return db.prepare(`SELECT COALESCE(SUM(sol.quantity_ordered), 0) AS ordered,
      COALESCE(SUM(sol.quantity_fulfilled), 0) AS fulfilled,
      COALESCE(SUM((SELECT SUM(soa.quantity) FROM sales_order_allocations soa
                    WHERE soa.sales_order_line_id = sol.id)), 0) AS allocated
    FROM sales_order_lines sol WHERE sol.sales_order_id = ?`).get(orderId);
}

function currentStatus(db, orderId, cancelled = false) {
  if (cancelled) return 'CANCELLED';
  const t = totalsForOrder(db, orderId);
  if (t.fulfilled >= t.ordered) return 'FULFILLED';
  if (t.fulfilled > 0) return 'PARTIALLY_FULFILLED';
  if (t.allocated < t.ordered - t.fulfilled) return 'BACKORDERED';
  return 'CONFIRMED';
}

function confirm(db, ctx, orderId, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (order.status !== 'DRAFT') return { order: getOrder(db, ctx.workspaceId, orderId), event: null, replayed: true };
    const missingPrices = db.prepare(`SELECT sol.sku_id, i.name AS item_name, s.variant_label
      FROM sales_order_lines sol JOIN skus s ON s.id = sol.sku_id JOIN items i ON i.id = s.item_id
      WHERE sol.sales_order_id = ? AND sol.workspace_id = ? AND sol.unit_price_minor IS NULL`)
      .all(orderId, ctx.workspaceId);
    if (missingPrices.length) {
      const names = missingPrices.map((line) => line.variant_label
        ? `${line.item_name} / ${line.variant_label}` : line.item_name);
      throw new ValidationError(`${names.join(', ')} ${names.length === 1 ? 'does' : 'do'} not have a selling price. Set the price before confirming this customer order.`, {
        reason: 'missing_sales_price', skuIds: missingPrices.map((line) => line.sku_id),
      });
    }
    const allocations = [];
    for (const line of orderLineRows(db, ctx.workspaceId, orderId)) {
      allocations.push({ lineId: line.id, skuId: line.sku_id,
        ...allocateLine(db, ctx.workspaceId, line, order.fulfillment_location_id) });
    }
    const status = currentStatus(db, orderId);
    const now = nowIso();
    db.prepare(`UPDATE sales_orders SET status = ?, confirmed_by_user_id = ?, confirmed_at = ?,
      updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(status, ctx.actorId, now, now, orderId, ctx.workspaceId);
    const event = recordEvent(db, ctx, orderId, 'CONFIRMED', { allocations, status },
      options.idempotencyKey || `sales-order-confirmed:${orderId}`);
    return { order: getOrder(db, ctx.workspaceId, orderId), event, replayed: false };
  });
  if (outcome.event) react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CONFIRMED, outcome.order);
  return outcome.order;
}

/**
 * Commits stock that has become available since the order was confirmed.
 *
 * Allocation ran once, at confirmation, and never again. So a delivery could
 * arrive against the exact shortfall an order was waiting for and the order
 * could not take it: sixty units in the store room, an order short sixteen, and
 * no way to put the two together. Needs you sent the reader to that page, where
 * the only options were to add more demand or cancel.
 *
 * Foundry does not do this by itself, and that is deliberate rather than
 * missing. Committing stock to one customer takes it away from the next person
 * who asks, which is a commercial decision about who gets served — so it stays
 * a decision somebody makes, with the shortfall and the free stock both on
 * screen before they make it.
 *
 * The allocation itself is the same primitive confirmation uses. It counts what
 * is already allocated and already shipped, so it can only ever close the gap
 * and never over-commit, and it does not touch on-hand: reserving is a promise
 * about stock, not a movement of it.
 */
function allocateAvailable(db, ctx, orderId, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (order.status === 'DRAFT') {
      throw new ValidationError('Confirm the order first. Foundry holds stock for a customer once the order is committed.');
    }
    if (['CANCELLED', 'FULFILLED'].includes(order.status)) {
      throw new ValidationError('That sales order is already closed.');
    }

    const before = totalsForOrder(db, orderId);
    const shortfall = Number(before.ordered) - Number(before.fulfilled) - Number(before.allocated);
    if (shortfall <= 0) {
      return { order: getOrder(db, ctx.workspaceId, orderId), event: null, committed: 0, replayed: true };
    }

    const allocations = [];
    for (const line of orderLineRows(db, ctx.workspaceId, orderId)) {
      allocations.push({ lineId: line.id, skuId: line.sku_id,
        ...allocateLine(db, ctx.workspaceId, line, order.fulfillment_location_id) });
    }
    const committed = allocations.reduce((total, entry) => total + Number(entry.allocated || 0), 0);
    if (!committed) {
      return { order: getOrder(db, ctx.workspaceId, orderId), event: null, committed: 0, replayed: false };
    }

    const status = currentStatus(db, orderId);
    const now = nowIso();
    db.prepare(`UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND workspace_id = ?`)
      .run(status, now, orderId, ctx.workspaceId);
    const event = recordEvent(db, ctx, orderId, 'ALLOCATED_FROM_STOCK', { allocations, committed, status },
      options.idempotencyKey || `sales-order-allocated:${orderId}:${now}`);
    return { order: getOrder(db, ctx.workspaceId, orderId), event, committed, replayed: false };
  });
  if (outcome.event) {
    react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CONFIRMED, outcome.order);
  }
  return outcome;
}

function addLine(db, ctx, orderId, input, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (['FULFILLED', 'CANCELLED'].includes(order.status)) throw new ValidationError('That sales order is already closed.');
    const sku = ensureSku(db, ctx.workspaceId, input.skuId);
    const quantity = positive(input.quantity);
    const existing = db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id = ? AND sku_id = ?')
      .get(orderId, sku.id);
    const now = nowIso();
    let line;
    if (existing) {
      db.prepare('UPDATE sales_order_lines SET quantity_ordered = quantity_ordered + ?, updated_at = ? WHERE id = ?')
        .run(quantity, now, existing.id);
      line = db.prepare('SELECT * FROM sales_order_lines WHERE id = ?').get(existing.id);
    } else {
      const id = newId('sol');
      const suppliedPrice = input.unitPriceMinor === null || input.unitPriceMinor === undefined
        ? null : Number(input.unitPriceMinor);
      if (suppliedPrice !== null && (!Number.isSafeInteger(suppliedPrice) || suppliedPrice < 0)) {
        throw new ValidationError('The order-line price must be a non-negative whole number of minor currency units.');
      }
      const price = suppliedPrice === null
        ? prices.currentForSku(db, ctx.workspaceId, sku.id)
        : { isSet: true, amount_minor: suppliedPrice, id: null, currency: order.currency };
      if (price.isSet && price.currency !== order.currency) {
        throw new ValidationError(`${sku.item_name} is priced in ${price.currency}, but this order uses ${order.currency}.`);
      }
      if (!price.isSet && order.status !== 'DRAFT') {
        throw new ValidationError(`${sku.item_name} does not have a selling price. Set a price before adding it to a confirmed customer order.`, {
          reason: 'missing_sales_price', skuIds: [sku.id],
        });
      }
      db.prepare(`INSERT INTO sales_order_lines
        (id, workspace_id, sales_order_id, sku_id, quantity_ordered, quantity_fulfilled,
         unit_price_minor, price_source_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(id, ctx.workspaceId, orderId, sku.id, quantity,
          price.isSet ? price.amount_minor : null, price.isSet ? price.id : null, now, now);
      line = db.prepare('SELECT * FROM sales_order_lines WHERE id = ?').get(id);
    }
    const allocation = order.status === 'DRAFT' ? null : allocateLine(db, ctx.workspaceId, line, order.fulfillment_location_id);
    const status = order.status === 'DRAFT' ? 'DRAFT' : currentStatus(db, orderId);
    db.prepare('UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(status, now, orderId);
    const event = recordEvent(db, ctx, orderId, 'CHANGED', { skuId: sku.id, quantityAdded: quantity, allocation, status },
      options.idempotencyKey);
    return { order: getOrder(db, ctx.workspaceId, orderId), event };
  });
  if (outcome.order.status !== 'DRAFT') react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CHANGED, outcome.order);
  return outcome.order;
}

/**
 * Set the absolute ordered quantity for an existing line.
 *
 * Commerce providers normally send their current order state rather than a
 * delta. This changes only the unfulfilled remainder, releases commitments
 * deterministically when quantity falls, and refuses to erase shipped units.
 */
function setLineQuantity(db, ctx, orderId, lineId, quantity, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (['FULFILLED', 'CANCELLED'].includes(order.status)) throw new ValidationError('That sales order is already closed.');
    const eventKey = options.idempotencyKey || null;
    if (eventKey) {
      const prior = db.prepare('SELECT 1 FROM sales_order_events WHERE workspace_id = ? AND idempotency_key = ?')
        .get(ctx.workspaceId, eventKey);
      if (prior) return { order: getOrder(db, ctx.workspaceId, orderId), event: null };
    }
    const line = db.prepare('SELECT * FROM sales_order_lines WHERE id = ? AND sales_order_id = ? AND workspace_id = ?')
      .get(lineId, orderId, ctx.workspaceId);
    if (!line) throw new NotFoundError('That product is not on this sales order.');
    const target = Number(quantity);
    if (!Number.isInteger(target) || target < 0) throw new ValidationError('Ordered quantity must be a whole number of zero or more.');
    if (target < Number(line.quantity_fulfilled)) {
      throw new ValidationError('An external order update cannot remove units that Foundry has already fulfilled.');
    }
    const current = Number(line.quantity_ordered);
    if (target === current) return { order: getOrder(db, ctx.workspaceId, orderId), event: null };
    if (target > current) {
      const changed = addLine(db, ctx, orderId, { skuId: line.sku_id, quantity: target - current },
        { idempotencyKey: eventKey });
      return { order: changed, event: null };
    }

    let toRelease = current - target;
    const allocations = db.prepare(`SELECT * FROM sales_order_allocations WHERE workspace_id = ?
      AND sales_order_line_id = ? ORDER BY created_at DESC, id DESC`).all(ctx.workspaceId, lineId);
    let released = 0;
    for (const allocation of allocations) {
      if (!toRelease) break;
      const amount = Math.min(toRelease, Number(allocation.quantity));
      const left = Number(allocation.quantity) - amount;
      if (left) db.prepare('UPDATE sales_order_allocations SET quantity = ?, updated_at = ? WHERE id = ?')
        .run(left, nowIso(), allocation.id);
      else db.prepare('DELETE FROM sales_order_allocations WHERE id = ?').run(allocation.id);
      toRelease -= amount;
      released += amount;
    }

    const now = nowIso();
    if (target === 0 && Number(line.quantity_fulfilled) === 0) {
      const other = db.prepare('SELECT 1 FROM sales_order_lines WHERE sales_order_id = ? AND id <> ? LIMIT 1')
        .get(orderId, lineId);
      if (!other) throw new ValidationError('Cancel the whole sales order instead of removing its only line.');
      db.prepare('DELETE FROM sales_order_lines WHERE id = ?').run(lineId);
    } else {
      db.prepare('UPDATE sales_order_lines SET quantity_ordered = ?, updated_at = ? WHERE id = ?')
        .run(target, now, lineId);
    }
    const status = order.status === 'DRAFT' ? 'DRAFT' : currentStatus(db, orderId);
    db.prepare('UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(status, now, orderId);
    const event = recordEvent(db, ctx, orderId, 'CHANGED', {
      lineId, previousQuantity: current, quantityOrdered: target, released, status,
    }, eventKey);
    return { order: getOrder(db, ctx.workspaceId, orderId), event };
  });
  if (outcome.event && outcome.order.status !== 'DRAFT') {
    react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CHANGED, outcome.order);
  }
  return outcome.order;
}

function fulfill(db, ctx, orderId, input = {}, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (!OPEN.includes(order.status)) throw new ValidationError('Confirm this sales order before fulfilling it.');
    const eventKey = options.idempotencyKey || `sales-order-fulfillment:${orderId}:${newId('run')}`;
    const prior = db.prepare('SELECT * FROM sales_order_events WHERE workspace_id = ? AND idempotency_key = ?')
      .get(ctx.workspaceId, eventKey);
    if (prior) return { order: getOrder(db, ctx.workspaceId, orderId), event: null, replayed: true };
    const requested = new Map((Array.isArray(input.lines) ? input.lines : [])
      .map((line) => [`${line.lineId}:${line.locationId}`, positive(line.quantity)]));
    const allocations = db.prepare(`SELECT soa.*, sol.sku_id, sol.quantity_fulfilled, sol.quantity_ordered,
        i.tracking_mode, l.name AS location_name
      FROM sales_order_allocations soa
      JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
      JOIN skus s ON s.id = sol.sku_id JOIN items i ON i.id = s.item_id
      JOIN locations l ON l.id = soa.location_id
      WHERE sol.sales_order_id = ? AND soa.workspace_id = ? ORDER BY soa.created_at, soa.id`)
      .all(orderId, ctx.workspaceId);
    if (!allocations.length) throw new ValidationError('No stock is currently allocated to this order.');
    const fulfilled = [];
    for (const allocation of allocations) {
      const key = `${allocation.sales_order_line_id}:${allocation.location_id}`;
      const quantity = requested.size ? Number(requested.get(key) || 0) : Number(allocation.quantity);
      if (!quantity) continue;
      if (quantity > Number(allocation.quantity)) throw new ValidationError('You cannot fulfill more than the quantity allocated at that location.');
      if (allocation.tracking_mode !== 'quantity') {
        throw new ValidationError('Choose the exact serial numbers or lots on the inventory screen before fulfilling this tracked item.');
      }
      const result = inventory.issue(db, ctx, {
        skuId: allocation.sku_id, locationId: allocation.location_id, quantity,
        reasonCode: 'sold', reference: order.order_number,
        notes: `Fulfilled ${order.order_number}`,
      });
      const left = Number(allocation.quantity) - quantity;
      if (left > 0) db.prepare('UPDATE sales_order_allocations SET quantity = ?, updated_at = ? WHERE id = ?')
        .run(left, nowIso(), allocation.id);
      else db.prepare('DELETE FROM sales_order_allocations WHERE id = ?').run(allocation.id);
      db.prepare('UPDATE sales_order_lines SET quantity_fulfilled = quantity_fulfilled + ?, updated_at = ? WHERE id = ?')
        .run(quantity, nowIso(), allocation.sales_order_line_id);
      fulfilled.push({ lineId: allocation.sales_order_line_id, skuId: allocation.sku_id,
        locationId: allocation.location_id, locationName: allocation.location_name, quantity,
        // The inventory engine returns immutable movement IDs directly. Keep
        // them on the sales event so downstream accounting and audit consumers
        // can trace COGS to the exact physical issue without guessing by time.
        movementIds: result.movementIds || [] });
    }
    if (!fulfilled.length) throw new ValidationError('Choose at least one allocated quantity to fulfill.');
    const status = currentStatus(db, orderId);
    const now = nowIso();
    db.prepare(`UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1,
      completed_at = CASE WHEN ? = 'FULFILLED' THEN ? ELSE completed_at END WHERE id = ?`)
      .run(status, now, status, now, orderId);
    const event = recordEvent(db, ctx, orderId, status === 'FULFILLED' ? 'FULFILLED' : 'PARTIALLY_FULFILLED',
      { fulfilled, status }, eventKey);
    return { order: getOrder(db, ctx.workspaceId, orderId), event };
  });
  if (outcome.event) react(db, ctx.workspaceId, outcome.event,
    outcome.order.status === 'FULFILLED' ? managerEvents.TYPES.SALES_ORDER_FULFILLED : managerEvents.TYPES.SALES_ORDER_PARTIALLY_FULFILLED,
    outcome.order);
  return outcome.order;
}

function cancel(db, ctx, orderId, reason = null, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (order.status === 'CANCELLED') return { order: getOrder(db, ctx.workspaceId, orderId), event: null };
    if (order.status === 'FULFILLED') throw new ValidationError('A fulfilled sales order cannot be cancelled.');
    const released = db.prepare(`SELECT COALESCE(SUM(soa.quantity), 0) AS n
      FROM sales_order_allocations soa JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
      WHERE sol.sales_order_id = ?`).get(orderId).n;
    db.prepare(`DELETE FROM sales_order_allocations WHERE sales_order_line_id IN
      (SELECT id FROM sales_order_lines WHERE sales_order_id = ?)`).run(orderId);
    const now = nowIso();
    db.prepare(`UPDATE sales_orders SET status = 'CANCELLED', cancelled_by_user_id = ?, cancelled_at = ?,
      cancel_reason = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?`)
      .run(ctx.actorId, now, trimOrNull(reason), now, orderId, ctx.workspaceId);
    const event = recordEvent(db, ctx, orderId, 'CANCELLED', { released, reason: trimOrNull(reason) },
      options.idempotencyKey || `sales-order-cancelled:${orderId}`);
    return { order: getOrder(db, ctx.workspaceId, orderId), event };
  });
  if (outcome.event) react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CANCELLED, outcome.order);
  return outcome.order;
}

function cancelLine(db, ctx, orderId, lineId, reason = null, options = {}) {
  const outcome = inTransaction(db, () => {
    const order = requireOrderRow(db, ctx.workspaceId, orderId);
    if (['FULFILLED', 'CANCELLED'].includes(order.status)) throw new ValidationError('That sales order is already closed.');
    const line = db.prepare('SELECT * FROM sales_order_lines WHERE id = ? AND sales_order_id = ? AND workspace_id = ?')
      .get(lineId, orderId, ctx.workspaceId);
    if (!line) throw new NotFoundError('That product is not on this sales order.');
    const released = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM sales_order_allocations WHERE sales_order_line_id = ?')
      .get(lineId).n;
    db.prepare('DELETE FROM sales_order_allocations WHERE sales_order_line_id = ?').run(lineId);
    if (Number(line.quantity_fulfilled) > 0) {
      db.prepare('UPDATE sales_order_lines SET quantity_ordered = quantity_fulfilled, updated_at = ? WHERE id = ?')
        .run(nowIso(), lineId);
    } else db.prepare('DELETE FROM sales_order_lines WHERE id = ?').run(lineId);
    if (!db.prepare('SELECT 1 FROM sales_order_lines WHERE sales_order_id = ? LIMIT 1').get(orderId)) {
      throw new ValidationError('Cancel the whole sales order instead of removing its only line.');
    }
    const status = order.status === 'DRAFT' ? 'DRAFT' : currentStatus(db, orderId);
    db.prepare('UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?')
      .run(status, nowIso(), orderId);
    const event = recordEvent(db, ctx, orderId, 'CHANGED', { lineId, cancelledRemainder: true, released, reason },
      options.idempotencyKey);
    return { order: getOrder(db, ctx.workspaceId, orderId), event };
  });
  if (outcome.order.status !== 'DRAFT') react(db, ctx.workspaceId, outcome.event, managerEvents.TYPES.SALES_ORDER_CHANGED, outcome.order);
  return outcome.order;
}

function requireOrderRow(db, workspaceId, orderId) {
  const row = db.prepare('SELECT * FROM sales_orders WHERE id = ? AND workspace_id = ?').get(orderId, workspaceId);
  if (!row) throw new NotFoundError('That sales order is not in this inventory.');
  return row;
}

function orderLineRows(db, workspaceId, orderId) {
  return db.prepare('SELECT * FROM sales_order_lines WHERE sales_order_id = ? AND workspace_id = ? ORDER BY created_at, id')
    .all(orderId, workspaceId);
}

function getOrder(db, workspaceId, orderId) {
  const row = requireOrderRow(db, workspaceId, orderId);
  const customer = requireCustomer(db, workspaceId, row.customer_id);
  const lines = db.prepare(`SELECT sol.*, s.code, s.variant_label, i.id AS item_id, i.name AS item_name, i.unit_label,
      COALESCE((SELECT SUM(soa.quantity) FROM sales_order_allocations soa WHERE soa.sales_order_line_id = sol.id), 0) AS allocated
    FROM sales_order_lines sol JOIN skus s ON s.id = sol.sku_id JOIN items i ON i.id = s.item_id
    WHERE sol.sales_order_id = ? AND sol.workspace_id = ? ORDER BY sol.created_at, sol.id`).all(orderId, workspaceId)
    .map((line) => ({ ...line, backordered: ['CANCELLED', 'FULFILLED'].includes(row.status)
      ? 0 : Math.max(0, Number(line.quantity_ordered) - Number(line.quantity_fulfilled) - Number(line.allocated)),
      lineTotalMinor: line.unit_price_minor === null ? null : Number(line.unit_price_minor) * Number(line.quantity_ordered),
      displayName: line.variant_label ? `${line.item_name} / ${line.variant_label}` : line.item_name,
      allocations: db.prepare(`SELECT soa.*, l.name AS location_name FROM sales_order_allocations soa
        JOIN locations l ON l.id = soa.location_id WHERE soa.sales_order_line_id = ? ORDER BY l.name`).all(line.id) }));
  const totals = lines.reduce((t, line) => ({ ordered: t.ordered + Number(line.quantity_ordered),
    fulfilled: t.fulfilled + Number(line.quantity_fulfilled), allocated: t.allocated + Number(line.allocated),
    backordered: t.backordered + Number(line.backordered) }), { ordered: 0, fulfilled: 0, allocated: 0, backordered: 0 });
  const subtotalMinor = lines.reduce((sum, line) => sum + (line.lineTotalMinor || 0), 0);
  const pricing = { subtotalMinor,
    missingPriceLines: lines.filter((line) => line.unit_price_minor === null).length,
    discountMinor: Math.min(Number(row.discount_minor || 0), subtotalMinor),
    taxMinor: Number(row.tax_minor || 0) };
  pricing.totalMinor = pricing.subtotalMinor - pricing.discountMinor + pricing.taxMinor;
  const events = db.prepare(`SELECT soe.*, u.name AS actor_name FROM sales_order_events soe
    LEFT JOIN users u ON u.id = soe.actor_user_id WHERE soe.sales_order_id = ? AND soe.workspace_id = ?
    ORDER BY soe.created_at, soe.rowid`).all(orderId, workspaceId).map((event) => ({ ...event, detail: json(event.detail) }));
  return { ...row, customer, lines, totals, pricing, events,
    fulfillmentLocation: row.fulfillment_location_id
      ? db.prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ?').get(row.fulfillment_location_id, workspaceId) : null };
}

function listOrders(db, workspaceId, { status = null, customerId = null, limit = 100 } = {}) {
  const where = ['so.workspace_id = ?'];
  const params = [workspaceId];
  if (status) { where.push('so.status = ?'); params.push(status); }
  if (customerId) { where.push('so.customer_id = ?'); params.push(customerId); }
  return db.prepare(`SELECT so.id FROM sales_orders so WHERE ${where.join(' AND ')}
    ORDER BY CASE WHEN so.needed_by IS NULL THEN 1 ELSE 0 END, so.needed_by, so.created_at DESC LIMIT ?`)
    .all(...params, limit).map((row) => getOrder(db, workspaceId, row.id));
}

/**
 * Instant POS checkouts are completed sales, not unfulfilled customer orders.
 * They still belong on the Sales screen. The connector event and its guarded
 * movement remain the audit/source-of-truth records; this read model groups
 * their line events into the provider sale the owner recognizes.
 */
function listCompletedSales(db, workspaceId, { limit = 100 } = {}) {
  const events = db.prepare(`SELECT cfe.*, wc.display_name AS provider_name, wc.provider_type
    FROM connector_feed_events cfe
    JOIN workspace_connectors wc ON wc.id = cfe.connector_id AND wc.workspace_id = cfe.workspace_id
    WHERE cfe.workspace_id = ? AND cfe.event_type = 'sale.completed' AND cfe.status = 'COMPLETED'
    ORDER BY cfe.occurred_at DESC, cfe.received_at DESC LIMIT ?`).all(workspaceId, limit * 10);
  const movementById = db.prepare(`SELECT m.*, s.code, s.variant_label, i.name AS item_name, l.name AS location_name
    FROM movements m JOIN skus s ON s.id = m.sku_id JOIN items i ON i.id = s.item_id
    JOIN locations l ON l.id = m.location_id WHERE m.workspace_id = ? AND m.id = ?`);
  const priceAt = db.prepare(`SELECT amount_minor, currency FROM sku_prices
    WHERE workspace_id = ? AND sku_id = ? AND created_at <= ?
    ORDER BY created_at DESC, rowid DESC LIMIT 1`);
  const groups = new Map();
  for (const event of events) {
    const payload = json(event.normalized_payload, {});
    const data = payload.data || {};
    const key = `${event.connector_id}:${event.aggregate_key || event.external_event_id}`;
    let sale = groups.get(key);
    if (!sale) {
      sale = { id: key, providerName: event.provider_name, providerType: event.provider_type,
        reference: trimOrNull(data.reference) || event.aggregate_key || event.external_event_id,
        occurredAt: event.occurred_at || event.received_at, totalUnits: 0, totalMinor: 0,
        currency: trimOrNull(data.currency) || null, priceComplete: true, lines: [], locations: new Set() };
      groups.set(key, sale);
    }
    for (const movementId of json(event.movement_ids, [])) {
      const movement = movementById.get(workspaceId, movementId);
      if (!movement || Number(movement.quantity_delta) >= 0) continue;
      const quantity = Math.abs(Number(movement.quantity_delta));
      const historicalPrice = priceAt.get(workspaceId, movement.sku_id, sale.occurredAt);
      const suppliedPrice = Number(data.unitPriceMinor);
      const unitPriceMinor = Number.isSafeInteger(suppliedPrice) && suppliedPrice >= 0
        ? suppliedPrice : historicalPrice?.amount_minor;
      const currency = trimOrNull(data.currency) || historicalPrice?.currency || sale.currency || 'USD';
      sale.totalUnits += quantity;
      sale.currency = sale.currency || currency;
      if (unitPriceMinor === null || unitPriceMinor === undefined) sale.priceComplete = false;
      else sale.totalMinor += Number(unitPriceMinor) * quantity;
      sale.locations.add(movement.location_name);
      sale.lines.push({ skuId: movement.sku_id, code: movement.code,
        displayName: movement.variant_label ? `${movement.item_name} / ${movement.variant_label}` : movement.item_name,
        quantity, unitPriceMinor: unitPriceMinor ?? null, currency, movementId });
    }
  }
  return [...groups.values()].filter((sale) => sale.lines.length).slice(0, limit).map((sale) => ({
    ...sale, locations: [...sale.locations],
    itemSummary: sale.lines.length === 1 ? sale.lines[0].displayName
      : `${sale.lines[0].displayName} + ${sale.lines.length - 1} more`,
  }));
}

function waitingForStock(db, workspaceId) {
  return listOrders(db, workspaceId, { limit: 500 }).filter((order) => order.totals.backordered > 0 && OPEN.includes(order.status));
}

function commitmentsForSku(db, workspaceId, skuId) {
  return db.prepare(`SELECT so.id AS sales_order_id, so.order_number, so.needed_by, c.name AS customer_name,
      soa.location_id, l.name AS location_name, soa.quantity, sol.id AS line_id
    FROM sales_order_allocations soa
    JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
    JOIN sales_orders so ON so.id = sol.sales_order_id
    JOIN customers c ON c.id = so.customer_id JOIN locations l ON l.id = soa.location_id
    WHERE soa.workspace_id = ? AND sol.sku_id = ?
      AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
    ORDER BY so.needed_by, so.created_at`).all(workspaceId, skuId);
}

/**
 * Reconcile promises after physical stock changes.
 *
 * Earlier confirmed orders keep priority. If stock disappeared from a location,
 * the newest promises there are released first and then every waiting order is
 * offered the remaining network availability in confirmation order.
 */
function reconcileForSkus(db, ctx, skuIds, options = {}) {
  const wanted = [...new Set((skuIds || []).filter(Boolean))];
  if (!wanted.length) return [];
  return inTransaction(db, () => {
    const changedOrders = new Map();
    for (const skuId of wanted) {
      ensureSku(db, ctx.workspaceId, skuId);
      const positions = db.prepare(`SELECT l.id AS location_id, COALESCE(b.on_hand, 0) AS on_hand,
          COALESCE((SELECT SUM(soa.quantity) FROM sales_order_allocations soa
            JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
            JOIN sales_orders so ON so.id = sol.sales_order_id
            WHERE soa.location_id = l.id AND sol.sku_id = ?
              AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')), 0) AS committed
        FROM locations l LEFT JOIN balances b ON b.location_id = l.id AND b.sku_id = ?
        WHERE l.workspace_id = ? AND l.is_active = 1`).all(skuId, skuId, ctx.workspaceId);

      for (const position of positions) {
        let excess = Math.max(0, Number(position.committed) - Number(position.on_hand));
        if (!excess) continue;
        const newestFirst = db.prepare(`SELECT soa.*, sol.sales_order_id
          FROM sales_order_allocations soa
          JOIN sales_order_lines sol ON sol.id = soa.sales_order_line_id
          JOIN sales_orders so ON so.id = sol.sales_order_id
          WHERE soa.workspace_id = ? AND soa.location_id = ? AND sol.sku_id = ?
            AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
          ORDER BY so.confirmed_at DESC, so.created_at DESC, soa.created_at DESC, soa.id DESC`)
          .all(ctx.workspaceId, position.location_id, skuId);
        for (const allocation of newestFirst) {
          if (!excess) break;
          const released = Math.min(excess, Number(allocation.quantity));
          const left = Number(allocation.quantity) - released;
          if (left) db.prepare('UPDATE sales_order_allocations SET quantity = ?, updated_at = ? WHERE id = ?')
            .run(left, nowIso(), allocation.id);
          else db.prepare('DELETE FROM sales_order_allocations WHERE id = ?').run(allocation.id);
          excess -= released;
          changedOrders.set(allocation.sales_order_id, { released: true, allocated: false });
        }
      }

      const waitingLines = db.prepare(`SELECT sol.*, so.fulfillment_location_id, so.confirmed_at, so.created_at AS order_created_at
        FROM sales_order_lines sol JOIN sales_orders so ON so.id = sol.sales_order_id
        WHERE sol.workspace_id = ? AND sol.sku_id = ?
          AND so.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
        ORDER BY so.confirmed_at, so.created_at, sol.created_at, sol.id`).all(ctx.workspaceId, skuId);
      for (const line of waitingLines) {
        const allocation = allocateLine(db, ctx.workspaceId, line, line.fulfillment_location_id);
        if (allocation.allocated > 0) {
          const prior = changedOrders.get(line.sales_order_id) || { released: false, allocated: false };
          prior.allocated = true;
          changedOrders.set(line.sales_order_id, prior);
        }
      }
    }

    const results = [];
    for (const [orderId, change] of changedOrders) {
      const status = currentStatus(db, orderId);
      db.prepare('UPDATE sales_orders SET status = ?, updated_at = ?, version = version + 1 WHERE id = ? AND workspace_id = ?')
        .run(status, nowIso(), orderId, ctx.workspaceId);
      recordEvent(db, ctx, orderId, 'ALLOCATION_CHANGED', {
        triggerEventId: options.triggerEventId || null, released: change.released, allocated: change.allocated, status,
      }, options.triggerEventId ? `sales-allocation-reconciled:${options.triggerEventId}:${orderId}` : null);
      results.push(getOrder(db, ctx.workspaceId, orderId));
    }
    return results;
  });
}

function react(db, workspaceId, salesEvent, type, order) {
  const skuIds = [...new Set(order.lines.map((line) => line.sku_id))];
  reactions.publishAndReact(db, workspaceId, type, {
    salesOrderId: order.id, orderNumber: order.order_number, customerId: order.customer_id,
    skuIds, neededBy: order.needed_by, backordered: order.totals.backordered,
  }, { source: 'sales_order', sourceRecordType: 'sales_order_event', sourceRecordId: salesEvent.id,
    idempotencyKey: `${type}:sales-order-event:${salesEvent.id}` });
}

module.exports = {
  OPEN, createCustomer, listCustomers, getCustomer, updateCustomer, requireCustomer,
  createOrder, confirm, allocateAvailable, addLine, setLineQuantity, fulfill, cancel, cancelLine,
  getOrder, listOrders, listCompletedSales, waitingForStock, committedByPosition, availabilityForSku,
  commitmentsForSku, reconcileForSkus,
};
