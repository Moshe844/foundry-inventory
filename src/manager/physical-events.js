'use strict';

const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const investigations = require('./investigations');
const { createProviderForTier } = require('../ai/provider');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');

function record(db, ctx, input) {
  const statedAs = requireText(input.statedAs, 'What happened', { max: 1200 });
  const type = String(input.eventType || '').trim().toLowerCase();
  if (!['physical_count', 'shipment_arrived', 'damage', 'return', 'found_stock', 'reported_event'].includes(type)) {
    throw new ValidationError('Foundry needs to know whether this was a count, delivery, damage, return, or found stock.');
  }
  const id = newId('phe');
  const now = nowIso();
  let status = 'RECEIVED';
  let matched = input.matchedEntities || {};
  let investigationId = null;

  if (type === 'physical_count' && input.skuId && input.locationId && input.countedQuantity !== undefined) {
    const result = investigations.openPhysicalCount(db, ctx, {
      skuId: input.skuId, locationId: input.locationId, countedQuantity: input.countedQuantity,
      displayName: input.displayName, idempotencyKey: `physical-event:${input.idempotencyKey || id}`,
    });
    const investigated = investigations.investigate(db, ctx.workspaceId, result.investigation.investigationId);
    investigationId = investigated.investigationId;
    matched = investigated.affectedEntities;
    status = investigated.status === 'RESOLVED' ? 'COMPLETED' : 'NEEDS_HUMAN';
  } else if (type === 'shipment_arrived') {
    const requestedOrderId = input.purchaseOrderId || (matched && matched.purchaseOrderId);
    const candidates = requestedOrderId
      ? db.prepare(`SELECT id, po_number FROM purchase_orders WHERE workspace_id = ? AND id = ?
          AND status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')`).all(ctx.workspaceId, requestedOrderId)
      : db.prepare(`SELECT id, po_number FROM purchase_orders WHERE workspace_id = ?
          AND status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED') ORDER BY expected_date, created_at LIMIT 10`).all(ctx.workspaceId);
    if (candidates.length === 1) {
      matched = { ...matched, purchaseOrderId: candidates[0].id, poNumber: candidates[0].po_number };
      status = 'ROUTED';
    } else status = 'NEEDS_HUMAN';
  } else status = 'NEEDS_HUMAN';

  db.prepare(
    `INSERT INTO physical_events
       (id, workspace_id, reported_by_user_id, event_type, stated_as, details, attachment_name,
        attachment_mime, attachment_content, matched_entities, confidence, status, investigation_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.workspaceId, ctx.actorId, type, statedAs, JSON.stringify(input.details || {}),
    input.attachmentName || null, input.attachmentMime || null, input.attachmentBuffer || null,
    JSON.stringify(matched), status === 'ROUTED' ? 'high' : 'low',
    status, investigationId, now, now);
  return get(db, ctx.workspaceId, id);
}

/**
 * What actually happened to a reported event, in words, and where to send the
 * person next.
 *
 * The route used to say one of two things: matched to an order, or "recorded
 * the physical event and put the unresolved part in Needs you". That second
 * sentence was printed for every other outcome including the happiest one — a
 * count that agreed with the records. It claimed an exception existed, sent the
 * person to Needs you to find it, and Needs you correctly showed nothing there.
 *
 * A count that reconciles is a real result and worth saying plainly, with the
 * figure it was checked against, because "no change was needed" is only
 * reassuring if you can see what it was compared with.
 */
function describeOutcome(db, workspaceId, event) {
  const entities = event.matchedEntities || {};
  const subject = entities.displayName || 'that product';

  if (event.status === 'ROUTED' && entities.purchaseOrderId) {
    return {
      message: 'Foundry matched that event. Check the receiving details before stock changes.',
      redirectTo: `/purchasing/orders/${entities.purchaseOrderId}`,
    };
  }

  if (event.status === 'COMPLETED') {
    const investigation = event.investigationId
      ? db
          .prepare('SELECT observed_difference FROM inventory_investigations WHERE id = ? AND workspace_id = ?')
          .get(event.investigationId, workspaceId)
      : null;
    let counted = null;
    try {
      counted = investigation ? JSON.parse(investigation.observed_difference || '{}') : null;
    } catch {
      counted = null;
    }
    const message = counted && Number.isFinite(Number(counted.expected))
      ? `Count recorded. Foundry compared it with the recorded ${counted.expected} `
        + `${counted.expected === 1 ? 'unit' : 'units'} of ${subject} and they match — `
        + 'no inventory change was needed.'
      : 'Count recorded. It agrees with what Foundry already had, so nothing needed changing.';
    return {
      message,
      redirectTo: entities.itemId ? `/inventory/${entities.itemId}` : '/',
    };
  }

  if (event.investigationId) {
    return {
      message: `Count recorded. It does not match what Foundry has for ${subject}, `
        + 'so the difference is in Needs you with the evidence behind it.',
      redirectTo: '/needs-you',
    };
  }

  return {
    message: 'Foundry recorded what you said but could not place it on its own. '
      + 'It is in Needs you with what it still needs.',
    redirectTo: '/needs-you',
  };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM physical_events WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) return null;
  return { id: row.id, eventType: row.event_type, statedAs: row.stated_as, details: JSON.parse(row.details),
    matchedEntities: JSON.parse(row.matched_entities), status: row.status, investigationId: row.investigation_id,
    attachmentName: row.attachment_name, attachmentMime: row.attachment_mime, confidence: row.confidence,
    createdAt: row.created_at };
}

function complete(db, workspaceId, id, workItemId = null) {
  const event = get(db, workspaceId, id);
  if (!event) return null;
  db.prepare(`UPDATE physical_events SET status = 'COMPLETED', work_item_id = COALESCE(?, work_item_id),
    updated_at = ? WHERE id = ? AND workspace_id = ?`).run(workItemId, nowIso(), id, workspaceId);
  return get(db, workspaceId, id);
}

function words(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function statedEventType(statedAs) {
  if (/\b(count|counted|physical count)\b/i.test(statedAs)) return 'physical_count';
  if (/\b(shipment|delivery|parcel|order)\b.*\b(arrived|received|here)\b|\barrived\b.*\b(shipment|delivery|order)\b/i.test(statedAs)) return 'shipment_arrived';
  if (/\b(damage|damaged|broken|spoiled)\b/i.test(statedAs)) return 'damage';
  if (/\b(return|returned)\b/i.test(statedAs)) return 'return';
  if (/\b(found|discovered)\b.*\b(stock|inventory|units?|items?)\b/i.test(statedAs)) return 'found_stock';
  return null;
}

function deterministicNatural(statedAs, skus, locations) {
  const eventType = statedEventType(statedAs);
  if (!eventType) return null;
  if (eventType !== 'physical_count') return { eventType, skuId: '', locationId: '', countedQuantity: -1,
    reason: 'The event type is explicit in the operator’s words.' };

  const text = words(statedAs);
  const countMatch = statedAs.match(/\b(?:count(?:ed)?|physical count(?: is| of)?|there (?:are|is)|we have|i have)\s*(?:is|was|of|:|=)?\s*(\d+)\b/i);
  const countedQuantity = countMatch ? Number(countMatch[1]) : -1;
  const candidates = skus.filter((row) => {
    const name = words(row.name);
    const variant = words(row.variant_label);
    return name && text.includes(name) && (!variant || text.includes(variant));
  });
  const locationMatches = locations.filter((row) => text.includes(words(row.name)));
  return {
    eventType,
    skuId: candidates.length === 1 ? candidates[0].id : '',
    locationId: locationMatches.length === 1 ? locationMatches[0].id : '',
    countedQuantity,
    reason: candidates.length === 1 && locationMatches.length === 1 && countedQuantity >= 0
      ? 'The count, product and location are explicit in the operator’s words.'
      : 'The report is a count, but one or more inventory references remain ambiguous.',
  };
}

/**
 * Whole-word containment.
 *
 * Plain substring matching cannot be used to decide that a report names two
 * products: a size called "S" is inside almost every sentence ever written, and
 * a false match here would refuse a perfectly clear single count.
 */
function mentions(text, phrase) {
  const needle = words(phrase);
  if (!needle) return false;
  const haystack = ` ${text} `;
  return haystack.includes(` ${needle} `);
}

/** How many distinct products and locations this report actually names. */
function countMentions(statedAs, skus, locations) {
  const text = words(statedAs);
  const namedSkus = new Set();
  for (const row of skus) {
    if (!mentions(text, row.name)) continue;
    if (row.variant_label && !mentions(text, row.variant_label)) continue;
    namedSkus.add(row.id);
  }
  const namedLocations = new Set(
    locations.filter((row) => mentions(text, row.name)).map((row) => row.id)
  );
  return { skus: namedSkus.size, locations: namedLocations.size };
}

async function recordNatural(db, ctx, statedAs, options = {}) {
  const skus = db.prepare(`SELECT s.id, s.variant_label, i.name, i.unit_label FROM skus s
    JOIN items i ON i.id = s.item_id WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.variant_label LIMIT 500`).all(ctx.workspaceId);
  const locations = db.prepare(`SELECT id, name FROM locations WHERE workspace_id = ? AND is_active = 1
    ORDER BY name LIMIT 100`).all(ctx.workspaceId);
  const schema = {
    type: 'object', additionalProperties: false,
    required: ['eventType', 'skuId', 'locationId', 'countedQuantity', 'reason'],
    properties: {
      eventType: { type: 'string', enum: ['physical_count', 'shipment_arrived', 'damage', 'return', 'found_stock', 'reported_event'] },
      skuId: { type: 'string', enum: ['', ...skus.map((row) => row.id)] },
      locationId: { type: 'string', enum: ['', ...locations.map((row) => row.id)] },
      countedQuantity: { type: 'integer', minimum: -1 },
      reason: { type: 'string' },
    },
  };
  let parsed = deterministicNatural(statedAs, skus, locations);
  if (!parsed || (parsed.eventType === 'physical_count' &&
      (!parsed.skuId || !parsed.locationId || parsed.countedQuantity < 0))) {
    try {
      const provider = options.provider || createProviderForTier('fast');
      const response = await provider.complete({
        system: `Read one physical inventory event. Select only ids from the supplied records. Use an empty id when the words do not identify exactly one record. countedQuantity is the total physical count, not a change; use -1 when no total count was stated. Never infer a count.`,
        prompt: `Inventory records:\n${JSON.stringify({
          products: skus.map((row) => ({ skuId: row.id, name: row.name, variant: row.variant_label, unit: row.unit_label })),
          locations,
        })}\n\nReported event: ${statedAs}`,
        schema, schemaName: 'physical_inventory_event',
      });
      const result = validate(toWireSchema(schema), response.data, { key: 'physical-event-wire' });
      if (!result.ok) throw new ValidationError('Foundry could not safely identify the physical inventory event.');
      parsed = result.data;
    } catch {
      parsed = parsed || { eventType: 'reported_event', skuId: '', locationId: '', countedQuantity: -1,
        reason: 'Foundry kept the report for review because the model provider was unavailable.' };
    }
  }
  const sku = parsed.skuId ? skus.find((row) => row.id === parsed.skuId) : null;
  const location = parsed.locationId ? locations.find((row) => row.id === parsed.locationId) : null;

  // One report, one event — so a report that is plainly about more than one
  // position must not be recorded as though it were about the first of them.
  //
  // "40 of the 250g at the Roastery and 12 of the 1kg at the Warehouse" used to
  // become a single count of the 250g, with the second half of the sentence
  // dropped and nothing said about it. Recording half of what somebody told you
  // and reporting success is worse than recording none of it: they have no
  // reason to look again.
  const mentioned = countMentions(statedAs, skus, locations);
  if (parsed.eventType === 'physical_count' && (mentioned.skus > 1 || mentioned.locations > 1)) {
    return record(db, ctx, {
      eventType: 'reported_event',
      statedAs,
      details: {
        interpreted: parsed,
        interpretationReason:
          `This report names ${mentioned.skus} products across ${mentioned.locations} locations. ` +
          'Foundry records one count at a time and will not record part of a report as if it were all of it. ' +
          'Tell it one product and location at a time, or use a count sheet.',
        unresolvedMultiplePositions: true,
      },
    });
  }

  return record(db, ctx, {
    eventType: parsed.eventType,
    statedAs,
    skuId: sku && sku.id,
    locationId: location && location.id,
    countedQuantity: parsed.countedQuantity >= 0 ? parsed.countedQuantity : undefined,
    displayName: sku ? [sku.name, sku.variant_label].filter(Boolean).join(' / ') : null,
    details: { interpreted: parsed, interpretationReason: parsed.reason },
  });
}

module.exports = { record, get, complete, recordNatural, describeOutcome };
