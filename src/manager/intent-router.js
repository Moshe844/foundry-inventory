'use strict';

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { newId, nowIso, requireText } = require('../lib/util');
const managerContext = require('./context');
const capabilityPlanner = require('./capability-planner');
const capabilityRegistry = require('./capability-registry');
const removals = require('../actions/removals');

const INTENT_CLASSES = [
  'QUESTION', 'INVENTORY_ACTION', 'CATALOG_CHANGE', 'IMPORT', 'PHYSICAL_EVENT',
  'PURCHASING_REQUEST', 'SALES_ORDER', 'POLICY_CHANGE', 'INVESTIGATION_REQUEST',
  'OPERATING_INSTRUCTION', 'CONFIGURATION_CHANGE', 'EXPLANATION', 'PAYMENT_REPORT',
  'STOP', 'UNKNOWN',
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
POLICY_CHANGE changes what StockChief may do automatically or its limits.
OPERATING_INSTRUCTION teaches a lasting inventory rule: reorder/target/safety levels, location floors,
supplier assignment or terms, transfer-before-buying, lead time, MOQ, packs, cooldowns, or approval requirements.
INVESTIGATION_REQUEST asks why records differ or asks StockChief to investigate.
CONFIGURATION_CHANGE changes terminology or inventory configuration, including mapping a vendor's product code to the customer's own internal code.
EXPLANATION asks why StockChief did, did not do, or recommends something.
PAYMENT_REPORT reports money that has already moved, in either direction: "I paid
ABC $400 toward invoice 8832", "ABC School paid us $500 by cheque". It is a report of
a completed payment, never a request for StockChief to pay anyone — StockChief does not
move money.

STOP is only for a message whose whole point is that StockChief should stop, pause or hold off acting
on its own: "stop", "stop doing that", "pause", "hold off", "don't do anything for now". A message
that asks for work to be done — ordering, moving, counting, receiving — is never STOP, however
urgent it sounds.
SALES_ORDER also covers a request to create, place, start or raise a customer order, even when it is
phrased as a question — "Can you create a customer order for Marlow?" is SALES_ORDER, not QUESTION,
because the person wants an order to exist, not an explanation.
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
    return result('STOP', 'This asks StockChief to stop acting on its own.');
  }
  /*
   * A payment that already happened, reported after the fact.
   *
   * StockChief cannot observe money moving outside it, so this sentence is the
   * only way it learns. It is unmistakable language — a past-tense payment verb
   * with an amount — and routing it through a probabilistic classifier only
   * adds a way for it to be missed.
   *
   * "Pay ABC $400" is not this: that asks StockChief to make a payment, which it
   * does not do. Only a report of one already made.
   */
  // "Transferred", "sent" and "settled" belong to stock as much as to money —
  // "Transferred 2 filters from Main Warehouse" is not a payment — so a verb
  // and a digit are not enough. There has to be actual money in the sentence:
  // a currency symbol, an amount with cents, or a document that gets paid.
  const moneyEvidence = /\$\s?\d|\b\d[\d,]*\.\d{2}\b|\b(?:invoice|bill|payment)\b/i.test(clean);
  if (/\b(?:paid|payed|sent|wired|transferred|remitted|settled)\b/i.test(clean)
    && moneyEvidence
    && !/\bplease\s+pay\b|\bpay\s+(?:them|him|her|it)\b|\bshould\s+i\s+pay\b/i.test(clean)) {
    return result('PAYMENT_REPORT', 'This reports a payment that has already been made or received.');
  }
  if (/\b(handle everything|automatically|autopilot|may (?:approve|move|order)|never (?:approve|move|order)|policy|authority|limit)\b/i.test(clean)) {
    return result('POLICY_CHANGE', 'This explicitly changes what StockChief may do or its limits.');
  }
  if (/(?:\breorder\b.*\b(?:at|below|when|to)\b)|\b(restock(?:ing)?|replenish(?:ment|ing)?|stock (?:level|reaches)|order[- ]?up[- ]?to|safety stock|keep(?: at least)?|never let|days? of stock|lead time|minimum order|moq|purchase unit|order multiple|preferred supplier|use .+ for|transfer before (?:buying|purchasing)|cooldown)\b/i.test(clean)) {
    return result('OPERATING_INSTRUCTION', 'This teaches a lasting inventory operating rule.');
  }
  /*
   * Retiring one of the records StockChief keeps around its stock.
   *
   * This sits above purchasing deliberately. "Get rid of One Step Vendor, we
   * do not buy from them any more" is a sentence about ending a relationship,
   * but it contains the word buy, and the purchasing rule below matched it
   * first — so asking StockChief to drop a supplier set it planning a purchase
   * instead. A removal verb beside one of these records outranks that.
   *
   * The vocabulary comes from the removal registry, so a kind added there is
   * recognised here too. This only decides which pipeline reads the sentence;
   * which record is meant, and whether it may go, are still settled by the
   * grounded action pipeline.
   */
  if (/\b(archive|remove|delete|deactivate|retire|drop|get rid of|no longer use|don'?t use)\b/i.test(clean)
      && new RegExp(`\\b(${removals.nounPattern()})\\b`, 'i').test(clean)) {
    return result('CATALOG_CHANGE', 'This retires a record StockChief keeps.');
  }
  if (/^\s*order\b|\b(order what|what should (?:i|we) order|buy|purchase|reorder|purchase order|supplier order)\b/i.test(clean)) {
    return result('PURCHASING_REQUEST', 'This explicitly asks about purchasing or replenishment.');
  }
  // "Set ... to 60 after a physical count" is a complete correction command,
  // not merely a report that a count happened. Route it to the controlled
  // action preview immediately so it cannot stall behind a second provider
  // call before the deterministic action parser sees it.
  if (/^\s*(?:set|correct|adjust)\b.+\bto\s+\d+\b.+\bphysical count\b/i.test(clean)) {
    return result('INVENTORY_ACTION', 'This explicitly asks StockChief to correct a recorded count from physical evidence.');
  }
  if (/\b(physical count|counted|i count|we count|shipment arrived|delivery arrived|arrived damaged|damaged|returned|found stock)\b/i.test(clean)) {
    return result('PHYSICAL_EVENT', 'This explicitly reports something that happened to physical inventory.');
  }
  if (/\b(investigate|discrepancy|doesn'?t match|do not match|records? (?:is|are) (?:wrong|off)|why (?:is|are).*(?:off|different))\b/i.test(clean)) {
    return result('INVESTIGATION_REQUEST', 'This explicitly asks StockChief to investigate a mismatch.');
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
    return result('IMPORT', 'This explicitly asks StockChief to read or import a source.');
  }
  if (/(?:change|map|rename|replace)\s+(?:the\s+)?(?:vendor|supplier)(?:'s)?\s+(?:code|sku)\b/i.test(clean) ||
      /(?:vendor|supplier)\s+(?:code|sku)\s+[A-Za-z0-9][A-Za-z0-9._/-]*\s*,?\s*(?:use|make it|call it)\b/i.test(clean)) {
    return result('CONFIGURATION_CHANGE', 'This maps a vendor product identifier to the customer\'s own internal code.');
  }
  // Asking for an order to exist — "can you create a customer order for
  // Marlow?" — is work, not a question, however it is punctuated. It has to be
  // decided here, before the question rule reads the question mark and sends
  // somebody who wanted an order to a page that only explains things.
  if (/\b(?:create|place|make|start|open|raise|set up|new)\b[^.?!]*\b(?:customer|sales)\s+order\b/i.test(clean)
      || /\b(?:customer|sales)\s+order\b[^.?!]*\bfor\b/i.test(clean)) {
    return result('SALES_ORDER', 'This asks for a customer order to be created.');
  }
  if (/\b(add|create|rename|archive|remove|delete)\b.*\b(product|item|sku|variant|location|warehouse|inventory)\b/i.test(clean)) {
    return result('CATALOG_CHANGE', 'This explicitly changes the inventory catalogue.');
  }
  // Normal inventory work is most often reported after it happens. The older
  // fallback recognised only command-form verbs ("issue", "move", "receive")
  // and missed the ordinary sentences shown by StockChief itself: "I sold...",
  // "we received..." and "we moved...". That made a complete transaction
  // depend on a probabilistic top-level classifier and, when it answered
  // UNKNOWN, produced the meaningless "what would you like StockChief to do?"
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
  if (/\bwhy did (?:stockchief|foundry|you)|why (?:was|wasn'?t|didn'?t)\b/i.test(clean)) {
    return result('EXPLANATION', 'This asks StockChief to explain a recorded decision.');
  }
  if (!/\b(?:that|it|this one|that one)\b/i.test(clean) &&
      (/\?$|^(?:what|where|when|which|who|how|show|tell me)\b/i.test(clean))) {
    return result('QUESTION', 'This is an inventory question.');
  }
  return { intentClass: 'UNKNOWN', confidence: 'low',
    reason: 'The request is ambiguous and StockChief will not guess.', resolvedReference: '',
    clarifyingQuestion: 'What would you like StockChief to do with the inventory?' };
}

async function classify(db, ctx, message, options = {}) {
  const clean = requireText(message, 'Message', { max: 4000 });
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
  /*
   * The keyword fast path runs only when the understanding step agrees.
   *
   * "I received an email from Acme about pricing" matched "I received" and
   * went straight to the stock-action reader as a receipt, without a model
   * ever seeing it. The understanding step reads the same sentence for what
   * it is about; when it says this is not a stock change, a report of one,
   * a purchase or a stop, the fast path stands down and the planner reads
   * the sentence. A closed, safety-sensitive form still bypasses the planner
   * when both readers agree it is one.
   */
  const agreeing = {
    INVENTORY_ACTION: ['change', 'report'], PHYSICAL_EVENT: ['report', 'change'], PURCHASING_REQUEST: ['change', 'lookup'], STOP: ['instruction', 'change', 'unclear'],
    // A past-tense payment with money in it is a closed form too; a planner
    // read "I paid Acme $500 against their invoice" as a purchase-cost change.
    PAYMENT_REPORT: ['report', 'change', 'unclear', 'communication'],
  };
  const goalKind = options.goalKind || null;
  const understoodOtherwise = goalKind && agreeing[deterministic.intentClass] && !agreeing[deterministic.intentClass].includes(goalKind);
  const safeFastPath = (['INVENTORY_ACTION', 'PHYSICAL_EVENT', 'PURCHASING_REQUEST', 'STOP', 'PAYMENT_REPORT'].includes(deterministic.intentClass) && !understoodOtherwise)
    || wholeSalesOrderCompletion;
  // A lasting rule in one of its closed forms — a reorder point, a block on
  // outgoing stock — is read by the rule compilers; the planner adds nothing.
  const closedRule = (() => {
    try { const oi = require('./operating-instructions'); return Boolean(oi.__compileReorderRule(clean) || oi.__compileStockProtection(clean)); } catch { return false; }
  })();
  if (safeFastPath) data = deterministic;
  else if (closedRule && (!goalKind || ['instruction', 'change', 'unclear'].includes(goalKind))) {
    data = { intentClass: 'OPERATING_INSTRUCTION', confidence: 'high',
      reason: 'This teaches a lasting inventory operating rule.', resolvedReference: '', clarifyingQuestion: '' };
  }
  else if (options.provider || config.ai.configured) {
    try {
      data = await capabilityPlanner.plan(db, ctx, clean, {
        provider: options.provider || createProviderForTier('fast'),
        referentNote: options.referentNote || '',
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
