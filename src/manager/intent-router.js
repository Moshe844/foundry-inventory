'use strict';

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { newId, nowIso, requireText } = require('../lib/util');
const managerContext = require('./context');
const capabilityPlanner = require('./capability-planner');
const capabilityRegistry = require('./capability-registry');

const INTENT_CLASSES = [
  'QUESTION', 'INVENTORY_ACTION', 'CATALOG_CHANGE', 'IMPORT', 'PHYSICAL_EVENT',
  'PURCHASING_REQUEST', 'SALES_ORDER', 'POLICY_CHANGE', 'INVESTIGATION_REQUEST',
  'OPERATING_INSTRUCTION', 'CONFIGURATION_CHANGE', 'EXPLANATION', 'STOP', 'UNKNOWN',
];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['intentClass', 'confidence', 'reason', 'resolvedReference', 'clarifyingQuestion'],
  properties: {
    intentClass: { type: 'string', enum: INTENT_CLASSES },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    reason: { type: 'string' },
    resolvedReference: { type: 'string' },
    clarifyingQuestion: { type: 'string' },
  },
};

const SYSTEM = `Classify one message to an AI inventory manager. Return only the structured result.

QUESTION asks about current inventory or how the system works.
INVENTORY_ACTION asks for or reports an ordinary stock movement that should be
recorded: receiving stock, selling/using/issuing stock, transferring it between
locations, or correcting the ledger. Past-tense reports such as "I sold 2",
"we received 5" and "we moved 3" are INVENTORY_ACTION, not UNKNOWN.
CATALOG_CHANGE adds or changes products, variants or locations.
IMPORT asks to load data from a file or another system.
PHYSICAL_EVENT reports something that happened in the physical world: a count, delivery, damage, return or found stock.
PURCHASING_REQUEST asks to buy, reorder or manage a purchase order.
POLICY_CHANGE changes what Foundry may do automatically or its limits.
OPERATING_INSTRUCTION teaches a lasting inventory rule: reorder/target/safety levels, location floors,
supplier assignment or terms, transfer-before-buying, lead time, MOQ, packs, cooldowns, or approval requirements.
INVESTIGATION_REQUEST asks why records differ or asks Foundry to investigate.
CONFIGURATION_CHANGE changes terminology or inventory configuration, including mapping a vendor's product code to the customer's own internal code.
EXPLANATION asks why Foundry did, did not do, or recommends something.
STOP is only for a message whose whole point is that Foundry should stop, pause or hold off acting
on its own: "stop", "stop doing that", "pause", "hold off", "don't do anything for now". A message
that asks for work to be done — ordering, moving, counting, receiving — is never STOP, however
urgent it sounds.
UNKNOWN only when none fits.

Use the supplied durable context to understand short follow-ups such as "approve it" or "what about that one".
Set resolvedReference to a real id from context only when exactly one referenced record is clear. Never invent an id.
If more than one record could be meant, use the most fitting intent class, low confidence, and ask one concise clarifying question.`;

function fallbackClassify(message) {
  // Obvious operational language does not need a probabilistic classifier.
  // This keeps the primary manager input useful during a provider outage while
  // still refusing to guess at an ambiguous consequential request.
  const clean = message.trim();
  const result = (intentClass, reason) => ({ intentClass, confidence: 'high', reason,
    resolvedReference: '', clarifyingQuestion: '' });
  // "Stop." is the one instruction that must never be misread, deferred or
  // quietly dropped. It is checked before anything else, and matched on the
  // plain words people actually use rather than on the word "policy".
  if (/^\s*(?:stop|halt|pause|freeze)\b|\b(?:stop|pause|halt)\s+(?:doing|what|that|it|everything|for now)\b|\bdon'?t do (?:that|anything)\b|\bhold off\b/i.test(clean)) {
    return result('STOP', 'This asks Foundry to stop acting on its own.');
  }
  if (/\b(handle everything|automatically|autopilot|may (?:approve|move|order)|never (?:approve|move|order)|policy|authority|limit)\b/i.test(clean)) {
    return result('POLICY_CHANGE', 'This explicitly changes what Foundry may do or its limits.');
  }
  if (/(?:\breorder\b.*\b(?:at|below|when|to)\b)|\b(restock(?:ing)?|replenish(?:ment|ing)?|stock (?:level|reaches)|order[- ]?up[- ]?to|safety stock|keep(?: at least)?|never let|days? of stock|lead time|minimum order|moq|purchase unit|order multiple|preferred supplier|use .+ for|transfer before (?:buying|purchasing)|cooldown)\b/i.test(clean)) {
    return result('OPERATING_INSTRUCTION', 'This teaches a lasting inventory operating rule.');
  }
  if (/^\s*order\b|\b(order what|what should (?:i|we) order|buy|purchase|reorder|purchase order|supplier order)\b/i.test(clean)) {
    return result('PURCHASING_REQUEST', 'This explicitly asks about purchasing or replenishment.');
  }
  // "Set ... to 60 after a physical count" is a complete correction command,
  // not merely a report that a count happened. Route it to the controlled
  // action preview immediately so it cannot stall behind a second provider
  // call before the deterministic action parser sees it.
  if (/^\s*(?:set|correct|adjust)\b.+\bto\s+\d+\b.+\bphysical count\b/i.test(clean)) {
    return result('INVENTORY_ACTION', 'This explicitly asks Foundry to correct a recorded count from physical evidence.');
  }
  if (/\b(physical count|counted|i count|we count|shipment arrived|delivery arrived|arrived damaged|damaged|returned|found stock)\b/i.test(clean)) {
    return result('PHYSICAL_EVENT', 'This explicitly reports something that happened to physical inventory.');
  }
  if (/\b(investigate|discrepancy|doesn'?t match|do not match|records? (?:is|are) (?:wrong|off)|why (?:is|are).*(?:off|different))\b/i.test(clean)) {
    return result('INVESTIGATION_REQUEST', 'This explicitly asks Foundry to investigate a mismatch.');
  }
  if (/\b(delete|remove|undo|roll\s*back|take\s+out)\b/i.test(clean) &&
      /\b(items?|products?|records?|inventory|stock)\b/i.test(clean) &&
      /\b(pdf|document|file|sheet|spreadsheet|upload|import)\b/i.test(clean)) {
    return result('CATALOG_CHANGE', 'This asks to remove products created by an earlier stored document.');
  }
  if (/\b(replace|change|rewrite|rename|swap|convert)\b/i.test(clean) &&
      /\b(code|codes|sku|skus|identifier|identifiers)\b/i.test(clean) &&
      /\b(?:from\s+\S+\s+(?:to|with)|prefix\s+\S+\s+(?:to|with))\b/i.test(clean)) {
    return result('CATALOG_CHANGE', 'This changes existing internal catalogue identifiers.');
  }
  if (/\b(import|upload|spreadsheet|csv|excel|pdf|document|file)\b/i.test(clean)) {
    return result('IMPORT', 'This explicitly asks Foundry to read or import a source.');
  }
  if (/(?:change|map|rename|replace)\s+(?:the\s+)?(?:vendor|supplier)(?:'s)?\s+(?:code|sku)\b/i.test(clean) ||
      /(?:vendor|supplier)\s+(?:code|sku)\s+[A-Za-z0-9][A-Za-z0-9._/-]*\s*,?\s*(?:use|make it|call it)\b/i.test(clean)) {
    return result('CONFIGURATION_CHANGE', 'This maps a vendor product identifier to the customer\'s own internal code.');
  }
  if (/\b(add|create|rename|archive|remove|delete)\b.*\b(product|item|sku|variant|location|warehouse|inventory)\b/i.test(clean)) {
    return result('CATALOG_CHANGE', 'This explicitly changes the inventory catalogue.');
  }
  // Normal inventory work is most often reported after it happens. The older
  // fallback recognised only command-form verbs ("issue", "move", "receive")
  // and missed the ordinary sentences shown by Foundry itself: "I sold...",
  // "we received..." and "we moved...". That made a complete transaction
  // depend on a probabilistic top-level classifier and, when it answered
  // UNKNOWN, produced the meaningless "what would you like Foundry to do?"
  // question. This is grammar-level routing only: product, variant, quantity
  // and location are still resolved by the normal grounded action pipeline.
  if (/\b(?:customer|client|school|company)\b.*\b(?:ordered|cancelled|canceled)\b|\badd\b.*\bto\b.*\border\b|\b(?:ship|fulfill)\b.*\b(?:order|customer)\b|\b(?:complete|finish)\b.*\b(?:(?:sales|customer)\s+)?order\b|\b(?:sales order|backorder|waiting for stock)\b/i.test(clean)) {
    return result('SALES_ORDER', 'This creates, changes, fulfills, cancels or inspects committed customer demand.');
  }
  const actorReportedMovement =
    /\b(?:i|we)\s+(?:sold|used(?!\s+to\b)|consumed|shipped|dispatched|delivered|scrapped|discarded|issued|received|moved|transferred|corrected|adjusted)\b/i;
  const directReportedMovement =
    /^\s*(?:sold|used|consumed|shipped|dispatched|delivered|scrapped|discarded|issued|received|moved|transferred|corrected|adjusted)\b/i;
  const passiveSale =
    /\b(?:customer|customers|client|clients)\s+(?:bought|purchased)\b|\b(?:record|log)\s+(?:a\s+)?sale\b/i;
  const stockCameIn = /\b(?:stock|inventory|units?|items?|products?|goods|delivery|shipment)\b.*\b(?:came|come)\s+in\b/i;
  if (actorReportedMovement.test(clean) || directReportedMovement.test(clean)
      || passiveSale.test(clean) || stockCameIn.test(clean)) {
    return result('INVENTORY_ACTION', 'This reports an ordinary inventory movement to record.');
  }
  if (/\b(receive|issue|move|transfer|adjust|correct|set)\b.*\b(stock|inventory|units?|items?|sku|warehouse|location)\b/i.test(clean)) {
    return result('INVENTORY_ACTION', 'This explicitly asks for an inventory movement or correction.');
  }
  if (/\bwhy did (?:foundry|you)|why (?:was|wasn'?t|didn'?t)\b/i.test(clean)) {
    return result('EXPLANATION', 'This asks Foundry to explain a recorded decision.');
  }
  if (!/\b(?:that|it|this one|that one)\b/i.test(clean) &&
      (/\?$|^(?:what|where|when|which|who|how|show|tell me)\b/i.test(clean))) {
    return result('QUESTION', 'This is an inventory question.');
  }
  return { intentClass: 'UNKNOWN', confidence: 'low',
    reason: 'The request is ambiguous and Foundry will not guess.', resolvedReference: '',
    clarifyingQuestion: 'What would you like Foundry to do with the inventory?' };
}

async function classify(db, ctx, message, options = {}) {
  const clean = requireText(message, 'Message', { max: 1200 });
  const state = managerContext.snapshot(db, ctx);
  let data;
  const deterministic = fallbackClassify(clean);
  // Only transaction grammar and an explicit pause bypass the semantic
  // planner. They are closed, safety-sensitive forms whose meaning is already
  // complete ("we sold...", "I counted...", "pause"). Everything else is
  // planned by business capability first, even if the old keyword classifier
  // has a guess. That is what prevents a new phrasing from needing a new route
  // patch. The keyword classifier remains an offline fallback, not the product
  // intelligence layer.
  const wholeSalesOrderCompletion = deterministic.intentClass === 'SALES_ORDER'
    && (/\b(?:complete|finish|fulfill|ship)\b[^.?!]*\b(?:(?:sales|customer)\s+)?order\b/i.test(clean)
      || /\b(?:(?:sales|customer)\s+)?order\b[^.?!]*\b(?:complete|finished|fulfilled|shipped)\b/i.test(clean));
  const safeFastPath = ['INVENTORY_ACTION', 'PHYSICAL_EVENT', 'PURCHASING_REQUEST', 'STOP'].includes(deterministic.intentClass)
    || wholeSalesOrderCompletion;
  if (safeFastPath) data = deterministic;
  else if (options.provider || config.ai.configured) {
    try {
      data = await capabilityPlanner.plan(db, ctx, clean, {
        provider: options.provider || createProviderForTier('fast'),
      });
    } catch {
      data = deterministic;
    }
  } else data = deterministic;

  if (!INTENT_CLASSES.includes(data.intentClass)) data.intentClass = 'UNKNOWN';
  data.capabilityId = data.capabilityId || capabilityRegistry.defaultForIntent(data.intentClass);
  data.parameters = data.parameters || { fromText: '', toText: '', transformMode: '', documentReference: '' };
  data.handler = (capabilityRegistry.get(data.capabilityId) || {}).handler || '';
  if (data.resolvedReference) {
    const known = new Set([
      state.conversation.lastWorkItemId, state.conversation.lastPurchaseOrderId,
      state.conversation.lastInvestigationId, ...state.openWork.map((item) => item.id),
      ...state.openInvestigations.map((item) => item.id),
    ].filter(Boolean));
    if (!known.has(data.resolvedReference)) data.resolvedReference = '';
  }
  const id = newId('mint');
  const now = nowIso();
  db.prepare(
    `INSERT INTO manager_intents
       (id, workspace_id, user_id, stated_as, intent_class, payload, confidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, ctx.workspaceId, ctx.actorId, clean, data.intentClass,
    JSON.stringify({ reason: data.reason, capabilityId: data.capabilityId, goal: data.goal || clean,
      parameters: data.parameters, resolvedReference: data.resolvedReference,
      clarifyingQuestion: data.clarifyingQuestion }),
    data.confidence, data.clarifyingQuestion ? 'NEEDS_CLARIFICATION' : 'CLASSIFIED', now, now);
  managerContext.remember(db, ctx, { intentClass: data.intentClass, turn: { role: 'user', text: clean, intentClass: data.intentClass, at: now } });
  return { id, ...data };
}

function markRouted(db, ctx, id, routedTo, relatedRecordId = null, status = 'ROUTED') {
  db.prepare(
    `UPDATE manager_intents SET status = ?, routed_to = ?, related_record_id = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND user_id = ?`
  ).run(status, routedTo, relatedRecordId, nowIso(), id, ctx.workspaceId, ctx.actorId);
}

module.exports = { INTENT_CLASSES, SCHEMA, SYSTEM, fallbackClassify, classify, markRouted };
