'use strict';

const express = require('express');
const intentRouter = require('../../manager/intent-router');
const managerContext = require('../../manager/context');
const investigations = require('../../manager/investigations');
const physicalEvents = require('../../manager/physical-events');
const documentEvents = require('../../manager/document-events');
const managerReadiness = require('../../manager/readiness');
const actionService = require('../../actions/action-service');
const proposals = require('../../actions/proposal-service');
const actionPresenter = require('../../actions/presenter');
const importPlans = require('../../imports/plan-service');
const workItems = require('../../autopilot/work-items');
const policyAuthor = require('../../autopilot/policy-author');
const managerRunner = require('../../autopilot/runner');
const supplierCodeMappings = require('../../purchasing/supplier-code-mappings');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use(['/foundry/tell', '/needs-you', '/investigations'], requireAuth);

function actionRedirect(result) {
  if (result.kind === 'proposal' || result.kind === 'existing') return `/actions/${result.proposal.proposalId}`;
  if (result.kind === 'plan') return `/actions/plan/${result.plan.planId}`;
  return null;
}

router.post('/foundry/tell', asyncRoute(async (req, res) => {
  const attached = (req.files || []).find((entry) => entry.field === 'file' && entry.size > 0);
  const message = trimOrNull(req.body.message) || (attached ? `Import ${attached.filename}` : '');
  const tabular = attached && /\.(csv|tsv|xlsx|xls|txt)$/i.test(attached.filename || '');
  const operationalDocument = attached && /\.(pdf|docx|xlsx|xls|csv|tsv|txt)$/i.test(attached.filename || '');
  const receivingHint = /arriv|deliver|shipment|packing|receive|received|supplier invoice/i.test(message);
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
    });
    req.flash('success', `Foundry read ${attached.filename}. Review the exact changes before anything is applied.`);
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

  const intent = await intentRouter.classify(req.db, req.ctx, message, {
    provider: req.app.locals.aiProvider || undefined,
  });
  // A question from the classifier is a last resort, not a first one.
  //
  // It is written by a model that has seen only the sentence, while the
  // handlers below can look at the actual records — so it asked "should this go
  // to your regular supplier?" where the grounded answer was "no supplier is on
  // file for Trail Ration Pack". Whenever there is a handler that can resolve
  // or ask from real data, it gets the chance first.
  if (intent.clarifyingQuestion && intent.intentClass === 'UNKNOWN') {
    req.flash('info', intent.clarifyingQuestion);
    return res.redirect(303, '/#tell-foundry');
  }
  if (['QUESTION', 'EXPLANATION'].includes(intent.intentClass)) {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'ask');
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }
  if (intent.intentClass === 'IMPORT') {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'attachment_required', null, 'NEEDS_CLARIFICATION');
    req.flash('info', 'Attach the spreadsheet, PDF or document you want Foundry to read.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.intentClass === 'PURCHASING_REQUEST') {
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
  if (intent.intentClass === 'CONFIGURATION_CHANGE') {
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
  if (['INVENTORY_ACTION', 'CATALOG_CHANGE', 'CONFIGURATION_CHANGE'].includes(intent.intentClass)) {
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
      req.session.pendingActionQuestion = { question: result.question, instruction: message, choices: result.choices || null };
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
  if (intent.intentClass === 'PHYSICAL_EVENT') {
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
  if (intent.intentClass === 'INVESTIGATION_REQUEST') {
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
  if (intent.intentClass === 'STOP') {
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
  if (intent.intentClass === 'POLICY_CHANGE') {
    const reviewEverything = /handle\s+everything|everything\s+you\s+(?:safely\s+)?can/i.test(message);
    const drafted = reviewEverything ? null : await policyAuthor.draft(req.db, req.ctx.workspaceId, message, {
      provider: req.app.locals.aiProvider || undefined,
    });
    if (drafted) req.session.policyDraft = drafted;
    if (reviewEverything) req.session.policyReviewAll = true;
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'policy_settings');
    req.flash('info', reviewEverything
      ? 'Unlimited authority is never created. Foundry opened the bounded transfer and purchasing policies it can safely support.'
      : drafted.understood
        ? 'Foundry prepared exact authority boundaries. Review and write the policy; it remains inactive until separately approved.'
        : drafted.unsupportedReason);
    return res.redirect(303, '/autopilot');
  }
  req.flash('info', 'Foundry could not safely route that yet. Say what happened or what outcome you want.');
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
