'use strict';

const express = require('express');
const crypto = require('node:crypto');
const intentRouter = require('../../manager/intent-router');
const managerContext = require('../../manager/context');
const investigations = require('../../manager/investigations');
const physicalEvents = require('../../manager/physical-events');
const documentEvents = require('../../manager/document-events');
const documentIntake = require('../../foundry/document-intake');
const documentRemovals = require('../../manager/document-removals');
const importRemovals = require('../../manager/import-removals');
const catalogCodeChanges = require('../../manager/catalog-code-changes');
const managerReadiness = require('../../manager/readiness');
const actionService = require('../../actions/action-service');
const proposals = require('../../actions/proposal-service');
const actionPresenter = require('../../actions/presenter');
const importPlans = require('../../imports/plan-service');
const workItems = require('../../autopilot/work-items');
const operatingInstructions = require('../../manager/operating-instructions');
const actionResolver = require('../../actions/resolver');
const managerRunner = require('../../autopilot/runner');
const supplierCodeMappings = require('../../purchasing/supplier-code-mappings');
const managerEvents = require('../../manager/events');
const reactions = require('../../manager/reactions');
const salesIntent = require('../../sales/sales-intent');
const permissions = require('../../actions/permissions');
const priceChanges = require('../../pricing/price-changes');
const connectionTell = require('../../connections/tell');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use(['/foundry/tell', '/needs-you', '/investigations', '/document-removals', '/import-removals', '/catalog-code-changes'], requireAuth);

function actionRedirect(result) {
  if (result.kind === 'proposal' || result.kind === 'existing') return `/actions/${result.proposal.proposalId}`;
  if (result.kind === 'plan') return `/actions/plan/${result.plan.planId}`;
  return null;
}

/**
 * A capability question is not yet a policy change.
 *
 * "Can you set up restrictions?" asks what Foundry can do and where to begin.
 * Sending that sentence straight into the rule compiler produces a technically
 * accurate but useless list of missing fields. Keep the product knowledge
 * deterministic, answer the question, and offer one bounded next choice.
 */
function asksAboutRestrictions(message) {
  const clean = String(message || '').trim();
  // A button answer is appended to the original sentence by the shared
  // continuation form. It is no longer the broad capability question and
  // must continue into the selected restriction instead of reopening the
  // same menu.
  if (/\bClarification\s*:/i.test(clean)) return false;
  return /^(?:(?:can|could|would|will)\s+(?:you|foundry)\s+(?:help\s+(?:me\s+)?)?(?:set(?:\s*up)?|create|configure|add|manage)\s+(?:some\s+|any\s+)?(?:restrictions?|limits?|guardrails?|rules?)|(?:what|which)\s+(?:restrictions?|limits?|guardrails?|rules?)\s+(?:can|could|does|would)\s+(?:you|foundry)\b)/i.test(clean)
    && !/\b\d+(?:\.\d+)?\b/.test(clean);
}

function restrictionHelp(message) {
  return {
    question: 'Yes. Foundry can protect low stock, limit automatic purchasing or transfers, control supplier price and quantity changes, and decide when supplier emails may be sent. Which restriction do you want to set first?',
    instruction: message,
    choices: [
      {
        label: 'Protect low stock',
        value: 'Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
        workflowKind: 'stock_protection',
      },
      {
        label: 'Limit purchasing',
        value: 'Set a purchasing approval or spend limit. Ask me for the supplier, product scope, and amount.',
        workflowKind: 'purchase_authority',
      },
      {
        label: 'Limit transfers',
        value: 'Set a transfer restriction. Ask me for the product or locations and maximum quantity.',
        workflowKind: 'transfer_authority',
      },
      {
        label: 'Control supplier changes',
        value: 'Set supplier price or quantity-change tolerances. Ask me which supplier and percentage.',
        workflowKind: 'supplier_tolerance',
      },
      {
        label: 'Control supplier emails',
        value: 'Set supplier email sending authority. Ask me which supplier and automatic send limit.',
        workflowKind: 'supplier_email_authority',
      },
    ],
    tone: null,
    answerAction: '/foundry/tell',
    workflow: 'restriction_setup',
    workflowStep: 'category',
  };
}

const RESTRICTION_FLOW_TTL_MS = 30 * 60 * 1000;

function activeRestrictionFlow(req) {
  const flow = req.session.pendingRestrictionFlow;
  return Boolean(flow && Number(flow.startedAt) > Date.now() - RESTRICTION_FLOW_TTL_MS);
}

const PRODUCT_RULE_DOMAINS = new Set([
  'replenishment', 'location_stock', 'supplier_assignment', 'supplier_terms', 'stock_protection',
]);

/**
 * Turn a failed product resolution into a product decision, not a generic
 * "missing detail" or a misleading preview about "this inventory".
 */
function productResolution(db, workspaceId, proposal) {
  for (let index = 0; index < proposal.resolvedChanges.length; index += 1) {
    const resolved = proposal.resolvedChanges[index] || {};
    if (!PRODUCT_RULE_DOMAINS.has(resolved.domain) || resolved.skuId) continue;
    const raw = proposal.changes[index] || {};
    const result = actionResolver.resolveSku(db, workspaceId, raw.itemText, raw.variantText, {
      instruction: proposal.statedAs,
      groundIdentity: true,
    });
    if (result && result.ok) continue;
    const query = trimOrNull(raw.itemText) || trimOrNull(raw.variantText)
      || (proposal.questions.join(' ').match(/[“"]([^”"]+)[”"]/) || [])[1]
      || 'that product';
    return {
      query,
      reason: result?.reason || 'not_found',
      candidates: (result?.candidates || []).map((candidate) => ({
        skuId: candidate.item_id ? candidate.id : null,
        label: [candidate.item_name || candidate.name, candidate.variant_label].filter(Boolean).join(' — '),
        answer: [candidate.item_name || candidate.name, candidate.variant_label].filter(Boolean).join(' '),
      })),
      createHref: `/inventory/new?name=${encodeURIComponent(query)}&resumeInstructionId=${encodeURIComponent(proposal.id)}`,
    };
  }
  return null;
}

/** Convert an incomplete rule into the next human question, never model/debug prose. */
function incompleteRestrictionQuestion(message) {
  const clean = String(message || '').toLowerCase();
  if (/price|quantity[- ]?change|tolerance/.test(clean)) {
    return 'Which supplier should this apply to, and what percentage change may Foundry accept without asking you?';
  }
  if (/email|message|send/.test(clean)) {
    return 'Which supplier is this for, and up to what order value may Foundry send without asking you?';
  }
  if (/transfer|move/.test(clean)) {
    return 'What product or locations should the transfer restriction cover, and what maximum quantity should be allowed?';
  }
  if (/purchase|buy|spend|order approval/.test(clean)) {
    return 'Which supplier or products should the purchasing restriction cover, and what approval or spending limit do you want?';
  }
  if (/stock|sale|outgoing|issue|low/.test(clean)) {
    return 'Which product should Foundry protect, at what quantity, and should it block outgoing stock or only warn you?';
  }
  return 'What should Foundry restrict: low-stock sales, purchasing, transfers, supplier changes, or supplier email sending?';
}

router.post('/foundry/tell', asyncRoute(async (req, res) => {
  const attached = (req.files || []).find((entry) => entry.field === 'file' && entry.size > 0);
  // A clarification answer must continue the original manager request. The
  // action surface carries these two fields back rather than making someone
  // retype the sentence; recombining them here lets the manager classify the
  // completed thought again instead of forcing every answer through the stock
  // movement parser.
  const original = trimOrNull(req.body.original) || '';
  const answer = trimOrNull(req.body.answer) || '';
  const workflow = trimOrNull(req.body.workflow) || '';
  const workflowStep = trimOrNull(req.body.workflowStep) || '';
  const workflowKind = trimOrNull(req.body.workflowKind) || '';
  const message = answer
    ? `${original}${original ? ' — Clarification: ' : ''}${answer}`
    : trimOrNull(req.body.message) || (attached ? `Import ${attached.filename}` : '');
  const tabular = attached && /\.(csv|tsv|xlsx|xls|txt)$/i.test(attached.filename || '');
  const operationalDocument = attached && /\.(pdf|docx|xlsx|xls|csv|tsv|txt)$/i.test(attached.filename || '');
  const receivingHint = /arriv|deliver|shipment|packing|receive|received|supplier invoice/i.test(message);
  const pricingUpdateHint = /\b(?:price|prices|pricing|selling\s+price|retail\s+price)\b/i.test(message)
    && /\b(?:apply|change|set|update|use)\b/i.test(message);
  if (operationalDocument && (!tabular || receivingHint)) {
    const understood = await documentEvents.understand(req.db, req.ctx, attached, {
      provider: req.app.locals.aiProvider || undefined,
    });
    const matched = understood.match.matched ? {
      purchaseOrderId: understood.match.purchaseOrderId,
      poNumber: understood.match.poNumber,
      receiptLines: understood.match.receiptLines,
      matchReasons: understood.match.reasons,
      documentNumber: understood.interpretation.documentNumber,
    } : { candidates: understood.match.candidates, documentNumber: understood.interpretation.documentNumber };
    // An invoice or stock report with real line-item evidence is not an
    // "unknown physical event" merely because no earlier PO exists. It may be
    // the first supplier invoice or an owner adding a new line of inventory.
    // Preserve the exact interpretation and show the ordinary document review;
    // nothing is created or received until the owner approves that preview.
    const canBecomeInventory = !understood.match.matched
      && ['invoice', 'stock_report'].includes(understood.interpretation.documentType)
      && understood.interpretation.lines.length > 0;
    if (canBecomeInventory) {
      const prepared = documentIntake.prepareFromInterpretation(
        req.db, req.ctx, req.user, attached, understood.interpretation, understood.extractedText
      );
      // A previous version filed this same document as an unresolved physical
      // event. Once the document has a concrete review, that generic exception
      // is stale and must not remain actionable beside the real preview.
      req.db.prepare(`UPDATE physical_events SET status = 'COMPLETED', updated_at = datetime('now')
        WHERE workspace_id = ? AND status = 'NEEDS_HUMAN'
          AND attachment_name = ? AND attachment_content = ?`)
        .run(req.ctx.workspaceId, attached.filename, attached.buffer);
      req.flash('success', `Foundry read ${attached.filename}. Review every product, variant, quantity, supplier and destination before anything changes.`);
      return res.redirect(303, `/foundry/proposal/${prepared.understandingId}`);
    }
    const event = physicalEvents.record(req.db, req.ctx, {
      eventType: 'shipment_arrived', statedAs: trimOrNull(req.body.message) || `Uploaded ${attached.filename}.`,
      details: { interpretation: understood.interpretation }, matchedEntities: matched,
      attachmentName: attached.filename, attachmentMime: attached.mimeType, attachmentBuffer: attached.buffer,
    });
    if (event.status === 'ROUTED') {
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: event.matchedEntities.purchaseOrderId,
        entities: { purchaseOrderId: event.matchedEntities.purchaseOrderId, physicalEventId: event.id } });
      req.flash('success', `Foundry read ${attached.filename}, matched it to ${event.matchedEntities.poNumber}, and prepared the receipt. Review the physical quantities before stock changes.`);
      return res.redirect(303, `/purchasing/orders/${event.matchedEntities.purchaseOrderId}/receive?event=${event.id}`);
    }
    req.flash('info', `Foundry read ${attached.filename}, but could not safely match it to exactly one open purchase order.`);
    return res.redirect(303, '/needs-you');
  }
  if (tabular) {
    const { plan } = await importPlans.analyse(req.db, req.ctx, req.user, {
      buffer: attached.buffer, filename: attached.filename,
      operationScope: pricingUpdateHint ? 'selling_price_update' : null,
    });
    req.flash('success', pricingUpdateHint
      ? `Foundry read ${attached.filename} as a pricing update. Review the exact existing variants and prices; this cannot create products or change stock.`
      : `Foundry read ${attached.filename}. Review the exact changes before anything is applied.`);
    return res.redirect(303, `/imports/${plan.id}`);
  }
  if (attached) {
    const lower = message.toLowerCase();
    const eventType = /damag|broken|spoiled/.test(lower) ? 'damage'
      : /arriv|deliver|shipment|packing/.test(lower) ? 'shipment_arrived'
        : /count|counted/.test(lower) ? 'physical_count'
          : /return/.test(lower) ? 'return' : /found/.test(lower) ? 'found_stock' : 'reported_event';
    const event = physicalEvents.record(req.db, req.ctx, {
      eventType, statedAs: trimOrNull(req.body.message) || `Attached ${attached.filename} for Foundry to review.`,
      attachmentName: attached.filename, attachmentMime: attached.mimeType, attachmentBuffer: attached.buffer,
    });
    req.flash('info', 'Foundry saved the evidence. The unresolved physical fact is in Needs you.');
    return res.redirect(303, '/needs-you');
  }

  if (priceChanges.matchesInstruction(message)) {
    try {
      if (priceChanges.matchesBulkInstruction(message)) {
        const batch = await priceChanges.interpretMany(req.db, req.ctx, message, {
          provider: req.app.locals.aiProvider || undefined,
        });
        req.session.pendingPriceBatch = batch.map((proposal) => proposal.id);
        req.flash('success', `Foundry understood ${batch.length} selling-price changes. Review the complete list before anything changes.`);
        return res.redirect(303, '/pricing/proposals/batch');
      }
      const proposal = await priceChanges.interpret(req.db, req.ctx, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      req.flash('success', 'Foundry understood the selling-price change. Review it before anything changes.');
      return res.redirect(303, `/pricing/proposals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      if (err.details && err.details.kind === 'price_clarification') {
        req.session.pendingPriceContinuation = err.details.continuation;
        req.session.pendingActionQuestion = {
          question: err.message,
          instruction: message,
          choices: err.details.choices || null,
          answerAction: '/pricing/clarify',
        };
        return res.redirect(303, '/actions');
      }
      req.flash('warn', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }

  // "Newly added products" is a provenance request, not an ambiguous product
  // name. Resolve it from the most recent completed import before asking the
  // general language router, whose catalogue candidates cannot know which
  // records were created together.
  if (importRemovals.matchesInstruction(message)) {
    try {
      const proposal = importRemovals.create(req.db, req.ctx, req.user, message);
      req.flash('warning', `Foundry traced the newly added products to ${proposal.snapshot.source.sourceName}. Choose any combination or remove all; nothing changes until you approve.`);
      return res.redirect(303, `/import-removals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }

  const intent = await intentRouter.classify(req.db, req.ctx, message, {
    provider: req.app.locals.aiProvider || undefined,
  });
  if (asksAboutRestrictions(message)) {
    req.session.pendingRestrictionFlow = { startedAt: Date.now(), instruction: message };
    req.session.pendingActionQuestion = restrictionHelp(message);
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'restriction_help', null, 'NEEDS_CLARIFICATION');
    return res.redirect(303, '/actions');
  }
  // Once somebody has entered the restriction setup, their short answers are
  // answers to that workflow. "Snacks" is a product name, not a new question
  // for the general Ask page. Keep this route deterministic even if the model
  // classifies the isolated word differently.
  const structuredRestriction = workflow === 'restriction_setup';
  const continuingRestriction = answer && (structuredRestriction || activeRestrictionFlow(req)
    || /\bClarification\s*:/i.test(original) && /\b(?:restriction|stock protection|purchase|transfer|supplier)\b/i.test(original));
  if (continuingRestriction) {
    intent.handler = 'operating_instruction';
    intent.intentClass = 'OPERATING_INSTRUCTION';
    intent.clarifyingQuestion = '';
  }
  const restrictionFlow = activeRestrictionFlow(req) ? req.session.pendingRestrictionFlow : null;
  const stockProductAnswer = Boolean(
    (workflowKind === 'stock_protection' && workflowStep === 'product')
    || (restrictionFlow?.kind === 'stock_protection' && restrictionFlow.stage === 'product')
    // Compatibility for a form that was already open before this deployment:
    // the original text names the chosen category, so a server restart must
    // not make the next product answer disappear.
    || /\bClarification\s*:\s*Set up stock protection\b/i.test(original)
  );
  if ((restrictionFlow || structuredRestriction) && (workflowKind === 'stock_protection' || /\bset up stock protection\b/i.test(answer))) {
    const flow = restrictionFlow || (req.session.pendingRestrictionFlow = {
      startedAt: Date.now(), instruction: original || message,
    });
    flow.kind = 'stock_protection';
    flow.stage = 'product';
  }
  if (stockProductAnswer && answer) {
    const proposal = operatingInstructions.proposeStockProtectionAnswer(
      req.db, req.ctx, req.user, answer, message
    );
    delete req.session.pendingRestrictionFlow;
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', proposal.id);
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  }
  // A question from the classifier is a last resort, not a first one.
  //
  // It is written by a model that has seen only the sentence, while the
  // handlers below can look at the actual records — so it asked "should this go
  // to your regular supplier?" where the grounded answer was "no supplier is on
  // file for Trail Ration Pack". Whenever there is a handler that can resolve
  // or ask from real data, it gets the chance first.
  if (intent.handler === 'connection_management' && /^\s*(?:why|what|which|when|where|how)\b/i.test(message)) {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'ask');
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }
  if (intent.handler === 'connection_management' || connectionTell.matches(message)) {
    try {
      const result = connectionTell.apply(req.db, req.ctx, req.user, message);
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'connection_management', result.connection.id);
      req.flash('success', result.message);
      return res.redirect(303, `/settings/connections/${result.connection.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'connection_management', null, 'NEEDS_CLARIFICATION');
      req.flash('warn', err.message);
      return res.redirect(303, '/settings/connections');
    }
  }
  if (intent.clarifyingQuestion && intent.intentClass === 'UNKNOWN') {
    req.session.pendingActionQuestion = {
      question: intent.clarifyingQuestion,
      instruction: message,
      choices: null,
      tone: 'warning',
      answerAction: '/foundry/tell',
    };
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'manager_clarification', null, 'NEEDS_CLARIFICATION');
    return res.redirect(303, '/actions');
  }
  if (intent.handler === 'sales_order' || intent.intentClass === 'SALES_ORDER') {
    try {
      const parsed = await salesIntent.interpret(req.db, req.ctx, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      if (parsed.operation === 'list_waiting') {
        permissions.assertCan(req.user, permissions.VIEW_SALES, 'view sales orders');
      } else if (parsed.operation === 'fulfill' || parsed.operation === 'cancel_line' || parsed.operation === 'cancel_order') {
        permissions.assertCan(req.user, permissions.FULFILL_SALES, 'fulfill or cancel sales orders');
      } else permissions.assertCan(req.user, permissions.MANAGE_SALES, 'create or change sales orders');
      const result = salesIntent.apply(req.db, req.ctx, parsed, {
        idempotencyKey: `tell-sales:${intent.id}`,
      });
      if (result.kind === 'question') {
        req.session.pendingSalesContinuation = result.continuation;
        req.session.pendingActionQuestion = {
          question: result.question,
          instruction: message,
          choices: result.choices || null,
          answerAction: '/sales/clarify',
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', null, 'NEEDS_CLARIFICATION');
        return res.redirect(303, '/actions');
      }
      if (result.kind === 'list') {
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_orders');
        return res.redirect(303, '/sales?status=BACKORDERED');
      }
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', result.order.id);
      managerContext.remember(req.db, req.ctx, { entities: { salesOrderId: result.order.id } });
      req.flash(result.order.totals.backordered ? 'warn' : 'success',
        `${result.order.order_number} is ${result.order.status.toLowerCase().replace(/_/g, ' ')}. `
        + `${result.order.totals.allocated} committed, ${result.order.totals.backordered} waiting for stock, `
        + `${result.order.totals.fulfilled} fulfilled.`);
      return res.redirect(303, `/sales/orders/${result.order.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', null, 'NEEDS_CLARIFICATION');
      req.flash('warn', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  if (intent.handler === 'ask' || ['QUESTION', 'EXPLANATION'].includes(intent.intentClass)) {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'ask');
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }
  // Rolling back a document has a much wider scope than archiving one named
  // product. Require explicit document/import wording at this boundary even if
  // the language planner selected the broader capability.
  if (documentRemovals.matchesInstruction(message)) {
    try {
      const proposal = documentRemovals.create(req.db, req.ctx, req.user, message);
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'document_removal', proposal.id);
      req.flash('warning', `Foundry found the earlier file and prepared the exact products it created. Nothing has been removed yet.`);
      return res.redirect(303, `/document-removals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'document_removal', null, 'NEEDS_CLARIFICATION');
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  if (intent.handler === 'catalog_code_change' || catalogCodeChanges.matchesInstruction(message)) {
    try {
      const proposal = catalogCodeChanges.create(req.db, req.ctx, req.user, message, {
        operation: intent.parameters,
      });
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'catalog_code_change', proposal.id);
      req.flash('info', `Foundry prepared every matching internal code from ${proposal.operation.from} to ${proposal.operation.to}. Nothing has changed yet.`);
      return res.redirect(303, `/catalog-code-changes/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'catalog_code_change', null, 'NEEDS_CLARIFICATION');
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  if (intent.handler === 'attachment_required' || intent.intentClass === 'IMPORT') {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'attachment_required', null, 'NEEDS_CLARIFICATION');
    req.flash('info', 'Attach the spreadsheet, PDF or document you want Foundry to read.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.handler === 'purchasing' || intent.intentClass === 'PURCHASING_REQUEST') {
    // Naming a product wins over a remembered order.
    //
    // The classifier is given durable context so short follow-ups like "approve
    // it" resolve, and it duly attached the last purchase order to "order 50
    // more Trail Ration Pack" — which opened a draft for a different product
    // entirely. A message that names something in the catalogue is about that
    // thing, not about whatever was on screen last.
    const namesAProduct = mentionsKnownProduct(req.db, req.ctx.workspaceId, message);
    const reference = intent.resolvedReference;
    if (reference && /^po_/.test(reference) && !namesAProduct) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'purchase_order', reference);
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: reference });
      return res.redirect(303, /receive|arriv|rest/i.test(message)
        ? `/purchasing/orders/${reference}/receive` : `/purchasing/orders/${reference}`);
    }
    // A request naming a product is answered about that product; "order what we
    // need" has named nothing and stays a request for the general plan.
    //
    // Every purchasing request used to run the general replenishment planner
    // and report how many lines it prepared, so "order 50 more Trail Ration
    // Pack" came back as a summary that never mentioned Trail Ration Pack —
    // and the real answer, that nobody is on file to buy it from, was never
    // given. The specific path already exists and answers or asks properly; it
    // just had no caller.
    const specific = namesAProduct
      ? await actionService.interpret(req.db, req.ctx, req.user, message, {
          provider: req.app.locals.aiProvider || undefined,
        })
      : { kind: 'none' };
    if (specific.kind === 'purchase_order' && specific.order) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'purchase_order', specific.order.id);
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: specific.order.id });
      req.flash('success', `Foundry drafted ${specific.order.poNumber}. Nothing is ordered until you approve it.`);
      return res.redirect(303, `/purchasing/orders/${specific.order.id}`);
    }
    if (specific.kind === 'question' && specific.question) {
      req.session.pendingActionQuestion = { question: specific.question, instruction: message, choices: null };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    if (specific.kind === 'unsupported' && specific.message) {
      req.session.pendingActionQuestion = { unsupported: specific.message, instruction: message };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }

    const result = managerRunner.run(req.db, req.ctx, req.user, { trigger: 'tell-foundry-purchasing' });
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'manager_purchasing');
    req.flash('success', result.nothingToDo
      ? 'Foundry checked stock, incoming orders, usage, lead times and supplier rules. No purchase is currently supported.'
      : `${result.planned} piece${result.planned === 1 ? '' : 's'} of inventory work prepared; ${result.awaiting} need your decision.`);
    return res.redirect(303, '/');
  }
  if (intent.handler === 'supplier_code_mapping' || intent.intentClass === 'CONFIGURATION_CHANGE') {
    const mappingInstruction = supplierCodeMappings.parseInstruction(message);
    if (mappingInstruction.matched) {
      try {
        const result = supplierCodeMappings.previewFromInstruction(req.db, req.ctx, req.user, message);
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'supplier_code_mapping', result.proposal.id);
        managerContext.remember(req.db, req.ctx, {
          entities: { supplierCodeMappingProposalId: result.proposal.id, supplierId: result.proposal.supplierId },
        });
        req.flash('success', `Foundry prepared the exact change from ${result.proposal.vendorCode} to ${result.proposal.internalBaseCode}. Nothing changes until you approve it.`);
        return res.redirect(303, `/supplier-code-mappings/${result.proposal.id}`);
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'supplier_code_mapping', null, 'NEEDS_CLARIFICATION');
        req.flash('info', err.message);
        return res.redirect(303, '/#tell-foundry');
      }
    }
  }
  if (intent.handler === 'inventory_action'
      || ['INVENTORY_ACTION', 'CATALOG_CHANGE', 'CONFIGURATION_CHANGE'].includes(intent.intentClass)) {
    const result = await actionService.interpret(req.db, req.ctx, req.user, message, {
      provider: req.app.locals.aiProvider || undefined,
    });
    const target = actionRedirect(result);
    if (target) {
      const related = result.proposal ? result.proposal.proposalId : result.plan.planId;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'action', related);
      managerContext.remember(req.db, req.ctx, { entities: { actionId: related } });
      return res.redirect(303, target);
    }
    if (result.kind === 'missing_location') {
      req.session.pendingLocationTransfer = {
        locationName: result.locationName,
        instruction: result.instruction,
        line: result.line,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'missing_location', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions/location-required');
    }
    // A question goes where it can be answered. Only a flat refusal — something
    // Foundry cannot do at all — belongs in a message you dismiss.
    if (result.kind === 'question' && result.question) {
      let continuationId = null;
      if (result.continuation) {
        continuationId = crypto.randomUUID();
        req.session.pendingActionContinuation = { id: continuationId, value: result.continuation };
      }
      req.session.pendingActionQuestion = {
        question: result.question,
        instruction: message,
        choices: result.choices || null,
        continuationId,
        // Kept server-side with the handed question. The actions GET restores
        // it into the one-use continuation slot immediately before rendering,
        // so a redirect/session save cannot separate the button from the
        // parsed request it is meant to continue.
        continuation: result.continuation || null,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    // The same refusal, whichever class the sentence was read as. Being
    // declined by a rule is not a request for clarification, and is not
    // recorded as one.
    if (result.kind === 'unsupported' && (result.message || result.unsupported)) {
      req.session.pendingActionQuestion = {
        unsupported: result.message || result.unsupported,
        blocked: result.blocked || null,
        instruction: message,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null,
        result.blocked ? 'REFUSED' : 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    req.flash('error', result.message || 'Foundry needs more detail.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.handler === 'physical_event' || intent.intentClass === 'PHYSICAL_EVENT') {
    const event = await physicalEvents.recordNatural(req.db, req.ctx, message, {
      provider: req.app.locals.aiProvider || undefined,
    });

    // A delivery with no purchase order behind it is still a delivery.
    //
    // Matching an arrival to an open order is the happy path, but plenty of
    // stock arrives without one — during setup there are no orders at all. That
    // case used to stop dead: Foundry had read the product, location and
    // quantity correctly and then parked the whole thing in Needs you as an
    // event it could not place, so "we received 12 bags into the Warehouse"
    // recorded nothing and offered nothing to do about it.
    //
    // It goes to the ordinary controlled path instead — the same interpret,
    // preview and approve that typing it as an instruction would have used. No
    // stock moves here; a proposal is created and somebody still says yes.
    // Any report Foundry could not place, not just a delivery.
    //
    // An event left needing a person with no investigation behind it is one
    // Foundry failed to resolve — "sold 5 House Blend" when House Blend comes
    // in two sizes. Parking it repeats the sentence back as though that were
    // the explanation. The ordinary controlled path knows how to ask "which
    // one?", so it gets asked. A count that genuinely produced an
    // investigation is excluded: that already has somewhere to go.
    if (event.status === 'NEEDS_HUMAN' && !event.investigationId && !event.matchedEntities.purchaseOrderId) {
      const asAction = await actionService.interpret(req.db, req.ctx, req.user, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      const actionTarget = actionRedirect(asAction);
      if (actionTarget) {
        const related = asAction.proposal ? asAction.proposal.proposalId : asAction.plan.planId;
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'action', related);
        managerContext.remember(req.db, req.ctx, { entities: { actionId: related } });
        req.flash('info', 'No open order matches that delivery, so Foundry prepared it as a receipt. Nothing changes until you approve it.');
        return res.redirect(303, actionTarget);
      }
      // A question about the delivery is still better asked than filed away.
      if (asAction.kind === 'question' && asAction.question) {
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        req.session.pendingActionQuestion = {
          question: asAction.question,
          instruction: message,
          choices: asAction.choices || null,
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
        return res.redirect(303, '/actions');
      }
      // Understood perfectly, and refused anyway.
      //
      // "We sold 10 Black Large at Downtown Store" leaves nothing to ask: the
      // product, the place, the quantity and the direction are all settled.
      // What stops it is that Downtown has four and this inventory does not
      // allow negative stock. That is a fact about the stock, not a gap in the
      // sentence — and it used to be filed as one, as a reported event sitting
      // in Needs you asking for details nobody could name, because this
      // fallback only forwarded proposals and questions and let a refusal
      // drop through to the generic "could not place it" ending.
      //
      // A refusal is an answer. It goes back to the person who asked, with the
      // numbers behind it, and the event is closed rather than left waiting.
      if (asAction.kind === 'unsupported' && asAction.message) {
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        req.session.pendingActionQuestion = {
          unsupported: asAction.message,
          blocked: asAction.blocked || null,
          instruction: message,
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'REFUSED');
        return res.redirect(303, '/actions');
      }
    }

    intentRouter.markRouted(req.db, req.ctx, intent.id, 'physical_event', event.id);
    // What is said, and where they are sent, both follow what actually happened.
    const outcome = physicalEvents.describeOutcome(req.db, req.ctx.workspaceId, event);
    req.flash('info', outcome.message);
    return res.redirect(303, outcome.redirectTo);
  }
  if (intent.handler === 'investigation' || intent.intentClass === 'INVESTIGATION_REQUEST') {
    const created = investigations.create(req.db, req.ctx.workspaceId, {
      trigger: 'operator_request', affectedEntities: managerContext.get(req.db, req.ctx.workspaceId, req.ctx.actorId).lastEntities,
      observedDifference: { statedAs: message }, confidence: 'low',
      recommendedNextStep: 'Name the product and location, or provide a physical count, so Foundry can compare it with the ledger.',
      actorUserId: req.ctx.actorId,
    });
    const investigated = investigations.investigate(req.db, req.ctx.workspaceId, created.investigation.investigationId);
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'investigation', investigated.investigationId);
    managerContext.remember(req.db, req.ctx, { investigationId: investigated.investigationId });
    return res.redirect(303, `/investigations/${investigated.investigationId}`);
  }
  // Somebody asking Foundry to stop gets Foundry stopped, now, not a form.
  // Pausing takes no inventory action, is reversible in one click, and is the
  // only reading of "stop" that is safe to be wrong about.
  if (intent.handler === 'autopilot_pause' || intent.intentClass === 'STOP') {
    const state = autopilotModes.get(req.db, req.ctx.workspaceId);
    if (state.paused) {
      req.flash('info', 'Foundry is already paused. Nothing runs automatically until you resume it.');
    } else {
      autopilotModes.pause(req.db, req.ctx, req.user, message);
      req.flash('success', 'Stopped. Foundry will not do anything automatically until you resume it. Work already waiting for you is still there.');
    }
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'autopilot_pause');
    return res.redirect(303, '/autopilot');
  }
  if (intent.handler === 'operating_instruction'
      || ['POLICY_CHANGE', 'OPERATING_INSTRUCTION'].includes(intent.intentClass)) {
    // “Everything” is not a bounded instruction. It can only open the guided
    // review; it can never be translated into broad authority or approved in
    // one step.
    if (/handle\s+everything|everything\s+you\s+(?:safely\s+)?can/i.test(message)) {
      req.session.policyReviewAll = true;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'policy_settings');
      req.flash('info', 'Unlimited authority is never created. Foundry opened the bounded transfer and purchasing policies it can safely support.');
      return res.redirect(303, '/autopilot');
    }
    try {
      const proposal = await operatingInstructions.interpret(req.db, req.ctx, req.user, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      delete req.session.pendingRestrictionFlow;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', proposal.id);
      return res.redirect(303, `/operating-instructions/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', null, 'NEEDS_CLARIFICATION');
      req.session.pendingActionQuestion = {
        question: incompleteRestrictionQuestion(message),
        instruction: message,
        choices: null,
        tone: 'warning',
        answerAction: '/foundry/tell',
        workflow: 'restriction_setup',
        workflowKind: /\bstock protection\b/i.test(message) ? 'stock_protection' : workflowKind || null,
        workflowStep: /\bstock protection\b/i.test(message) ? 'product' : workflowStep || null,
      };
      return res.redirect(303, '/actions');
    }
  }
  req.flash('warn', 'Foundry could not safely route that yet. Say what happened or what outcome you want.');
  return res.redirect(303, '/#tell-foundry');
}));

/**
 * Does this message name a product this inventory actually has?
 *
 * Whole words only, so a size called "S" or a product called "Pack" inside
 * another word cannot make a general request look like a specific one.
 */
function mentionsKnownProduct(db, workspaceId, message) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const rows = db
    .prepare(
      `SELECT i.name, s.variant_label, s.code
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        LIMIT 500`
    )
    .all(workspaceId);
  return rows.some((row) =>
    [row.name, row.code].some((value) => {
      const needle = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return needle.length > 1 && text.includes(` ${needle} `);
    })
  );
}

const autopilotPresenter = require('../../autopilot/presenter');
const needsYouInbox = require('../../manager/needs-you-inbox');
const autopilotModes = require('../../autopilot/modes');

router.get('/operating-instructions/:id', asyncRoute(async (req, res) => {
  const proposal = operatingInstructions.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/operating-instruction', {
    title: 'Review what Foundry should remember', nav: 'settings', proposal,
    clarification: operatingInstructions.clarificationFor(proposal),
    productResolution: productResolution(req.db, req.ctx.workspaceId, proposal),
    descriptions: proposal.resolvedChanges.map(operatingInstructions.describe),
  });
}));

router.get('/document-removals/:id', asyncRoute(async (req, res) => {
  const proposal = documentRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/document-removal', {
    title: proposal.status === 'COMPLETED' ? 'Imported products removed' : 'Review products to remove',
    nav: 'inventory', proposal,
  });
}));

router.get('/import-removals/:id', asyncRoute(async (req, res) => {
  const proposal = importRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/import-removal', {
    title: proposal.status === 'COMPLETED' ? 'Imported products removed' : 'Choose imported products to remove',
    nav: 'inventory', proposal,
  });
}));

router.post('/import-removals/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const pending = importRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
    const itemIds = req.body.selectionMode === 'all'
      ? pending.snapshot.items.map((item) => item.id)
      : req.body.itemIds;
    const proposal = importRemovals.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash), itemIds
    );
    req.flash('success', `Removed ${proposal.result.productsRemoved} product${proposal.result.productsRemoved === 1 ? '' : 's'} added by ${proposal.result.sourceName}. Earlier inventory was not affected.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/import-removals/${req.params.id}`);
}));

router.post('/import-removals/:id/cancel', asyncRoute(async (req, res) => {
  importRemovals.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No products or stock were changed.');
  return res.redirect(303, '/');
}));

router.post('/document-removals/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const pending = documentRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
    const itemIds = req.body.selectionMode === 'all'
      ? pending.snapshot.items.map((item) => item.id)
      : req.body.itemIds;
    const proposal = documentRemovals.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash), itemIds
    );
    req.flash('success', `Removed ${proposal.result.productsRemoved} product${proposal.result.productsRemoved === 1 ? '' : 's'} added by ${proposal.result.sourceName}. The audit history remains.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/document-removals/${req.params.id}`);
}));

router.post('/document-removals/:id/cancel', asyncRoute(async (req, res) => {
  documentRemovals.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No products or stock were changed.');
  return res.redirect(303, '/');
}));

router.get('/catalog-code-changes/:id', asyncRoute(async (req, res) => {
  const proposal = catalogCodeChanges.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/catalog-code-change', {
    title: proposal.status === 'COMPLETED' ? 'Catalogue codes changed' : 'Review catalogue code changes',
    nav: 'inventory', proposal,
  });
}));

router.post('/catalog-code-changes/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const proposal = catalogCodeChanges.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash)
    );
    req.flash('success', `Changed ${proposal.result.productCount} product code${proposal.result.productCount === 1 ? '' : 's'} and ${proposal.result.skuCount} SKU${proposal.result.skuCount === 1 ? '' : 's'}.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/catalog-code-changes/${req.params.id}`);
}));

router.post('/catalog-code-changes/:id/cancel', asyncRoute(async (req, res) => {
  catalogCodeChanges.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No catalogue codes were changed.');
  return res.redirect(303, '/');
}));

router.post('/operating-instructions/:id/approve', asyncRoute(async (req, res) => {
  try {
    const proposal = operatingInstructions.approve(req.db, req.ctx, req.user, req.params.id, req.body.integrityHash);
    req.flash('success', `Remembered. ${proposal.resolvedChanges.length === 1 ? 'This rule is' : 'These rules are'} now active and future events will use them.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/operating-instructions/${req.params.id}`);
}));

router.post('/operating-instructions/:id/cancel', asyncRoute(async (req, res) => {
  operatingInstructions.cancel(req.db, req.ctx, req.params.id);
  req.flash('success', 'Left unchanged. Foundry did not remember that instruction.');
  return res.redirect(303, '/');
}));

router.post('/operating-instructions/:id/answer', asyncRoute(async (req, res) => {
  try {
    const proposal = await operatingInstructions.answer(req.db, req.ctx, req.user, req.params.id, req.body.answer, {
      provider: req.app.locals.aiProvider || undefined,
    });
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
    return res.redirect(303, `/operating-instructions/${req.params.id}`);
  }
}));

router.post('/operating-instructions/:id/select-product', asyncRoute(async (req, res) => {
  try {
    const proposal = operatingInstructions.selectProduct(
      req.db, req.ctx, req.user, req.params.id, req.body.skuId
    );
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
    return res.redirect(303, `/operating-instructions/${req.params.id}`);
  }
}));

router.post('/operating-instructions/:id/remove', asyncRoute(async (req, res) => {
  try {
    operatingInstructions.remove(req.db, req.ctx, req.user, req.params.id);
    req.flash('success', 'Rule removed. Foundry will no longer follow it.');
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, '/settings#learned-instructions');
}));

/**
 * Finishing one thing Foundry could not record.
 *
 * The card used to point at the general Tell Foundry box, where the only thing
 * a customer could do was retype the sentence that had already failed. This
 * takes the sentence they already gave, works it out again now, and lands them
 * on whatever actually resolves it:
 *
 *   it resolves      → the prepared change, ready to approve
 *   it needs an answer → that exact question, with a box to answer it, and the
 *                        original sentence carried along so nothing is retyped
 *   a rule refuses it → the refusal, with the ways out
 *
 * The event is closed the moment it stops being something waiting for a person,
 * rather than being left behind as a second copy of a job already done.
 */
router.get(
  '/needs-you/event/:id',
  asyncRoute(async (req, res) => {
    const event = physicalEvents.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!event) {
      req.flash('error', 'That is no longer waiting for you.');
      return res.redirect(303, '/needs-you');
    }

    const result = await actionService.interpret(req.db, req.ctx, req.user, event.statedAs, {
      provider: req.app.locals.aiProvider || undefined,
    });

    // It resolves now: the change is prepared and the event has been dealt with.
    const target = actionRedirect(result);
    if (target) {
      physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
      req.flash('info', 'Foundry worked this out. Nothing changes until you approve it.');
      return res.redirect(303, target);
    }

    // It needs an answer. The question is carried to the one screen that can
    // take it, along with the sentence, so answering continues the original
    // request instead of starting a new one.
    if (result.kind === 'question' && result.question) {
      req.session.pendingActionQuestion = {
        question: result.question,
        instruction: event.statedAs,
        choices: result.choices || null,
        physicalEventId: event.id,
      };
      return res.redirect(303, '/actions');
    }

    if (result.kind === 'unsupported' && result.message) {
      physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
      req.session.pendingActionQuestion = {
        unsupported: result.message,
        blocked: result.blocked || null,
        instruction: event.statedAs,
      };
      return res.redirect(303, '/actions');
    }

    // Nothing above fits. Say so plainly rather than bouncing them somewhere.
    req.session.pendingActionQuestion = {
      question: 'What should Foundry record for this? Say the product, the place and how many.',
      instruction: event.statedAs,
      physicalEventId: event.id,
    };
    return res.redirect(303, '/actions');
  })
);

router.get('/needs-you', asyncRoute(async (req, res) => {
  // An opening-balance investigation is answered by recording the stock, and
  // the person who just recorded it should not be asked for it again.
  investigations.settleOpeningBalances(req.db, req.ctx.workspaceId);
  const operating = managerReadiness.decisions(req.db, req.ctx.workspaceId);
  const openInvestigations = investigations.list(req.db, req.ctx.workspaceId, {
    statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 100,
  });
  const waiting = workItems.awaitingApproval(req.db, req.ctx.workspaceId);
  const physical = req.db.prepare(
    `SELECT id, event_type, stated_as, details, created_at FROM physical_events
      WHERE workspace_id = ? AND status = 'NEEDS_HUMAN' AND investigation_id IS NULL
      ORDER BY created_at DESC`
  ).all(req.ctx.workspaceId).map((row) => {
    // Why it is waiting matters more than what it is called. Echoing somebody's
    // own sentence back at them under the words "reported event" tells them
    // nothing about what Foundry needs before it can act on it.
    let reason = null;
    try { reason = JSON.parse(row.details || '{}').interpretationReason || null; } catch { reason = null; }
    return { ...row, reason };
  });
  res.page('manager/needs-you', {
    title: 'Needs you', nav: 'attention', operating,
    // One list, built by one contract. The per-mechanism collections below are
    // still passed for anything else reading this page, but the page itself
    // renders the inbox.
    inbox: needsYouInbox.inbox(req.db, req.ctx.workspaceId),
    // Which slice of the inbox is on screen. Filtering happens in the view over
    // the list it already has, so the filter is a link rather than something
    // that only works once JavaScript has loaded.
    show: ['urgent', 'important'].includes(String(req.query.show || '')) ? String(req.query.show) : 'all',
    investigations: openInvestigations, waiting, physical,
    // The same findings the home page counts under "what needs me". They were
    // missing here, so home said one decision was waiting and the page it sent
    // you to said nothing was.
    findings: autopilotPresenter.whatNeedsYou(req.db, req.ctx.workspaceId),
    // A correction that has been confirmed but not yet approved is still
    // somebody's job. Without it here, confirming a count emptied Needs you
    // while the ledger was known to be wrong.
    corrections: proposals
      .listOpen(req.db, req.ctx.workspaceId, { limit: 20 })
      .filter((proposal) => proposal.status === 'AWAITING_APPROVAL')
      .map((proposal) => ({
        proposalId: proposal.proposalId,
        summary: actionPresenter.oneLine(req.db, req.ctx.workspaceId, proposal),
        actionType: proposal.actionType,
      })),
  });
}));

router.get('/investigations/:id', asyncRoute(async (req, res) => {
  investigations.settleOpeningBalances(req.db, req.ctx.workspaceId);
  const investigation = investigations.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('manager/investigation', { title: 'Investigation', nav: 'attention', investigation,
    events: investigations.events(req.db, req.ctx.workspaceId, req.params.id) });
}));

/**
 * Confirming a count and correcting the ledger are one job in two halves.
 *
 * Resolving an investigation deliberately does not touch stock, and it must
 * stay that way — a button that silently writes a balance is the thing this
 * whole layer exists to avoid. But closing the investigation and stopping there
 * left the opposite problem: Foundry had confirmed physical evidence that the
 * shelf held five, went on recording eight, and reported that nothing needed
 * anybody. Known-wrong inventory with an empty exceptions list is worse than an
 * open question.
 *
 * So confirming prepares the ordinary correction instead — the same adjust
 * proposal any person could raise, carrying the count and the words they
 * confirmed it with — and it waits for the same approval as every other
 * correction. Nothing here writes a balance.
 */
router.post('/investigations/:id/resolve', asyncRoute(async (req, res) => {
  const note = trimOrNull(req.body.note);
  const investigation = investigations.get(req.db, req.ctx.workspaceId, req.params.id);
  const entities = (investigation && investigation.affectedEntities) || {};
  const observed = Number((investigation && investigation.observedDifference || {}).observed);
  const wantsCorrection = req.body.correct === '1';

  investigations.resolve(req.db, req.ctx, req.params.id, note);
  reactions.publishAndReact(req.db, req.ctx.workspaceId, managerEvents.TYPES.COUNT_CONFIRMED, {
    investigationId: req.params.id,
    skuId: entities.skuId || null,
    locationId: entities.locationId || null,
    observed: Number.isFinite(observed) ? observed : null,
  }, { sourceRecordType: 'investigation', sourceRecordId: `${req.params.id}:resolved` });

  if (wantsCorrection && entities.skuId && entities.locationId && Number.isFinite(observed)) {
    const location = req.db
      .prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
      .get(entities.locationId, req.ctx.workspaceId);
    const built = proposals.build(req.db, req.ctx, {
      actionType: 'adjust',
      resolvedSkuId: entities.skuId,
      lotCode: '',
      serials: [],
      sourceLocation: location ? location.name : '',
      destinationLocation: '',
      quantity: -1,
      adjustmentTarget: observed,
      reasonCode: 'physical_count',
      assumptions: [
        `Counted ${observed} against ${investigation.observedDifference.expected} on record.`,
        note ? `You confirmed it: “${note}”` : 'You confirmed the physical count.',
      ].filter(Boolean),
    });

    if (built.ok) {
      const stored = proposals.persist(req.db, req.ctx, built.proposal, {
        sourceType: 'FOUNDRY_RECOMMENDATION',
        instruction: `Confirmed physical count of ${observed} for ${entities.displayName || 'this product'}`,
      });
      req.flash(
        'success',
        'Count confirmed. Foundry prepared the correction to the ledger — it still needs your approval, '
          + 'and nothing has changed yet.'
      );
      return res.redirect(303, `/actions/${stored.proposalId}`);
    }

    // The ledger may already agree by the time this is confirmed. Say so rather
    // than pretending a correction is waiting.
    req.flash('info', built.unsupported || built.question
      || 'Foundry could not prepare that correction. The investigation is closed and stock is unchanged.');
    return res.redirect(303, '/needs-you');
  }

  req.flash('success', 'Investigation closed without changing stock. The evidence remains in Activity.');
  res.redirect(303, '/needs-you');
}));

module.exports = router;
