'use strict';

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema } = require('../foundry/schema-tools');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const managerContext = require('./context');

const INTENT_CLASSES = [
  'QUESTION', 'INVENTORY_ACTION', 'CATALOG_CHANGE', 'IMPORT', 'PHYSICAL_EVENT',
  'PURCHASING_REQUEST', 'POLICY_CHANGE', 'INVESTIGATION_REQUEST',
  'CONFIGURATION_CHANGE', 'EXPLANATION', 'STOP', 'UNKNOWN',
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
INVENTORY_ACTION asks to receive, issue, transfer or correct stock.
CATALOG_CHANGE adds or changes products, variants or locations.
IMPORT asks to load data from a file or another system.
PHYSICAL_EVENT reports something that happened in the physical world: a count, delivery, damage, return or found stock.
PURCHASING_REQUEST asks to buy, reorder or manage a purchase order.
POLICY_CHANGE changes what Foundry may do automatically or its limits.
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
  if (/\b(order what|what should (?:i|we) order|buy|purchase|reorder|purchase order|supplier order)\b/i.test(clean)) {
    return result('PURCHASING_REQUEST', 'This explicitly asks about purchasing or replenishment.');
  }
  if (/\b(physical count|counted|i count|we count|shipment arrived|delivery arrived|arrived damaged|damaged|returned|found stock)\b/i.test(clean)) {
    return result('PHYSICAL_EVENT', 'This explicitly reports something that happened to physical inventory.');
  }
  if (/\b(investigate|discrepancy|doesn'?t match|do not match|records? (?:is|are) (?:wrong|off)|why (?:is|are).*(?:off|different))\b/i.test(clean)) {
    return result('INVESTIGATION_REQUEST', 'This explicitly asks Foundry to investigate a mismatch.');
  }
  if (/\b(import|upload|spreadsheet|csv|excel|pdf|document|file)\b/i.test(clean)) {
    return result('IMPORT', 'This explicitly asks Foundry to read or import a source.');
  }
  if (/(?:change|map|rename|replace)\s+(?:the\s+)?(?:vendor|supplier)(?:'s)?\s+(?:code|sku)\b/i.test(clean) ||
      /(?:vendor|supplier)\s+(?:code|sku)\s+[A-Za-z0-9][A-Za-z0-9._/-]*\s*,?\s*(?:use|make it|call it)\b/i.test(clean)) {
    return result('CONFIGURATION_CHANGE', 'This maps a vendor product identifier to the customer\'s own internal code.');
  }
  if (/\b(add|create|rename|archive)\b.*\b(product|item|sku|variant|location|warehouse)\b/i.test(clean)) {
    return result('CATALOG_CHANGE', 'This explicitly changes the inventory catalogue.');
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
  if (deterministic.intentClass !== 'UNKNOWN') data = deterministic;
  else if (options.provider || config.ai.configured) {
    const provider = options.provider || createProviderForTier('fast');
    try {
      const response = await provider.complete({
        system: SYSTEM,
        prompt: `Durable context:\n${JSON.stringify(state)}\n\nMessage: ${clean}`,
        schema: SCHEMA,
        schemaName: 'manager_intent',
      });
      const result = validate(toWireSchema(SCHEMA), response.data, { key: 'manager-intent-wire' });
      if (!result.ok) throw new ValidationError('Foundry could not reliably understand that request.');
      data = result.data;
    } catch {
      data = deterministic;
    }
  } else data = deterministic;

  if (!INTENT_CLASSES.includes(data.intentClass)) data.intentClass = 'UNKNOWN';
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
    JSON.stringify({ reason: data.reason, resolvedReference: data.resolvedReference, clarifyingQuestion: data.clarifyingQuestion }),
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
