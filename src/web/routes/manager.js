'use strict';

const express = require('express');
const intentRouter = require('../../manager/intent-router');
const managerContext = require('../../manager/context');
const investigations = require('../../manager/investigations');
const physicalEvents = require('../../manager/physical-events');
const documentEvents = require('../../manager/document-events');
const managerReadiness = require('../../manager/readiness');
const actionService = require('../../actions/action-service');
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
  if (intent.clarifyingQuestion) {
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
    const reference = intent.resolvedReference;
    if (reference && /^po_/.test(reference)) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'purchase_order', reference);
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: reference });
      return res.redirect(303, /receive|arriv|rest/i.test(message)
        ? `/purchasing/orders/${reference}/receive` : `/purchasing/orders/${reference}`);
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
    req.flash(result.kind === 'question' ? 'info' : 'error', result.question || result.message || 'Foundry needs more detail.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.intentClass === 'PHYSICAL_EVENT') {
    const event = await physicalEvents.recordNatural(req.db, req.ctx, message, {
      provider: req.app.locals.aiProvider || undefined,
    });
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'physical_event', event.id);
    req.flash('info', event.status === 'ROUTED'
      ? 'Foundry matched that event. Check the receiving details before stock changes.'
      : 'Foundry recorded the physical event and put the unresolved part in Needs you.');
    return res.redirect(303, event.matchedEntities.purchaseOrderId
      ? `/purchasing/orders/${event.matchedEntities.purchaseOrderId}` : '/needs-you');
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

router.get('/needs-you', asyncRoute(async (req, res) => {
  const operating = managerReadiness.decisions(req.db, req.ctx.workspaceId);
  const openInvestigations = investigations.list(req.db, req.ctx.workspaceId, {
    statuses: ['NEEDS_HUMAN', 'INCONCLUSIVE'], limit: 100,
  });
  const waiting = workItems.awaitingApproval(req.db, req.ctx.workspaceId);
  const physical = req.db.prepare(
    `SELECT id, event_type, stated_as, created_at FROM physical_events
      WHERE workspace_id = ? AND status = 'NEEDS_HUMAN' AND investigation_id IS NULL
      ORDER BY created_at DESC`
  ).all(req.ctx.workspaceId);
  res.page('manager/needs-you', {
    title: 'Needs you', nav: 'attention', operating,
    investigations: openInvestigations, waiting, physical,
  });
}));

router.get('/investigations/:id', asyncRoute(async (req, res) => {
  const investigation = investigations.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('manager/investigation', { title: 'Investigation', nav: 'attention', investigation,
    events: investigations.events(req.db, req.ctx.workspaceId, req.params.id) });
}));

router.post('/investigations/:id/resolve', asyncRoute(async (req, res) => {
  investigations.resolve(req.db, req.ctx, req.params.id, trimOrNull(req.body.note));
  req.flash('success', 'Investigation resolved. The evidence remains in Activity.');
  res.redirect(303, '/needs-you');
}));

module.exports = router;
