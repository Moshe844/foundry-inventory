'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const inventory = require('../domain/inventory-engine');
const repo = require('../domain/repository');
const sales = require('../sales/sales-order-service');
const events = require('../manager/events');
const reevaluate = require('../attention/reevaluate');
const connections = require('./service');
const { ValidationError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

const MAX_BATCH = 500;
const TYPES = Object.freeze({
  sale: 'sale.completed', issue: 'sale.completed', shipment_out: 'sale.completed',
  'sale.completed': 'sale.completed',
  receive: 'inventory.receipt', receipt: 'inventory.receipt', 'inventory.receipt': 'inventory.receipt',
  customer_return: 'return.completed', return: 'return.completed', 'return.completed': 'return.completed',
  count: 'inventory.adjustment', adjust: 'inventory.adjustment', adjustment: 'inventory.adjustment',
  'inventory.adjustment': 'inventory.adjustment', transfer: 'inventory.transfer',
  'inventory.transfer': 'inventory.transfer',
  customer_order: 'sales_order.created', 'sales_order.created': 'sales_order.created',
  order_changed: 'sales_order.changed', 'sales_order.changed': 'sales_order.changed',
  order_snapshot: 'sales_order.snapshot', 'sales_order.snapshot': 'sales_order.snapshot',
  order_cancelled: 'sales_order.cancelled', 'sales_order.cancelled': 'sales_order.cancelled',
  fulfillment: 'sales_order.fulfilled', 'sales_order.fulfilled': 'sales_order.fulfilled',
  'product.changed': 'product.changed', 'location.changed': 'location.changed',
  return_reported: 'return.reported', 'return.reported': 'return.reported',
  supplier_document: 'supplier_document.received', 'supplier_document.received': 'supplier_document.received',
  reconciliation: 'reconciliation.summary', 'reconciliation.summary': 'reconciliation.summary',
});

const hashPayload = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };

function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Each event must be an object.');
  const eventId = requireText(input.eventId || input.id, 'Event id', { max: 160 });
  const rawType = requireText(input.type, 'Event type', { max: 80 }).toLowerCase().replaceAll('-', '_');
  const type = TYPES[rawType];
  if (!type) throw new ValidationError(`Unsupported external event type: ${rawType}.`);
  const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data)
    ? { ...input.data }
    : { ...input };
  delete data.id; delete data.eventId; delete data.type; delete data.version;
  delete data.occurredAt; delete data.aggregateId; delete data.data;
  return {
    eventId, type, version: trimOrNull(input.version),
    occurredAt: trimOrNull(input.occurredAt || input.providerTimestamp),
    aggregateKey: trimOrNull(input.aggregateId || data.externalOrderId || data.orderId),
    data,
  };
}

function candidates(db, workspaceId, entityType, query) {
  const q = String(query || '').toLowerCase();
  if (entityType === 'sku') {
    return db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? ORDER BY i.name COLLATE NOCASE LIMIT 100`)
      .all(workspaceId).map((row) => ({ id: row.id, label: `${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''} · ${row.code}` }))
      .sort((a, b) => (b.label.toLowerCase().includes(q) - a.label.toLowerCase().includes(q))).slice(0, 8);
  }
  if (entityType === 'location') {
    return repo.listLocations(db, workspaceId).map((row) => ({ id: row.id, label: row.name }))
      .sort((a, b) => (b.label.toLowerCase().includes(q) - a.label.toLowerCase().includes(q))).slice(0, 8);
  }
  return [];
}

function mappedRecord(db, auth, entityType, externalId, directId, directNameOrCode) {
  const external = trimOrNull(externalId);
  if (external) {
    const existing = connections.mapping(db, auth.workspaceId, auth.connectorId, entityType, external);
    if (existing) return existing.foundry_record_id;
  }
  if (directId) {
    const tables = { sku: 'skus', location: 'locations', customer: 'customers', sales_order: 'sales_orders', supplier: 'suppliers' };
    const found = db.prepare(`SELECT id FROM ${tables[entityType]} WHERE workspace_id = ? AND id = ?`)
      .get(auth.workspaceId, directId);
    if (found) return found.id;
  }
  if (directNameOrCode && entityType === 'sku') {
    const rows = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE`)
      .all(auth.workspaceId, directNameOrCode);
    if (rows.length === 1) {
      if (external) autoMap(db, auth, entityType, external, rows[0].id);
      return rows[0].id;
    }
  }
  if (directNameOrCode && entityType === 'location') {
    const rows = db.prepare('SELECT id FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND is_active = 1')
      .all(auth.workspaceId, directNameOrCode);
    if (rows.length === 1) {
      if (external) autoMap(db, auth, entityType, external, rows[0].id);
      return rows[0].id;
    }
  }
  return null;
}

function autoMap(db, auth, entityType, externalId, foundryRecordId) {
  const now = nowIso();
  db.prepare(`INSERT INTO connection_mappings
    (id, workspace_id, connector_id, entity_type, external_id, foundry_record_id, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'exact', ?, ?)
    ON CONFLICT(workspace_id, connector_id, entity_type, external_id) DO NOTHING`)
    .run(newId('cmap'), auth.workspaceId, auth.connectorId, entityType, externalId, foundryRecordId, now, now);
}

class MappingRequired extends Error {
  constructor(entityType, externalId, candidatesList) {
    super(`Foundry cannot safely match external ${entityType} ${externalId}.`);
    this.entityType = entityType;
    this.externalId = externalId;
    this.candidates = candidatesList;
  }
}

function skuFor(db, auth, data) {
  const externalId = trimOrNull(data.externalSku || data.externalSkuId || (data.sku && data.sku.externalId));
  const code = trimOrNull(data.skuCode || (data.sku && data.sku.code));
  const id = mappedRecord(db, auth, 'sku', externalId, trimOrNull(data.skuId), code);
  if (!id) throw new MappingRequired('sku', externalId || code || 'unknown', candidates(db, auth.workspaceId, 'sku', code || externalId));
  const row = repo.getSku(db, auth.workspaceId, id);
  if (!row) throw new MappingRequired('sku', externalId || code || id, candidates(db, auth.workspaceId, 'sku', code || externalId));
  return row;
}

function locationFor(db, auth, data, prefix = 'location') {
  const externalId = trimOrNull(data[`external${prefix[0].toUpperCase()}${prefix.slice(1)}Id`] ||
    (data[prefix] && data[prefix].externalId));
  const directId = trimOrNull(data[`${prefix}Id`] || (data[prefix] && data[prefix].id));
  const name = trimOrNull(data[`${prefix}Name`] || (data[prefix] && data[prefix].name));
  const id = mappedRecord(db, auth, 'location', externalId, directId, name);
  if (id) return repo.getLocation(db, auth.workspaceId, id);
  if (!externalId && !name && !directId) {
    const rows = repo.listLocations(db, auth.workspaceId);
    if (rows.length === 1) return rows[0];
  }
  throw new MappingRequired('location', externalId || name || directId || 'unknown',
    candidates(db, auth.workspaceId, 'location', name || externalId));
}

function sourceNotes(auth, event) {
  return `Source: ${auth.displayName}; external event: ${event.eventId}.`;
}

function positive(value, label = 'Quantity') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label} must be a positive whole number.`);
  return n;
}

function orderFor(db, auth, data) {
  const externalId = requireText(data.externalOrderId || data.orderId, 'External order id', { max: 160 });
  const mapped = connections.mapping(db, auth.workspaceId, auth.connectorId, 'sales_order', externalId);
  if (!mapped) throw new MappingRequired('sales_order', externalId, []);
  return sales.getOrder(db, auth.workspaceId, mapped.foundry_record_id);
}

function apply(db, auth, event) {
  const ctx = { workspaceId: auth.workspaceId, actorId: auth.actorId, accountId: auth.accountId };
  const data = event.data;
  const reference = trimOrNull(data.reference) || `external:${event.eventId}`;
  const notes = sourceNotes(auth, event);

  if (event.type === 'sale.completed') {
    const sku = skuFor(db, auth, data);
    const location = locationFor(db, auth, data);
    const result = inventory.issue(db, ctx, { skuId: sku.id, locationId: location.id,
      quantity: positive(data.quantity), reasonCode: trimOrNull(data.reasonCode) || 'sold',
      reference, notes, occurredAt: event.occurredAt });
    events.publish(db, auth.workspaceId, events.TYPES.CONNECTOR_SALE_COMPLETED, {
      connectorId: auth.connectorId, connectorName: auth.displayName,
      externalEventId: event.eventId, occurredAt: event.occurredAt,
      movementIds: result.movementIds || [], skuId: sku.id, itemId: sku.item_id,
      locationId: location.id, quantity: positive(data.quantity),
      unitPriceMinor: data.unitPriceMinor, grossMinor: data.grossMinor,
      discountMinor: data.discountMinor, taxMinor: data.taxMinor,
      settlement: trimOrNull(data.settlement || data.paymentStatus), reference,
    }, { source: auth.providerType, sourceRecordType: 'connector_event',
      sourceRecordId: event.eventId,
      idempotencyKey: `connector-sale:${auth.connectorId}:${event.eventId}` });
    return { actionType: 'inventory.issue', actionRecordId: (result.movementIds || [])[0] || null,
      movementIds: result.movementIds || [], skuIds: [sku.id] };
  }
  if (event.type === 'inventory.receipt' || event.type === 'return.completed') {
    const sku = skuFor(db, auth, data);
    const location = locationFor(db, auth, data);
    const result = inventory.receive(db, ctx, { skuId: sku.id, locationId: location.id,
      quantity: positive(data.quantity), serials: data.serials, lotCode: data.lotCode,
      expiresAt: data.expiresAt, reasonCode: trimOrNull(data.reasonCode), reference, notes,
      occurredAt: event.occurredAt });
    if (event.type === 'return.completed') events.publish(db, auth.workspaceId,
      events.TYPES.CONNECTOR_RETURN_COMPLETED, {
        connectorId: auth.connectorId, connectorName: auth.displayName,
        externalEventId: event.eventId, originalSaleEventId: trimOrNull(data.originalSaleEventId),
        occurredAt: event.occurredAt, movementIds: result.movementIds || [],
        skuId: sku.id, itemId: sku.item_id, locationId: location.id,
        quantity: positive(data.quantity), revenueMinor: data.revenueMinor ?? data.refundMinor,
        taxMinor: data.taxMinor, reference,
      }, { source: auth.providerType, sourceRecordType: 'connector_event',
        sourceRecordId: event.eventId,
        idempotencyKey: `connector-return:${auth.connectorId}:${event.eventId}` });
    return { actionType: event.type === 'return.completed' ? 'inventory.return' : 'inventory.receive',
      actionRecordId: (result.movementIds || [])[0] || null, movementIds: result.movementIds || [], skuIds: [sku.id] };
  }
  if (event.type === 'inventory.adjustment') {
    const sku = skuFor(db, auth, data);
    const location = locationFor(db, auth, data);
    const result = inventory.adjust(db, ctx, { skuId: sku.id, locationId: location.id,
      countedQty: data.countedQty ?? data.countedQuantity, reasonCode: trimOrNull(data.reasonCode) || 'physical_count',
      reference, notes, occurredAt: event.occurredAt });
    return { actionType: 'inventory.adjust', actionRecordId: (result.movementIds || [])[0] || null,
      movementIds: result.movementIds || [], skuIds: [sku.id] };
  }
  if (event.type === 'inventory.transfer') {
    const sku = skuFor(db, auth, data);
    const from = locationFor(db, auth, data, 'fromLocation');
    const to = locationFor(db, auth, data, 'toLocation');
    const result = inventory.transfer(db, ctx, { skuId: sku.id, fromLocationId: from.id, toLocationId: to.id,
      quantity: positive(data.quantity), reference, notes, occurredAt: event.occurredAt });
    return { actionType: 'inventory.transfer', actionRecordId: (result.movementIds || [])[0] || null,
      movementIds: result.movementIds || [], skuIds: [sku.id] };
  }
  if (event.type === 'sales_order.created') {
    const externalOrderId = requireText(data.externalOrderId || data.orderId, 'External order id', { max: 160 });
    const existing = connections.mapping(db, auth.workspaceId, auth.connectorId, 'sales_order', externalOrderId);
    if (existing) return { actionType: 'sales_order.created', actionRecordId: existing.foundry_record_id,
      movementIds: [], skuIds: [] };
    const lines = Array.isArray(data.lines) ? data.lines : [];
    if (!lines.length) throw new ValidationError('A customer order needs at least one line.');
    const mappedLines = lines.map((line) => ({ skuId: skuFor(db, auth, line).id,
      quantity: positive(line.quantity), unitPriceMinor: line.unitPriceMinor }));
    let customerId = null;
    const externalCustomerId = trimOrNull(data.externalCustomerId || (data.customer && data.customer.externalId));
    if (externalCustomerId) {
      const found = connections.mapping(db, auth.workspaceId, auth.connectorId, 'customer', externalCustomerId);
      customerId = found && found.foundry_record_id;
    }
    const customerName = trimOrNull(data.customerName || (data.customer && data.customer.name)) || 'External customer';
    const hasFulfillmentLocation = data.fulfillmentLocation || data.fulfillmentLocationId
      || data.fulfillmentLocationName || data.externalFulfillmentLocationId;
    const created = sales.createOrder(db, ctx, { customerId, customerName, company: data.company,
      fulfillmentLocationId: hasFulfillmentLocation ? locationFor(db, auth, data, 'fulfillmentLocation').id : null,
      orderNumber: trimOrNull(data.orderNumber), orderDate: data.orderDate || (event.occurredAt && event.occurredAt.slice(0, 10)),
      neededBy: data.neededBy, reference: `Source: ${auth.displayName}; ${externalOrderId}`,
      notes, lines: mappedLines, currency: data.currency, discount: data.discount, tax: data.tax });
    sales.confirm(db, ctx, created.id, { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:confirm` });
    autoMap(db, auth, 'sales_order', externalOrderId, created.id);
    if (externalCustomerId) autoMap(db, auth, 'customer', externalCustomerId, created.customer_id);
    return { actionType: 'sales_order.created', actionRecordId: created.id, movementIds: [], skuIds: mappedLines.map((l) => l.skuId) };
  }
  if (event.type === 'sales_order.fulfilled') {
    const order = orderFor(db, auth, data);
    let fulfillmentLines = data.lines || [];
    if (fulfillmentLines.length && !fulfillmentLines.every((line) => line.lineId && line.locationId)) {
      const requested = [];
      for (const externalLine of fulfillmentLines) {
        const skuId = skuFor(db, auth, externalLine).id;
        const orderLine = order.lines.find((line) => line.sku_id === skuId);
        if (!orderLine) throw new ValidationError('The provider fulfillment contains a product that is not on this Sales Order.');
        let remaining = positive(externalLine.quantity);
        let allocations = orderLine.allocations;
        if (externalLine.externalLocationId || externalLine.locationName || externalLine.locationId) {
          const locationId = locationFor(db, auth, externalLine).id;
          allocations = allocations.filter((allocation) => allocation.location_id === locationId);
        }
        for (const allocation of allocations) {
          if (!remaining) break;
          const quantity = Math.min(remaining, Number(allocation.quantity));
          if (quantity) requested.push({ lineId: orderLine.id, locationId: allocation.location_id, quantity });
          remaining -= quantity;
        }
        if (remaining) throw new ValidationError('The provider fulfillment exceeds stock committed to this Sales Order.');
      }
      fulfillmentLines = requested;
    }
    const fulfilled = sales.fulfill(db, ctx, order.id, { lines: fulfillmentLines },
      { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:fulfill` });
    return { actionType: 'sales_order.fulfilled', actionRecordId: order.id, movementIds: [],
      skuIds: fulfilled.lines.map((line) => line.sku_id) };
  }
  if (event.type === 'sales_order.cancelled') {
    const order = orderFor(db, auth, data);
    const cancelled = sales.cancel(db, ctx, order.id, data.reason || `Cancelled by ${auth.displayName}`,
      { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:cancel` });
    return { actionType: 'sales_order.cancelled', actionRecordId: order.id, movementIds: [],
      skuIds: cancelled.lines.map((line) => line.sku_id) };
  }
  if (event.type === 'sales_order.changed') {
    const order = orderFor(db, auth, data);
    if (!Array.isArray(data.addLines) || !data.addLines.length) {
      throw new ValidationError('An order change must state addLines; Foundry will not infer whether provider totals are deltas.');
    }
    let changed = order;
    for (const line of data.addLines) changed = sales.addLine(db, ctx, order.id,
      { skuId: skuFor(db, auth, line).id, quantity: positive(line.quantity) },
      { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:line:${line.externalSku || line.skuCode}` });
    return { actionType: 'sales_order.changed', actionRecordId: order.id, movementIds: [],
      skuIds: changed.lines.map((line) => line.sku_id) };
  }
  if (event.type === 'sales_order.snapshot') {
    const order = orderFor(db, auth, data);
    const externalLines = Array.isArray(data.lines) ? data.lines : [];
    if (!externalLines.length) {
      throw new ValidationError('An order snapshot needs at least one line. Use a cancellation event for an empty order.');
    }
    const desired = new Map();
    for (const line of externalLines) {
      const skuId = skuFor(db, auth, line).id;
      desired.set(skuId, (desired.get(skuId) || 0) + positive(line.quantity));
    }
    let changed = order;
    for (const [skuId, quantity] of desired) {
      const current = order.lines.find((line) => line.sku_id === skuId);
      if (!current) {
        changed = sales.addLine(db, ctx, order.id, { skuId, quantity },
          { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:snapshot:add:${skuId}` });
      } else if (Number(current.quantity_ordered) !== quantity) {
        changed = sales.setLineQuantity(db, ctx, order.id, current.id, quantity,
          { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:snapshot:set:${skuId}` });
      }
    }
    for (const current of order.lines) {
      if (desired.has(current.sku_id)) continue;
      changed = sales.setLineQuantity(db, ctx, order.id, current.id, Number(current.quantity_fulfilled),
        { idempotencyKey: `external:${auth.connectorId}:${event.eventId}:snapshot:remove:${current.sku_id}` });
    }
    return { actionType: 'sales_order.changed', actionRecordId: order.id, movementIds: [],
      skuIds: changed.lines.map((line) => line.sku_id) };
  }
  if (event.type === 'return.reported') {
    connections.issue(db, { workspaceId: auth.workspaceId, connectorId: auth.connectorId,
      externalEventId: event.eventId, issueType: 'RETURN_REVIEW_REQUIRED',
      fingerprint: `return-review:${auth.connectorId}:${event.eventId}`,
      title: `${auth.displayName} reported a refund that needs return confirmation`,
      detail: `${trimOrNull(data.reference) || `External refund ${event.eventId}`} is financial evidence only. Foundry has not increased stock.`,
      resolutionHint: 'Confirm that the product physically returned, then record the return in Foundry.',
    });
    return { actionType: 'return.review_required', actionRecordId: null, movementIds: [], skuIds: [] };
  }
  if (event.type === 'product.changed' || event.type === 'location.changed') {
    return { actionType: 'evidence.recorded', actionRecordId: null, movementIds: [], skuIds: [] };
  }
  if (event.type === 'supplier_document.received') {
    return require('./email-ingestion').capture(db, auth, event);
  }
  if (event.type === 'reconciliation.summary') {
    return reconcile(db, auth, event);
  }
  throw new ValidationError(`No Foundry handler exists for ${event.type}.`);
}

function compareVersion(incoming, existing) {
  if (!incoming || !existing) return 0;
  const a = Number(incoming); const b = Number(existing);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(incoming).localeCompare(String(existing));
}

function reconcile(db, auth, event) {
  const expected = event.data.expected || {};
  const start = trimOrNull(event.data.periodStart);
  const end = trimOrNull(event.data.periodEnd);
  const params = [auth.workspaceId, auth.connectorId];
  let time = '';
  if (start) { time += ' AND occurred_at >= ?'; params.push(start); }
  if (end) { time += ' AND occurred_at <= ?'; params.push(end); }
  const rows = db.prepare(`SELECT event_type, COUNT(*) AS events FROM connector_feed_events
    WHERE workspace_id = ? AND connector_id = ? AND status = 'COMPLETED'${time} GROUP BY event_type`).all(...params);
  const observed = Object.fromEntries(rows.map((row) => [row.event_type, row.events]));
  const discrepancies = Object.entries(expected).filter(([key, value]) => Number(observed[key] || 0) !== Number(value))
    .map(([key, value]) => ({ type: key, expected: Number(value), observed: Number(observed[key] || 0) }));
  const id = newId('crecon');
  db.prepare(`INSERT INTO connection_reconciliations
    (id, workspace_id, connector_id, period_start, period_end, expected, observed, discrepancies, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, auth.workspaceId, auth.connectorId, start, end, JSON.stringify(expected), JSON.stringify(observed),
      JSON.stringify(discrepancies), discrepancies.length ? 'MISMATCH' : 'MATCHED', nowIso());
  if (discrepancies.length) connections.issue(db, { workspaceId: auth.workspaceId, connectorId: auth.connectorId,
    externalEventId: event.eventId, issueType: 'RECONCILIATION_MISMATCH', fingerprint: `reconciliation:${auth.connectorId}:${id}`,
    title: `${auth.displayName} does not match Foundry's event history`,
    detail: discrepancies.map((d) => `${d.type}: external ${d.expected}, Foundry ${d.observed}`).join('; '),
    resolutionHint: 'Review the missing or duplicated external records. Foundry has not overwritten inventory.' });
  return { actionType: 'reconciliation', actionRecordId: id, movementIds: [], skuIds: [] };
}

function recordMappingIssue(db, auth, event, error) {
  const type = `UNKNOWN_${error.entityType.toUpperCase()}`;
  connections.issue(db, { workspaceId: auth.workspaceId, connectorId: auth.connectorId,
    externalEventId: event.eventId, issueType: type,
    fingerprint: `${type}:${auth.connectorId}:${error.externalId}`,
    title: `Unknown ${error.entityType} from ${auth.displayName}`,
    detail: `I received ${event.type} for ${error.externalId}, but cannot safely match it to this inventory.`,
    resolutionHint: 'Choose the matching Foundry record once. Foundry will remember it and retry this event.',
    candidates: error.candidates });
}

function eventResult(row, replayed = false) {
  return { accepted: row.status === 'COMPLETED', replayed, eventId: row.external_event_id,
    type: row.event_type, status: row.status, movementIds: json(row.movement_ids, []), error: row.error_message,
    actionType: row.action_type, actionRecordId: row.action_record_id };
}

function ingest(db, auth, raw) {
  const event = normalize(raw);
  const payloadHash = hashPayload(raw);
  let existing = db.prepare(`SELECT * FROM connector_feed_events
    WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?`)
    .get(auth.workspaceId, auth.connectorId, event.eventId);
  if (existing && existing.status === 'COMPLETED') {
    if (existing.payload_hash && existing.payload_hash !== payloadHash) {
      connections.issue(db, { workspaceId: auth.workspaceId, connectorId: auth.connectorId,
        externalEventId: event.eventId, issueType: 'CONFLICTING_EVENT',
        fingerprint: `conflicting-event:${auth.connectorId}:${event.eventId}`,
        title: `Conflicting replay from ${auth.displayName}`,
        detail: `External event ${event.eventId} was replayed with different content. The first completed action remains authoritative.`,
        resolutionHint: 'Inspect the provider event history; Foundry did not apply the changed replay.' });
    }
    return eventResult(existing, true);
  }

  if (event.aggregateKey) {
    const newer = db.prepare(`SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ?
      AND aggregate_key = ? AND status = 'COMPLETED' ORDER BY processed_at DESC LIMIT 1`)
      .get(auth.workspaceId, auth.connectorId, event.aggregateKey);
    const staleVersion = newer && event.version && newer.external_version && compareVersion(event.version, newer.external_version) < 0;
    const staleTime = newer && !event.version && event.occurredAt && newer.occurred_at && Date.parse(event.occurredAt) < Date.parse(newer.occurred_at);
    if (staleVersion || staleTime) {
      const now = nowIso();
      if (!existing) db.prepare(`INSERT INTO connector_feed_events
        (id, workspace_id, connector_id, external_event_id, event_type, payload, status, movement_ids,
         error_message, occurred_at, received_at, processed_at, external_version, payload_hash,
         normalized_payload, aggregate_key, last_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, 'STALE', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('cfe'), auth.workspaceId, auth.connectorId, event.eventId, event.type, JSON.stringify(raw),
          'A newer external state was already processed.', event.occurredAt, now, now, event.version, payloadHash,
          JSON.stringify(event), event.aggregateKey, now);
      return eventResult(db.prepare('SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?')
        .get(auth.workspaceId, auth.connectorId, event.eventId));
    }
  }

  const receivedAt = existing ? existing.received_at : nowIso();
  try {
    const outcome = inTransaction(db, () => {
      existing = db.prepare(`SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?`)
        .get(auth.workspaceId, auth.connectorId, event.eventId);
      if (existing && existing.status === 'COMPLETED') return { replay: existing };
      const applied = apply(db, auth, event);
      const now = nowIso();
      if (existing) {
        db.prepare(`UPDATE connector_feed_events SET event_type = ?, payload = ?, status = 'COMPLETED',
          movement_ids = ?, error_message = NULL, occurred_at = ?, processed_at = ?, external_version = ?,
          payload_hash = ?, normalized_payload = ?, attempt_count = attempt_count + 1, action_type = ?,
          action_record_id = ?, aggregate_key = ?, last_attempt_at = ? WHERE id = ?`)
          .run(event.type, JSON.stringify(raw), JSON.stringify(applied.movementIds || []), event.occurredAt, now,
            event.version, payloadHash, JSON.stringify(event), applied.actionType, applied.actionRecordId,
            event.aggregateKey, now, existing.id);
      } else {
        db.prepare(`INSERT INTO connector_feed_events
          (id, workspace_id, connector_id, external_event_id, event_type, payload, status, movement_ids,
           occurred_at, received_at, processed_at, external_version, payload_hash, normalized_payload,
           action_type, action_record_id, aggregate_key, last_attempt_at)
          VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId('cfe'), auth.workspaceId, auth.connectorId, event.eventId, event.type, JSON.stringify(raw),
            JSON.stringify(applied.movementIds || []), event.occurredAt, receivedAt, now, event.version,
            payloadHash, JSON.stringify(event), applied.actionType, applied.actionRecordId, event.aggregateKey, now);
      }
      db.prepare(`UPDATE workspace_connectors SET last_synced_at = ?, last_activity_at = ?, last_error = NULL,
        status = 'connected', updated_at = ? WHERE workspace_id = ? AND id = ?`)
        .run(now, now, now, auth.workspaceId, auth.connectorId);
      db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
        WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?
          AND status = 'OPEN' AND issue_type = 'EVENT_FAILED'`)
        .run(now, now, auth.workspaceId, auth.connectorId, event.eventId);
      db.prepare(`UPDATE connection_issues SET status = 'RESOLVED', resolved_at = ?, updated_at = ?
        WHERE workspace_id = ? AND connector_id = ? AND status = 'OPEN' AND issue_type = 'CONNECTION_STALE'`)
        .run(now, now, auth.workspaceId, auth.connectorId);
      return { applied };
    });
    if (outcome.replay) return eventResult(outcome.replay, true);
    if (outcome.applied.skuIds.length) reevaluate.afterMovement(db, auth.workspaceId, outcome.applied.skuIds,
      `external:${event.type}`);
    return eventResult(db.prepare('SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?')
      .get(auth.workspaceId, auth.connectorId, event.eventId));
  } catch (error) {
    const now = nowIso();
    const status = error instanceof MappingRequired ? 'NEEDS_MAPPING' : 'FAILED';
    if (error instanceof MappingRequired) recordMappingIssue(db, auth, event, error);
    else connections.issue(db, { workspaceId: auth.workspaceId, connectorId: auth.connectorId,
      externalEventId: event.eventId, issueType: 'EVENT_FAILED', fingerprint: `event-failed:${auth.connectorId}:${event.eventId}`,
      title: `${auth.displayName} event could not be recorded`, detail: error.message,
      resolutionHint: 'Correct the external data or its mapping, then retry the event.' });
    inTransaction(db, () => {
      if (existing) db.prepare(`UPDATE connector_feed_events SET status = ?, error_message = ?, payload = ?,
        normalized_payload = ?, payload_hash = ?, attempt_count = attempt_count + 1, processed_at = ?,
        last_attempt_at = ?, external_version = ?, aggregate_key = ? WHERE id = ?`)
        .run(status, error.message, JSON.stringify(raw), JSON.stringify(event), payloadHash, now, now,
          event.version, event.aggregateKey, existing.id);
      else db.prepare(`INSERT INTO connector_feed_events
        (id, workspace_id, connector_id, external_event_id, event_type, payload, status, movement_ids,
         error_message, occurred_at, received_at, processed_at, external_version, payload_hash,
         normalized_payload, aggregate_key, last_attempt_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId('cfe'), auth.workspaceId, auth.connectorId, event.eventId, event.type, JSON.stringify(raw),
          status, error.message, event.occurredAt, receivedAt, now, event.version, payloadHash,
          JSON.stringify(event), event.aggregateKey, now);
      db.prepare('UPDATE workspace_connectors SET last_error = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
        .run(error.message, now, auth.workspaceId, auth.connectorId);
    });
    return eventResult(db.prepare('SELECT * FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ? AND external_event_id = ?')
      .get(auth.workspaceId, auth.connectorId, event.eventId));
  }
}

function ingestBatch(db, auth, body) {
  const entries = Array.isArray(body && body.events) ? body.events : [body];
  if (!entries.length) throw new ValidationError('Send at least one event.');
  if (entries.length > MAX_BATCH) throw new ValidationError(`Send at most ${MAX_BATCH} events at once.`);
  const results = entries.map((entry) => ingest(db, auth, entry));
  // A provider may deliver fulfillment before the order it refers to. Once an
  // order-created event establishes the durable order mapping, retry waiting
  // events immediately; no button or integration-specific workflow is needed.
  const retried = results.some((row) => row.accepted && row.type === 'sales_order.created')
    ? retryPending(db, auth, { limit: MAX_BATCH })
    : [];
  return { accepted: results.filter((r) => r.accepted && !r.replayed).length,
    replayed: results.filter((r) => r.replayed).length,
    needsMapping: results.filter((r) => r.status === 'NEEDS_MAPPING').length,
    failed: results.filter((r) => ['FAILED', 'STALE'].includes(r.status)).length,
    retried: retried.filter((r) => r.accepted).length,
    results };
}

function retryPending(db, auth, options = {}) {
  const rows = db.prepare(`SELECT payload FROM connector_feed_events WHERE workspace_id = ? AND connector_id = ?
    AND status IN ('NEEDS_MAPPING','FAILED') ORDER BY received_at LIMIT ?`)
    .all(auth.workspaceId, auth.connectorId, Math.min(Number(options.limit) || 100, 500));
  return rows.map((row) => ingest(db, auth, json(row.payload, {})));
}

module.exports = { MAX_BATCH, TYPES, MappingRequired, normalize, ingest, ingestBatch, retryPending };
