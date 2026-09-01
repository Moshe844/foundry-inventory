'use strict';

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { ValidationError } = require('../domain/errors');
const resolver = require('../actions/resolver');
const sales = require('./sales-order-service');
const prices = require('../pricing/price-service');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['operation', 'customerText', 'orderText', 'itemText', 'variantText', 'locationText', 'quantity', 'neededBy', 'reason'],
  properties: {
    operation: { type: 'string', enum: ['create', 'add', 'fulfill', 'complete_order', 'cancel_line', 'cancel_order', 'list_waiting'] },
    customerText: { type: 'string' }, orderText: { type: 'string' }, itemText: { type: 'string' },
    variantText: { type: 'string' }, locationText: { type: 'string' }, quantity: { type: 'integer', minimum: -1 },
    neededBy: { type: 'string' }, reason: { type: 'string' },
  },
};

const SYSTEM = `You translate ordinary-language customer-order requests into one typed Sales Order operation.
Use create when a customer has placed/committed an order. Use add for added quantity on an existing order.
Use fulfill when a stated quantity of stock shipped/left for a named customer order. Use complete_order when the
owner explicitly asks to complete, finish, or ship the entire named order and did not state one line quantity.
Use cancel_line when one product was cancelled,
cancel_order when the whole order was cancelled, and list_waiting for a read-only question about customer orders
waiting for stock. Preserve customer, order, product, variant, location, quantity and requested date exactly.
neededBy must be YYYY-MM-DD when an exact date can be resolved from today's date; otherwise empty.
Never invent missing records or quantities. Use -1 when quantity was not stated. Return only the schema.`;

function asksToCompleteWholeOrder(message) {
  const text = String(message || '').trim();
  return /\b(?:complete|finish|fulfill|ship)\b[^.?!]*\b(?:(?:sales|customer)\s+)?order\b/i.test(text)
    || /\b(?:(?:sales|customer)\s+)?order\b[^.?!]*\b(?:complete|finished|fulfilled|shipped)\b/i.test(text);
}

/**
 * Whole-order completion is both consequential and common enough that it must
 * not depend on an AI round trip. Ground the customer/order against this
 * workspace, then let the normal deterministic Sales Order engine act.
 */
function groundedWholeOrderCompletion(db, workspaceId, message) {
  if (!asksToCompleteWholeOrder(message)) return null;
  const text = String(message || '');
  const orderNumber = (text.match(/\bSO-\d+\b/i) || [''])[0];
  if (orderNumber) {
    return { operation: 'complete_order', customerText: '', orderText: orderNumber,
      itemText: '', variantText: '', locationText: '', quantity: -1, neededBy: '',
      reason: 'The owner explicitly asked to complete the whole sales order.' };
  }
  const normalized = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const matches = sales.listOrders(db, workspaceId, { limit: 200 })
    .filter((order) => sales.OPEN.includes(order.status) || order.status === 'DRAFT')
    .filter((order) => [order.customer.name, order.customer.company].filter(Boolean).some((name) => {
      const candidate = String(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return candidate && normalized.includes(` ${candidate} `);
    }));
  const customers = [...new Set(matches.map((order) => order.customer.name))];
  return { operation: 'complete_order', customerText: customers.length === 1 ? customers[0] : '',
    orderText: '', itemText: '', variantText: '', locationText: '', quantity: -1, neededBy: '',
    reason: 'The owner explicitly asked to complete the whole sales order.' };
}

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
  const completeOrder = asksToCompleteWholeOrder(text);
  const fulfill = /\b(ship|shipped|fulfill|fulfilled|dispatch|dispatched)\b/i.test(text);
  const add = /\badd(?:ed)?\b.*\b(?:to|onto)\b/i.test(text);
  const create = /\b(?:ordered|placed an order|customer order)\b/i.test(text);
  return {
    operation: cancel ? (/whole|entire|order\s+(?:was\s+)?cancel/i.test(text) ? 'cancel_order' : 'cancel_line')
      : completeOrder ? 'complete_order' : fulfill ? 'fulfill' : add ? 'add' : create ? 'create' : 'list_waiting',
    customerText: '', orderText: (text.match(/\bSO-\d+\b/i) || [''])[0], itemText: completeOrder ? '' : text, variantText: '',
    locationText: (text.match(/\bfrom\s+(.+?)(?:\.|$)/i) || [,''])[1], quantity, neededBy: '', reason: 'Deterministic fallback.',
  };
}

async function interpret(db, ctx, message, options = {}) {
  const grounded = groundedWholeOrderCompletion(db, ctx.workspaceId, message);
  if (grounded) return { ...grounded, statedAs: message };
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
  if (intent.resolvedSkuId) {
    try { return { ok: true, value: prices.requireSku(db, workspaceId, intent.resolvedSkuId) }; }
    catch { /* Re-resolve below so a stale continuation cannot target a removed SKU. */ }
  }
  const result = resolver.resolveSku(db, workspaceId, intent.itemText, intent.variantText, { instruction: intent.statedAs });
  if (!result.ok) {
    return {
      ok: false,
      question: result.question || result.message || 'Which product or variant is this for?',
      choices: (result.clarification && result.clarification.choices) || null,
    };
  }
  return result;
}

function question(intent, field, message, extra = {}) {
  return {
    kind: 'question',
    question: message,
    choices: extra.choices || null,
    continuation: { intent: { ...intent }, field, skuId: extra.skuId || null },
  };
}

function priceForOrder(db, ctx, intent, sku) {
  if (Number.isSafeInteger(Number(intent.unitPriceMinor)) && Number(intent.unitPriceMinor) >= 0) {
    return Number(intent.unitPriceMinor);
  }
  const current = prices.currentForSku(db, ctx.workspaceId, sku.id);
  if (current.isSet) return current.amount_minor;
  return null;
}

function apply(db, ctx, intent, options = {}) {
  if (intent.operation === 'list_waiting') return { kind: 'list', orders: sales.waitingForStock(db, ctx.workspaceId) };
  if (intent.operation === 'create') {
    if (!intent.customerText) return question(intent, 'customerText', 'Which customer placed this order?');
    if (intent.quantity < 1) return question(intent, 'quantity', 'How many units did the customer order?');
    const resolved = findSku(db, ctx.workspaceId, intent);
    if (!resolved.ok) return question(intent, 'variantText', resolved.question, { choices: resolved.choices });
    const sku = resolved.value;
    const unitPriceMinor = priceForOrder(db, ctx, intent, sku);
    if (unitPriceMinor === null) {
      const displayName = sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name;
      return question({ ...intent, resolvedSkuId: sku.id }, 'unitPriceMinor',
        `${displayName} does not have a selling price. What price should this customer order use?`, { skuId: sku.id });
    }
    const draft = sales.createOrder(db, ctx, { customerName: intent.customerText, neededBy: intent.neededBy || null,
      lines: [{ skuId: sku.id, quantity: intent.quantity, unitPriceMinor }], notes: intent.statedAs,
      requirePrices: true });
    return { kind: 'created', order: sales.confirm(db, ctx, draft.id, { idempotencyKey: `tell-confirm:${draft.id}` }) };
  }
  const order = findOrder(db, ctx.workspaceId, intent);
  if (intent.operation === 'complete_order') {
    if (order.status === 'FULFILLED') {
      return { kind: 'already_completed', order,
        message: `${order.order_number} was already completed. Nothing was recorded twice.` };
    }
    let current = order;
    try {
      if (current.status === 'DRAFT') {
        current = sales.confirm(db, ctx, current.id, {
          idempotencyKey: `${options.idempotencyKey || `tell-complete:${current.id}`}:confirm`,
        });
      } else if (current.totals.backordered > 0) {
        sales.allocateAvailable(db, ctx, current.id, {
          idempotencyKey: `${options.idempotencyKey || `tell-complete:${current.id}`}:allocate`,
        });
        current = sales.getOrder(db, ctx.workspaceId, current.id);
      }
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return { kind: 'blocked', order: sales.getOrder(db, ctx.workspaceId, current.id), message: error.message };
    }
    if (current.totals.backordered > 0) {
      return { kind: 'blocked', order: current,
        message: `${current.order_number} cannot be completed yet: ${current.totals.backordered} unit(s) are not available. ${current.totals.allocated} available unit(s) are reserved; nothing was shipped.` };
    }
    if (current.totals.allocated <= 0) {
      return { kind: 'blocked', order: current,
        message: `${current.order_number} has no remaining allocated stock to ship. Nothing was changed.` };
    }
    return { kind: 'fulfilled', order: sales.fulfill(db, ctx, current.id, {}, {
      idempotencyKey: `${options.idempotencyKey || `tell-complete:${current.id}`}:fulfill`,
    }) };
  }
  if (intent.operation === 'cancel_order') return { kind: 'cancelled', order: sales.cancel(db, ctx, order.id, intent.reason) };
  const resolved = findSku(db, ctx.workspaceId, intent);
  if (!resolved.ok) return question(intent, 'variantText', resolved.question, { choices: resolved.choices });
  const sku = resolved.value;
  const line = order.lines.find((entry) => entry.sku_id === sku.id);
  if (intent.operation === 'add') {
    if (intent.quantity < 1) return question(intent, 'quantity', 'How many units should Foundry add?');
    const unitPriceMinor = priceForOrder(db, ctx, intent, sku);
    if (unitPriceMinor === null) {
      const displayName = sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name;
      return question({ ...intent, resolvedSkuId: sku.id }, 'unitPriceMinor',
        `${displayName} does not have a selling price. What price should this customer order use?`, { skuId: sku.id });
    }
    return { kind: 'changed', order: sales.addLine(db, ctx, order.id,
      { skuId: sku.id, quantity: intent.quantity, unitPriceMinor }) };
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

function continueApply(db, ctx, continuation, answer, options = {}) {
  if (!continuation || !continuation.intent || !continuation.field) {
    throw new ValidationError('That customer-order question is no longer waiting. Please send the order again.');
  }
  const intent = { ...continuation.intent };
  if (continuation.field === 'unitPriceMinor') {
    const amount = prices.toMinor(answer, 'Selling price');
    if (amount === null) throw new ValidationError('Enter the selling price for this customer order.');
    intent.unitPriceMinor = amount;
    if (continuation.skuId) intent.resolvedSkuId = continuation.skuId;
  } else if (continuation.field === 'quantity') {
    const quantity = Number(String(answer || '').trim());
    if (!Number.isInteger(quantity) || quantity < 1) throw new ValidationError('Quantity must be a whole number greater than zero.');
    intent.quantity = quantity;
  } else if (continuation.field === 'customerText') {
    const customer = String(answer || '').trim();
    if (!customer) throw new ValidationError('Enter the customer name.');
    intent.customerText = customer;
  } else if (continuation.field === 'variantText') {
    intent.variantText = String(answer || '').trim();
    intent.statedAs = `${intent.statedAs || ''} — ${intent.variantText}`;
  } else {
    throw new ValidationError('That customer-order question can no longer be continued safely.');
  }
  return apply(db, ctx, intent, options);
}

module.exports = { SCHEMA, SYSTEM, snapshot, fallback, interpret, apply, continueApply };
