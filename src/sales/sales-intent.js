'use strict';

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { ValidationError } = require('../domain/errors');
const resolver = require('../actions/resolver');
const sales = require('./sales-order-service');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['operation', 'customerText', 'orderText', 'itemText', 'variantText', 'locationText', 'quantity', 'neededBy', 'reason'],
  properties: {
    operation: { type: 'string', enum: ['create', 'add', 'fulfill', 'cancel_line', 'cancel_order', 'list_waiting'] },
    customerText: { type: 'string' }, orderText: { type: 'string' }, itemText: { type: 'string' },
    variantText: { type: 'string' }, locationText: { type: 'string' }, quantity: { type: 'integer', minimum: -1 },
    neededBy: { type: 'string' }, reason: { type: 'string' },
  },
};

const SYSTEM = `You translate ordinary-language customer-order requests into one typed Sales Order operation.
Use create when a customer has placed/committed an order. Use add for added quantity on an existing order.
Use fulfill when stock shipped/left for a named customer order. Use cancel_line when one product was cancelled,
cancel_order when the whole order was cancelled, and list_waiting for a read-only question about customer orders
waiting for stock. Preserve customer, order, product, variant, location, quantity and requested date exactly.
neededBy must be YYYY-MM-DD when an exact date can be resolved from today's date; otherwise empty.
Never invent missing records or quantities. Use -1 when quantity was not stated. Return only the schema.`;

function snapshot(db, workspaceId) {
  return {
    today: new Date().toISOString().slice(0, 10),
    customers: sales.listCustomers(db, workspaceId).map((row) => ({ name: row.name, company: row.company })),
    orders: sales.listOrders(db, workspaceId, { limit: 100 }).map((order) => ({
      orderNumber: order.order_number, customer: order.customer.name, status: order.status,
      lines: order.lines.map((line) => ({ product: line.displayName, code: line.code, remaining: line.quantity_ordered - line.quantity_fulfilled })),
    })),
    products: db.prepare(`SELECT i.name, s.variant_label AS variant, s.code FROM skus s JOIN items i ON i.id = s.item_id
      WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1 ORDER BY i.name, s.position LIMIT 300`).all(workspaceId),
    locations: db.prepare('SELECT name FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name').all(workspaceId),
  };
}

function fallback(message) {
  const text = String(message || '').trim();
  const quantity = Number((text.match(/\b(\d+)\b/) || [])[1] || -1);
  if (/waiting for stock|backorder/i.test(text) && /what|which|show|customer order/i.test(text)) {
    return { operation: 'list_waiting', customerText: '', orderText: '', itemText: '', variantText: '', locationText: '', quantity: -1, neededBy: '', reason: 'Read waiting customer orders.' };
  }
  const cancel = /\bcancel(?:led|ed)?\b/i.test(text);
  const fulfill = /\b(ship|shipped|fulfill|fulfilled|dispatch|dispatched)\b/i.test(text);
  const add = /\badd(?:ed)?\b.*\b(?:to|onto)\b/i.test(text);
  const create = /\b(?:ordered|placed an order|customer order)\b/i.test(text);
  return {
    operation: cancel ? (/whole|entire|order\s+(?:was\s+)?cancel/i.test(text) ? 'cancel_order' : 'cancel_line')
      : fulfill ? 'fulfill' : add ? 'add' : create ? 'create' : 'list_waiting',
    customerText: '', orderText: (text.match(/\bSO-\d+\b/i) || [''])[0], itemText: text, variantText: '',
    locationText: (text.match(/\bfrom\s+(.+?)(?:\.|$)/i) || [,''])[1], quantity, neededBy: '', reason: 'Deterministic fallback.',
  };
}

async function interpret(db, ctx, message, options = {}) {
  let data;
  try {
    const provider = options.provider || createProviderForTier('fast');
    const response = await provider.complete({ system: SYSTEM,
      prompt: `Workspace records:\n${JSON.stringify(snapshot(db, ctx.workspaceId))}\n\nOwner request:\n${message}`,
      schema: SCHEMA, schemaName: 'sales_order_intent' });
    const result = validate(toWireSchema(SCHEMA), response.data, { key: 'sales-order-intent-wire' });
    if (!result.ok) throw new Error('invalid sales intent');
    data = result.data;
  } catch { data = fallback(message); }
  return { ...data, statedAs: message };
}

function findOrder(db, workspaceId, intent) {
  const orders = sales.listOrders(db, workspaceId, { limit: 200 });
  const orderText = String(intent.orderText || '').trim().toLowerCase();
  if (orderText) {
    const exact = orders.filter((order) => order.order_number.toLowerCase() === orderText);
    if (exact.length === 1) return exact[0];
  }
  const customerText = String(intent.customerText || '').trim().toLowerCase();
  const candidates = orders.filter((order) => sales.OPEN.includes(order.status) || order.status === 'DRAFT')
    .filter((order) => !customerText || order.customer.name.toLowerCase() === customerText
      || String(order.customer.company || '').toLowerCase() === customerText);
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new ValidationError('Foundry could not find an open sales order matching that customer or order number.');
  throw new ValidationError('More than one open sales order matches. Name the order number so Foundry does not change the wrong one.');
}

function findSku(db, workspaceId, intent) {
  const result = resolver.resolveSku(db, workspaceId, intent.itemText, intent.variantText, { instruction: intent.statedAs });
  if (!result.ok) throw new ValidationError(result.question || result.message || 'Which product or variant is this for?');
  return result.value;
}

function apply(db, ctx, intent, options = {}) {
  if (intent.operation === 'list_waiting') return { kind: 'list', orders: sales.waitingForStock(db, ctx.workspaceId) };
  if (intent.operation === 'create') {
    if (!intent.customerText) throw new ValidationError('Which customer placed this order?');
    if (intent.quantity < 1) throw new ValidationError('How many units did the customer order?');
    const sku = findSku(db, ctx.workspaceId, intent);
    const draft = sales.createOrder(db, ctx, { customerName: intent.customerText, neededBy: intent.neededBy || null,
      lines: [{ skuId: sku.id, quantity: intent.quantity }], notes: intent.statedAs });
    return { kind: 'created', order: sales.confirm(db, ctx, draft.id, { idempotencyKey: `tell-confirm:${draft.id}` }) };
  }
  const order = findOrder(db, ctx.workspaceId, intent);
  if (intent.operation === 'cancel_order') return { kind: 'cancelled', order: sales.cancel(db, ctx, order.id, intent.reason) };
  const sku = findSku(db, ctx.workspaceId, intent);
  const line = order.lines.find((entry) => entry.sku_id === sku.id);
  if (intent.operation === 'add') {
    if (intent.quantity < 1) throw new ValidationError('How many units should Foundry add?');
    return { kind: 'changed', order: sales.addLine(db, ctx, order.id, { skuId: sku.id, quantity: intent.quantity }) };
  }
  if (!line) throw new ValidationError(`${sku.item_name || 'That product'} is not on ${order.order_number}.`);
  if (intent.operation === 'cancel_line') return { kind: 'changed', order: sales.cancelLine(db, ctx, order.id, line.id, intent.reason) };
  if (intent.operation === 'fulfill') {
    if (intent.quantity < 1) throw new ValidationError('How many units shipped?');
    let allocation = line.allocations.find((entry) => !intent.locationText
      || String(entry.location_name).toLowerCase() === String(intent.locationText).trim().toLowerCase());
    if (!allocation && intent.locationText) {
      const location = resolver.resolveLocation(db, ctx.workspaceId, intent.locationText);
      if (location.ok) allocation = line.allocations.find((entry) => entry.location_id === location.value.id);
    }
    if (!allocation) throw new ValidationError('That order has no allocated stock at the stated location. Review the order allocation first.');
    return { kind: 'fulfilled', order: sales.fulfill(db, ctx, order.id, { lines: [{
      lineId: line.id, locationId: allocation.location_id, quantity: intent.quantity,
    }] }, options) };
  }
  throw new ValidationError('Foundry could not safely determine the requested sales-order change.');
}

module.exports = { SCHEMA, SYSTEM, snapshot, fallback, interpret, apply };
