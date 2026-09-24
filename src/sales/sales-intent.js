'use strict';

const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { ValidationError } = require('../domain/errors');
const resolver = require('../actions/resolver');
const sales = require('./sales-order-service');
const prices = require('../pricing/price-service');
const shippingAddress = require('../shipping/address');
const operatingInstructions = require('../manager/operating-instructions');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['operation', 'customerText', 'orderText', 'itemText', 'variantText', 'locationText', 'quantity', 'neededBy', 'reason'],
  properties: {
    operation: { type: 'string', enum: ['create', 'add', 'fulfill', 'complete_order', 'cancel_line', 'cancel_order', 'list_waiting'] },
    customerText: { type: 'string' }, orderText: { type: 'string' }, itemText: { type: 'string' },
    variantText: { type: 'string' }, locationText: { type: 'string' }, quantity: { type: 'integer', minimum: -1 },
    neededBy: { type: 'string' }, reason: { type: 'string' },
    deliveryMethod: { type: 'string', enum: ['', 'SHIP', 'PICKUP'] },
    shippingAddress: { type: 'string' }, customerEmail: { type: 'string' },
    deliverySource: { type: 'string' },
  },
};

const SYSTEM = `You translate ordinary-language customer-order requests into one typed Sales Order operation.
Use create when a customer has placed/committed an order. Use add for added quantity on an existing order.
Use fulfill when a stated quantity of stock shipped/left for a named customer order. Use complete_order when the
owner explicitly asks to complete, finish, or ship the entire named order and did not state one line quantity.
Use cancel_line when one product was cancelled,
cancel_order when the whole order was cancelled, and list_waiting for a read-only question about customer orders
waiting for stock. Preserve customer, order, product, variant, location, quantity and requested date exactly.
For create, preserve any explicitly supplied delivery address in shippingAddress and customer email in
customerEmail, copied verbatim from the request. deliveryMethod is SHIP or PICKUP only when stated;
deliverySource is the exact excerpt supporting that choice, or empty when no choice was supplied.
Never turn a request to prepare an order into evidence that goods have physically left or money was received.
neededBy must be YYYY-MM-DD when an exact date can be resolved from today's date; otherwise empty.
A request to create, place or start an order for someone — "can you create a customer order for
Marlow?" — is also create: customerText is who the order is for, itemText is empty when no product was
named, and quantity is -1. StockChief will ask for what is missing; do not fill it in.
Never invent missing records or quantities. Use -1 when quantity was not stated. Return only the schema.`;

function looksLikeNewPurchaseRequest(message) {
  const text = String(message || '');
  return /\b(?:wants?|would like|needs?)\s+(?:to\s+)?(?:order|buy|purchase)\b/i.test(text);
}

function singularWord(word) {
  const value = String(word || '').toLowerCase();
  if (value.length > 4 && value.endsWith('ies')) return `${value.slice(0, -3)}y`;
  if (value.length > 4 && /(?:ches|shes|xes|zes|ses)$/.test(value)) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) return value.slice(0, -1);
  return value;
}

function evidenceWords(value) {
  return String(value || '').toLowerCase().match(/[a-z0-9]+/g)?.map(singularWord)
    .filter((word) => word.length > 1 && !NOISE.has(word)) || [];
}

function statedInMessage(message, value) {
  const wanted = evidenceWords(value);
  if (!wanted.length) return false;
  const source = new Set(evidenceWords(message));
  return wanted.every((word) => source.has(word));
}

function groundCreateFields(message, data) {
  if (!data || data.operation !== 'create') return data;
  const grounded = { ...data };
  if (grounded.customerText && !statedInMessage(message, grounded.customerText)) grounded.customerText = '';
  if (grounded.itemText && !statedInMessage(message, grounded.itemText)) grounded.itemText = '';
  if (grounded.variantText && !statedInMessage(message, grounded.variantText)) grounded.variantText = '';
  if (Number(grounded.quantity) > 0
      && !new RegExp(`(^|\\D)${Number(grounded.quantity)}(?:\\D|$)`).test(String(message || ''))) {
    grounded.quantity = -1;
  }
  if (grounded.customerEmail && !String(message || '').includes(grounded.customerEmail)) grounded.customerEmail = '';
  if (grounded.shippingAddress && !String(message || '').includes(grounded.shippingAddress)) grounded.shippingAddress = '';
  if (grounded.deliverySource && !String(message || '').includes(grounded.deliverySource)) {
    grounded.deliveryMethod = '';
    grounded.deliverySource = '';
  }
  return grounded;
}

function asksToCompleteWholeOrder(message) {
  const text = String(message || '').trim();
  if (looksLikeNewPurchaseRequest(text) || /\b(?:ordered|placed an order for)\b/i.test(text)) return false;
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
    approvedTeachings: operatingInstructions.activeTeachings(db, workspaceId, {
      scopes: ['sales', 'shipping', 'payments', 'email'],
    }).map((teaching) => ({
      scope: teaching.scope,
      effect: teaching.effect,
      grantsAuthority: teaching.grantsAuthority,
    })),
  };
}

function trimItem(value) {
  return String(value || '')
    .replace(/\s+(?:and\s+)?(?:for\s+)?(?:have\s+)?(?:them|it|the\s+order)?\s*(?:customer\s+)?(?:ship(?:ped|ping)?|deliver(?:ed|y)?|collect(?:ed|ion)?|pick(?:ed)?\s*up)\b.*$/i, '')
    .replace(/(?:[,;]|\s+for)\s*(?:customer\s+)?(?:pickup|pick\s*up|collection)\b.*$/i, '')
    .replace(/^\s*(?:some|a|an)\s+/i, '')
    .replace(/[\s,;:.-]+$/, '').trim();
}

function parseCreateRequest(text) {
  const personFirst = text.match(/^\s*(?:please[,\s]+)?(.+?)\s+(?:wants?|would like|needs?)\s+(?:to\s+)?(?:order|buy|purchase)\s+(?:(\d+)\s+)?(.+?)(?=\s+(?:and\s+)?(?:for\s+)?(?:have\s+)?(?:them|it|the\s+order)?\s*(?:customer\s+)?(?:ship(?:ped|ping)?|deliver(?:ed|y)?|collect(?:ed|ion)?|pick(?:ed)?\s*up)\b|[.?!]|$)/i);
  if (personFirst) return {
    customerText: personFirst[1].trim(), quantity: Number(personFirst[2] || -1), itemText: trimItem(personFirst[3]),
  };
  const reported = text.match(/^\s*(.+?)\s+(?:ordered|bought|purchased|placed\s+an?\s+order\s+for)\s+(?:(\d+)\s+)?(.+?)(?=\s+(?:and\s+)?(?:for\s+)?(?:have\s+)?(?:them|it|the\s+order)?\s*(?:customer\s+)?(?:ship(?:ped|ping)?|deliver(?:ed|y)?|collect(?:ed|ion)?|pick(?:ed)?\s*up)\b|[.?!]|$)/i);
  if (reported) return {
    customerText: reported[1].trim(), quantity: Number(reported[2] || -1), itemText: trimItem(reported[3]),
  };
  const forCustomer = text.match(/\b(?:customer|sales)?\s*order\s+for\s+(.+)$/i);
  if (!forCustomer) return null;
  const remainder = forCustomer[1].replace(/[.?!]+$/, '').trim();
  const divided = remainder.match(/^(.+?)\s*(?::|,|\s+for)\s*(\d+)\s+(.+)$/i)
    || remainder.match(/^(.+?)\s+(\d+)\s+(.+)$/i);
  if (divided) return {
    customerText: divided[1].trim(), quantity: Number(divided[2]), itemText: trimItem(divided[3]),
  };
  return { customerText: remainder, quantity: -1, itemText: '' };
}

function fallback(message) {
  const text = String(message || '').trim();
  const purchase = parseCreateRequest(text);
  const quantity = Number(purchase?.quantity || (text.match(/\b(\d+)\b/) || [])[1] || -1);
  if (/waiting for stock|backorder/i.test(text) && /what|which|show|customer order/i.test(text)) {
    return { operation: 'list_waiting', customerText: '', orderText: '', itemText: '', variantText: '', locationText: '', quantity: -1, neededBy: '', reason: 'Read waiting customer orders.' };
  }
  const cancel = /\bcancel(?:led|ed)?\b/i.test(text);
  const completeOrder = asksToCompleteWholeOrder(text);
  const fulfill = /\b(ship|shipped|fulfill|fulfilled|dispatch|dispatched)\b/i.test(text);
  const add = /\badd(?:ed)?\b.*\b(?:to|onto)\b/i.test(text);
  const requested = asksToCreateOrder(text);
  const create = requested || /\b(?:ordered|placed an order|customer order)\b/i.test(text);
  // "Create a customer order for Marlow" names a customer and nothing else.
  // Handing the whole sentence over as the product name would send the
  // resolver looking for a product called "customer order for Marlow".
  const customerFromPurchase = String(purchase?.customerText || '').trim();
  const requestedCustomer = customerFromPurchase && !/^a?\s*customer$/i.test(customerFromPurchase)
    ? customerFromPurchase
    : requested ? (text.match(/\bfor\s+(.+?)(?:\s*[.?!]|$)/i) || [, ''])[1].trim() : '';
  const pickupSource = (text.match(/\b(?:customer\s+)?(?:pickup|pick\s*up|collect(?:ed|ion)?)\b/i) || [''])[0];
  const shippingSource = (text.match(/\b(?:ship(?:ped|ping)?|deliver(?:ed|y)?)\b/i) || [''])[0];
  const deliveryMethod = pickupSource ? 'PICKUP' : shippingSource ? 'SHIP' : '';
  return {
    operation: cancel ? (/whole|entire|order\s+(?:was\s+)?cancel/i.test(text) ? 'cancel_order' : 'cancel_line')
      : completeOrder ? 'complete_order' : create ? 'create' : fulfill ? 'fulfill' : add ? 'add' : 'list_waiting',
    customerText: requestedCustomer, orderText: (text.match(/\bSO-\d+\b/i) || [''])[0],
    itemText: completeOrder ? '' : String(purchase?.itemText || (requested ? '' : text)).trim(), variantText: '',
    locationText: (text.match(/\bfrom\s+(.+?)(?:\.|$)/i) || [,''])[1], quantity: purchase ? quantity : requested ? -1 : quantity,
    neededBy: '', reason: 'Deterministic fallback.', deliveryMethod,
    deliverySource: pickupSource || shippingSource,
    shippingAddress: '', customerEmail: '',
  };
}

/**
 * A request for an order, as opposed to a report of one.
 *
 * "Marlow ordered 12 Copper Elbow" states something that happened, and the
 * order is recorded in one step. "Can you create a customer order for
 * Marlow?" asks StockChief to start one, with the details still to come — so it
 * is answered as a conversation: which customer, which product, how many.
 */
function asksToCreateOrder(message) {
  const text = String(message || '');
  if (looksLikeNewPurchaseRequest(text)) return true;
  if (asksToCompleteWholeOrder(text) || /\b(?:cancel|fulfil|dispatch)/i.test(text)) return false;
  return /\b(?:create|place|make|start|open|raise|set up|new)\b[^.?!]*\b(?:customer|sales)\s+order\b/i.test(text)
    || /\b(?:customer|sales)\s+order\b[^.?!]*\bfor\b/i.test(text)
    || /^\s*(?:can|could|would|will|please)\b[^.?!]*\border\b/i.test(text);
}

function isCreateMessage(message) {
  const text = String(message || '').trim();
  if (asksToCreateOrder(text)) return true;
  return !/^\s*(?:i|we|our\s+(?:business|company))\b/i.test(text)
    && /^\s*(?:please[,\s]+)?[^.?!]+?\s+(?:ordered|bought|purchased|placed\s+an?\s+order\s+for)\s+(?:\d+\s+)?[^.?!]+/i.test(text);
}

/*
 * Customers, matched the way a person names them.
 *
 * "Marlow" is Marlow & Co.; "abc" is ABC School. An exact name or company is
 * the customer. Anything looser is offered back as a choice rather than acted
 * on, and a name that matches nothing is offered as a new customer — because
 * quietly creating a second "Marlow" beside "Marlow & Co." is how a customer
 * list fills up with the same business three times.
 */
const NOISE = new Set(['the', 'and', 'co', 'ltd', 'inc', 'llc', 'plc', 'company', 'limited', 'of']);
function nameWords(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !NOISE.has(w));
}
function matchCustomer(db, workspaceId, text) {
  const wanted = String(text || '').trim().toLowerCase();
  if (!wanted) return { exact: null, close: [] };
  const customers = sales.listCustomers(db, workspaceId);
  const exact = customers.find((c) => c.name.toLowerCase() === wanted
    || String(c.company || '').toLowerCase() === wanted) || null;
  if (exact) return { exact, close: [] };
  const wantedWords = nameWords(wanted);
  const close = customers.filter((c) => {
    const have = new Set([...nameWords(c.name), ...nameWords(c.company)]);
    return wantedWords.some((w) => w.length >= 3 && have.has(w));
  });
  return { exact: null, close };
}

/* What could be sold right now, for the moment a person asks "what can I place?" */
function sellableChoices(db, workspaceId) {
  const rows = db.prepare(`SELECT s.id, s.code, s.variant_label, i.name AS item_name, i.unit_label,
      COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.sku_id = s.id), 0) AS on_hand
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name COLLATE NOCASE, s.position`).all(workspaceId);
  const committed = new Map();
  for (const row of sales.committedByPosition(db, workspaceId, { skuIds: rows.map((r) => r.id) })) {
    committed.set(row.sku_id, (committed.get(row.sku_id) || 0) + Number(row.committed));
  }
  return rows.map((row) => {
    const available = Number(row.on_hand) - (committed.get(row.id) || 0);
    const name = row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name;
    const units = row.unit_label || 'unit';
    return { label: `${name} — ${available} ${available === 1 ? units : `${units}s`} available`, value: row.id, available };
  });
}

/* The most a single screen of buttons can carry before typing is faster. */
const CHOICE_LIMIT = 24;

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
    data = groundCreateFields(message, result.data);
  } catch { data = fallback(message); }
  // Carried on the intent so the create path knows whether it is recording a
  // fact or holding a conversation. Only the conversation checks the customer
  // is on file first; a report names who ordered, and that is the record.
  return { ...data, statedAs: message, guided: asksToCreateOrder(message) };
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
  if (!candidates.length) throw new ValidationError('StockChief could not find an open sales order matching that customer or order number.');
  throw new ValidationError('More than one open sales order matches. Name the order number so StockChief does not change the wrong one.');
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
  // Carry review-only mode through every grounded clarification continuation.
  if (options.previewOnly) intent={...intent,previewOnly:true};
  options={...options,previewOnly:Boolean(options.previewOnly||intent.previewOnly)};
  if (intent.operation === 'list_waiting') return { kind: 'list', orders: sales.waitingForStock(db, ctx.workspaceId) };
  if (intent.operation === 'create') {
    /*
     * A conversation, not a form.
     *
     * When somebody asks StockChief to create an order rather than reporting one,
     * each missing piece is asked for in turn, from real records: which
     * customer (with the ones on file to pick from), whether an unknown name
     * should become a new customer, which product (with what is actually
     * available), how many. A report — "Marlow ordered 12 Copper Elbow" —
     * still goes straight through, because the person has already said it all.
     */
    if (!intent.customerText) {
      const customers = sales.listCustomers(db, ctx.workspaceId);
      const choices = customers.length && customers.length <= CHOICE_LIMIT
        ? customers.map((c) => ({ label: c.company && c.company !== c.name ? `${c.name} · ${c.company}` : c.name, value: c.name }))
        : null;
      return question(intent, 'customerText', intent.guided
        ? 'Sure — which customer is this order for?' : 'Which customer placed this order?', { choices });
    }
    if (intent.guided && !intent.customerSettled) {
      const match = matchCustomer(db, ctx.workspaceId, intent.customerText);
      if (match.exact) {
        intent = { ...intent, customerText: match.exact.name, customerSettled: true };
      } else if (match.close.length) {
        return question(intent, 'customerText',
          `There is no customer called “${intent.customerText}” on file. Did you mean one of these, or should StockChief create them?`,
          { choices: [
            ...match.close.slice(0, CHOICE_LIMIT - 1).map((c) => ({ label: c.name, value: c.name })),
            { label: `Create “${intent.customerText}” as a new customer`, value: `__create__:${intent.customerText}` },
          ] });
      } else {
        return question(intent, 'customerDecision',
          `“${intent.customerText}” is not a customer on file yet. Create them and carry on with the order?`,
          { choices: [
            { label: `Yes — create “${intent.customerText}” and continue`, value: 'create' },
            { label: 'No — pick an existing customer', value: 'choose' },
          ] });
      }
    }
    const productNamed = Boolean(intent.resolvedSkuId || String(intent.itemText || '').trim() || String(intent.variantText || '').trim());
    if (!productNamed) {
      const sellable = sellableChoices(db, ctx.workspaceId);
      return question(intent, 'skuId',
        `Sure — what would you like to place for ${intent.customerText}?`,
        { choices: sellable.length && sellable.length <= CHOICE_LIMIT ? sellable : null });
    }
    const resolved = findSku(db, ctx.workspaceId, intent);
    if (!resolved.ok) return question(intent, 'variantText', resolved.question, { choices: resolved.choices });
    const sku = resolved.value;
    if (intent.quantity < 1) {
      const displayName = sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name;
      const availability = sales.availabilityForSku(db, ctx.workspaceId, sku.id);
      return question({ ...intent, resolvedSkuId: sku.id }, 'quantity',
        `How many ${displayName} for ${intent.customerText}? ${availability.available} available right now.`,
        { skuId: sku.id });
    }
    const unitPriceMinor = priceForOrder(db, ctx, intent, sku);
    if (unitPriceMinor === null) {
      const displayName = sku.variant_label ? `${sku.item_name} / ${sku.variant_label}` : sku.item_name;
      return question({ ...intent, resolvedSkuId: sku.id }, 'unitPriceMinor',
        `${displayName} does not have a selling price. What price should this customer order use?`, { skuId: sku.id });
    }
    const stated = String(intent.statedAs || '');
    const trustedMethod = intent.deliveryMethodConfirmed
      || (intent.deliverySource && stated.includes(intent.deliverySource))
      ? intent.deliveryMethod : '';
    if (!['SHIP', 'PICKUP'].includes(trustedMethod)) {
      return question(intent, 'deliveryMethod', `How will ${intent.customerText} receive this order?`, { choices: [
        { label: 'Ship it to an address', value: 'SHIP' },
        { label: 'Customer pickup', value: 'PICKUP' },
      ] });
    }
    const matchedCustomer = matchCustomer(db, ctx.workspaceId, intent.customerText).exact;
    const statedAddress = intent.shippingAddressConfirmed
      || (intent.shippingAddress && stated.includes(intent.shippingAddress)) ? String(intent.shippingAddress || '').trim() : '';
    const destination = statedAddress || String(matchedCustomer?.shipping_address || '').trim();
    if (trustedMethod === 'SHIP' && !destination) {
      return question({ ...intent, deliveryMethod: 'SHIP', deliveryMethodConfirmed: true }, 'shippingAddress',
        `What delivery address should ${intent.customerText}'s order ship to?`);
    }
    if (trustedMethod === 'SHIP') {
      const parsedAddress = shippingAddress.parse(destination);
      if (!parsedAddress.complete) {
        return question({ ...intent, deliveryMethod: 'SHIP', deliveryMethodConfirmed: true }, 'shippingAddress',
          `That destination still needs ${parsedAddress.missing.join(', ')}. Enter the complete delivery address for ${intent.customerText}.`);
      }
    }
    const draft = sales.createOrder(db, ctx, { customerName: intent.customerText, neededBy: intent.neededBy || null,
      deliveryMethod: trustedMethod, requireCompleteDelivery: true,
      ...(trustedMethod === 'SHIP' && statedAddress ? { shipToAddress: statedAddress } : {}),
      ...(intent.customerEmail && String(intent.statedAs || '').includes(intent.customerEmail)
        ? { customerEmail: intent.customerEmail } : {}),
      lines: [{ skuId: sku.id, quantity: intent.quantity, unitPriceMinor }], notes: intent.statedAs,
      requirePrices: true });
    if (options.previewOnly || intent.guided) return {kind:'created',order:draft,
      message:`${draft.order_number} is prepared for ${draft.customer.name}: ${draft.totals.ordered} unit(s), ${draft.delivery_method === 'PICKUP' ? 'customer pickup' : `shipping to ${draft.ship_to_address}`}. No stock is reserved, nothing has shipped, and no customer has been contacted.`};
    return { kind: 'created', order: sales.confirm(db, ctx, draft.id, { idempotencyKey: `tell-confirm:${draft.id}` }) };
  }
  const order = findOrder(db, ctx.workspaceId, intent);
  if (options.previewOnly) return {kind:'review',order,
    message:`Review ${order.order_number} before applying the requested ${intent.operation.replace(/_/g,' ')}. Nothing was changed; use the order's explicit controls to approve the next step.`};
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
    if (intent.quantity < 1) return question(intent, 'quantity', 'How many units should StockChief add?');
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
  throw new ValidationError('StockChief could not safely determine the requested sales-order change.');
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
    // "Create “Marlow” as a new customer" was one of the choices: the name is
    // decided, and the customer check must not ask about it a second time.
    if (customer.startsWith('__create__:')) {
      intent.customerText = customer.slice('__create__:'.length).trim();
      intent.customerSettled = true;
    } else {
      intent.customerText = customer;
      delete intent.customerSettled;
    }
  } else if (continuation.field === 'customerDecision') {
    const decision = String(answer || '').trim().toLowerCase();
    if (decision === 'create' || decision === 'yes') intent.customerSettled = true;
    else if (decision === 'choose' || decision === 'no') { intent.customerText = ''; delete intent.customerSettled; }
    else throw new ValidationError('Choose whether to create the customer or pick an existing one.');
  } else if (continuation.field === 'skuId') {
    const skuId = String(answer || '').trim();
    if (!skuId) throw new ValidationError('Choose a product for this order.');
    // A typed product name is as good as a pressed button.
    if (/^sku_/.test(skuId)) intent.resolvedSkuId = skuId;
    else intent.itemText = skuId;
  } else if (continuation.field === 'variantText') {
    intent.variantText = String(answer || '').trim();
    intent.statedAs = `${intent.statedAs || ''} — ${intent.variantText}`;
  } else if (continuation.field === 'deliveryMethod') {
    const method = String(answer || '').trim().toUpperCase();
    if (!['SHIP', 'PICKUP'].includes(method)) throw new ValidationError('Choose shipping or customer pickup.');
    intent.deliveryMethod = method;
    intent.deliveryMethodConfirmed = true;
  } else if (continuation.field === 'shippingAddress') {
    const address = String(answer || '').trim();
    if (!address) throw new ValidationError('Enter the complete delivery address.');
    intent.shippingAddress = address;
    intent.shippingAddressConfirmed = true;
  } else {
    throw new ValidationError('That customer-order question can no longer be continued safely.');
  }
  return apply(db, ctx, intent, options);
}

module.exports = { SCHEMA, SYSTEM, snapshot, fallback, interpret, apply, continueApply, isCreateMessage };
