'use strict';

const express = require('express');
const config = require('../../config');
const understandingService = require('../../foundry/understanding-service');
const planBuilder = require('../../foundry/plan-builder');
const firstItemService = require('../../foundry/first-item-service');
const documentIntake = require('../../foundry/document-intake');
const scopeSafety = require('../../imports/scope-safety');
const planApplier = require('../../foundry/plan-applier');
const onboardingPaths = require('../../onboarding/paths');
const assistant = require('../../foundry/assistant-service');
const jobRunner = require('../../foundry/job-runner');
const inventoryQuery = require('../../domain/inventory-query');
const repo = require('../../domain/repository');
const inventoryEngine = require('../../domain/inventory-engine');
const { ValidationError } = require('../../domain/errors');
const { inTransaction } = require('../../db');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { toArray, trimOrNull, nowIso } = require('../../lib/util');
const syntheticMode = require('../../synthetic/data-mode');
const syntheticRequest = require('../../synthetic/request-spec');
const onboardingPriority = require('../../foundry/onboarding-priority');
const realBusinessGrounding = require('../../foundry/real-business-grounding');

const router = express.Router();
router.use('/foundry', requireAuth);
router.use('/api/foundry', requireAuth);

/** First run shows setup; a configured workspace gets Foundry's home. */
router.get(
  // /foundry/describe is the Starting Fresh path: the same Mission 2 screen,
  // reached deliberately rather than shown to everybody by default.
  ['/foundry', '/foundry/describe'],
  asyncRoute(async (req, res) => {
    const configuration = planApplier.getConfiguration(req.db, req.ctx.workspaceId);
    if (configuration && configuration.configuredAt) {
      const stats = inventoryQuery.overview(req.db, req.ctx.workspaceId);
      return res.page('foundry/home', {
        title: 'Foundry',
        nav: 'foundry',
        configuration,
        stats,
        messages: assistant.listMessages(req.db, req.ctx.workspaceId, 30),
        plan: planBuilder.latestPlan(req.db, req.ctx.workspaceId),
        aiConfigured: config.ai.configured,
      });
    }

    // Before Mission 7 everyone landed on "describe your business". That is the
    // right question only for someone starting from nothing, so it now sits
    // behind the choice of how they manage inventory today.
    const onboarding = onboardingPaths.ensure(req.db, req.ctx.workspaceId);
    if (onboarding.path === 'undecided' && req.path !== '/foundry/describe') {
      return res.redirect(303, '/onboarding');
    }

    return res.page('foundry/setup', {
      title: 'Set up your inventory',
      nav: 'foundry',
      otherWorkspaces: Math.max(0, (res.locals.workspaces || []).length - 1),
      aiConfigured: config.ai.configured,
      description: '',
      error: null,
    });
  })
);


/** A filename means nothing without knowing whether it is a page or a catalogue. */
function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} bytes`;
}

/** Enough of their own sentence to recognise it, cut at a word. */
function firstWords(text, max = 90) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

/**
 * Reading a business takes a minute or more of real model time, so the request
 * starts a background job and hands back a page that reports progress. Holding
 * the POST open would just spin the browser with nothing to show.
 */
router.post(
  '/foundry/understand',
  asyncRoute(async (req, res) => {
    const description = trimOrNull(req.body.description) || '';
    const source = (req.files || []).find((file) => file.field === 'source' && file.size > 0) || null;

    // A real document is a complete starting point. Text-only setup still needs
    // enough context to understand the operation safely.
    if (!source && description.length < understandingService.MIN_DESCRIPTION) {
      return res.status(400).page('foundry/setup', {
        title: 'Set up your inventory',
        nav: 'foundry',
      otherWorkspaces: Math.max(0, (res.locals.workspaces || []).length - 1),
        aiConfigured: config.ai.configured,
        description,
        error: 'Add an invoice, spreadsheet, Word document, or PDF — or tell Foundry a sentence or two about what you keep track of.',
      });
    }

    /*
     * The progress screen names its own subject.
     *
     * Waiting a minute in front of "Foundry is reading your inventory" with no
     * sign of *what* it is reading is indistinguishable from a stalled page.
     * The filename, or the opening of what they typed, is theirs and proves
     * the right thing arrived.
     */
    const ctx = req.ctx;
    const db = req.db;
    const membership = req.user;
    const provider = req.app.locals.aiProvider || undefined;
    const jobId = jobRunner.createJob(req.ctx.workspaceId, 'understanding', description || '', {
      track: source ? 'document' : 'description',
      subject: source ? source.filename : firstWords(description),
      subjectDetail: source ? fileSize(source.size) : 'what you told Foundry',
      db: req.db,
    });

    jobRunner.run(jobId, async (setStage, signal) => {
      if (source) {
        const prepared = await documentIntake.prepare(db, ctx, membership, source, {
          provider,
          onStage: setStage,
          signal,
        });
        return { understandingId: prepared.understandingId, setupDocumentId: prepared.document.id };
      }
      const { id } = await understandingService.describeBusiness(db, ctx, description, {
        provider,
        onStage: setStage,
        signal,
      });
      return { understandingId: id };
    }, { db });

    return res.redirect(303, `/foundry/thinking/${jobId}`);
  })
);

/** The progress page. Works with JavaScript, and without it. */
router.get(
  '/foundry/thinking/:jobId',
  asyncRoute(async (req, res) => {
    const job = jobRunner.getJob(req.params.jobId, req.ctx.workspaceId, req.db);

    if (!job) {
      req.flash('error', 'That went out of date — Foundry can read your description again.');
      return res.redirect(303, '/foundry');
    }
    if (job.status === 'done' && job.result) {
      return res.redirect(303, `/foundry/proposal/${job.result.understandingId}`);
    }
    if (job.status === 'failed') {
      return res.status(400).page('foundry/setup', {
        title: 'Set up your inventory',
        nav: 'foundry',
      otherWorkspaces: Math.max(0, (res.locals.workspaces || []).length - 1),
        aiConfigured: config.ai.configured,
        description: job.description || '',
        error: job.error.message,
      });
    }

    return res.page('foundry/thinking', {
      title: 'Foundry is reading your inventory',
      nav: 'foundry',
      job,
      stages: jobRunner.STAGES,
    });
  })
);

/** Polled by the progress page. */
router.get(
  '/api/foundry/jobs/:jobId',
  asyncRoute(async (req, res) => {
    const job = jobRunner.getJob(req.params.jobId, req.ctx.workspaceId, req.db);
    if (!job) return res.status(404).json({ error: { code: 'not_found', message: 'No such job.' } });

    return res.json({
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
      stageDetail: job.stageDetail,
      // How long each finished step actually took, so the page can stamp them
      // rather than only counting the total upward.
      timeline: job.timeline,
      elapsedMs: job.elapsedMs,
      redirectTo:
        job.status === 'done' && job.result ? `/foundry/proposal/${job.result.understandingId}` : null,
      error: job.error ? job.error.message : null,
    });
  })
);

/** The traditional Mission 1 path stays available for people who prefer it. */
router.post(
  '/foundry/manual',
  asyncRoute(async (req, res) => {
    const now = nowIso();
    req.db
      .prepare(
        `INSERT INTO workspace_configuration (workspace_id, configured_at, configuration_version, terminology,
           operational_defaults, inventory_model, updated_at)
         VALUES (?, ?, 0, '{}', '{"adjustmentsRequireReason":true,"allowNegativeStock":false,"transfersEnabled":true}', '{}', ?)
         ON CONFLICT(workspace_id) DO UPDATE SET configured_at = COALESCE(workspace_configuration.configured_at, excluded.configured_at), updated_at = excluded.updated_at`
      )
      .run(req.ctx.workspaceId, now, now);
    req.flash('info', 'Set up manually. Foundry is still here whenever you want it.');
    res.redirect(303, '/locations');
  })
);

router.get(
  '/foundry/proposal/:id',
  asyncRoute(async (req, res) => {
    const stored = understandingService.getUnderstanding(req.db, req.ctx.workspaceId, req.params.id);
    if (!stored) {
      req.flash('error', 'That proposal is no longer available. Describe your inventory again.');
      return res.redirect(303, '/foundry');
    }
    const setupDocument = documentIntake.getByUnderstanding(req.db, req.ctx.workspaceId, stored.id);
    const generationContext = syntheticMode.context(req.db, req.ctx.workspaceId, stored.source_description);
    const displayUnderstanding = JSON.parse(JSON.stringify(stored.understanding));
    if (generationContext.mode === 'production' && stored.provider !== 'document-evidence') {
      realBusinessGrounding.ground(displayUnderstanding, stored.source_description);
    }
    const nextOnboardingStep = onboardingPriority.nextStep(req.db, req.ctx.workspaceId, {
      workspaceMode: generationContext.mode,
      hasDocument: Boolean(setupDocument),
      understanding: displayUnderstanding,
    });
    if (setupDocument?.status === 'APPLIED') {
      req.flash('warning', `Duplicate ignored: ${setupDocument.sourceName} was already imported${setupDocument.appliedAt ? ` on ${new Date(setupDocument.appliedAt).toLocaleString()}` : ''}. Foundry added nothing again.`);
      return res.redirect(303, '/inventory');
    }
    return res.page('foundry/proposal', {
      room: true,
      title: "Here's how I'd organize your inventory",
      nav: 'foundry',
      understandingId: stored.id,
      understanding: displayUnderstanding,
      syntheticSetup: generationContext.allowed ? syntheticRequest.parse(stored.source_description) : null,
      onboardingPriority: nextOnboardingStep,
      setupDocument,
      /*
       * What this document proves, worked out before the page describes what
       * Foundry would build from it. The order matters: somebody approving an
       * import should read what Foundry thinks the paper means before they
       * read a summary of products and quantities, because the summary looks
       * the same whether the goods exist or not.
       */
      documentMeaning: setupDocument
        ? require('../../foundry/document-meaning').meaningOf(setupDocument.interpretation, {
          isNewWorkspace: !planApplier.isConfigured(req.db, req.ctx.workspaceId),
          /*
           * The order this bill is about, if Foundry can find it. With one,
           * the page says "it matches PO-1055 and nothing needs you"; without
           * one it has to ask whether goods are expected, because a business
           * buying outside Foundry is normal and inventing the purchase would
           * not be.
           */
          matchedPurchaseOrder: (() => {
            const invoices = require('../../foundry/supplier-invoice-intake');
            const supplier = req.db.prepare('SELECT id FROM suppliers WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
              .get(req.ctx.workspaceId, setupDocument.interpretation.supplierName);
            const found = invoices.findOrder(req.db, req.ctx.workspaceId,
              setupDocument.interpretation, supplier ? supplier.id : null);
            return found ? { poNumber: found.po_number, id: found.id } : null;
          })(),
        })
        : null,
      documentMatches: setupDocument
        ? documentIntake.matchPreview(req.db, req.ctx.workspaceId, setupDocument.interpretation)
        : [],
      scopeWarning: setupDocument
        ? scopeSafety.fromDocument(req.db, req.ctx.workspaceId, setupDocument.interpretation)
        : { needsConfirmation: false },
      alreadyConfigured: planApplier.isConfigured(req.db, req.ctx.workspaceId),
      recommendations: understandingService.listRecommendations(req.db, req.ctx.workspaceId, stored.id),
      existingLocations: repo.listLocations(req.db, req.ctx.workspaceId),
    });
  })
);

/** Approve: build the plan from the answers, then apply it. */
router.post(
  '/foundry/proposal/:id/configure',
  requireOwner,
  asyncRoute(async (req, res) => {
    const existingDocument = documentIntake.getByUnderstanding(req.db, req.ctx.workspaceId, req.params.id);
    if (existingDocument && existingDocument.status === 'APPLIED' && existingDocument.appliedPlanId) {
      return res.redirect(303, `/foundry/ready/${existingDocument.appliedPlanId}`);
    }
    if (existingDocument) {
      const scopeWarning = scopeSafety.fromDocument(req.db, req.ctx.workspaceId, existingDocument.interpretation);
      if (scopeWarning.needsConfirmation && !existingDocument.scopeConfirmedAt) {
        if (req.body.scopeDecision === 'confirm') {
          documentIntake.confirmScope(req.db, req.ctx, req.params.id);
          req.flash('success', `Confirmed: continue reviewing this file for ${scopeWarning.workspaceName}. Nothing has been added yet.`);
          return res.redirect(303, `/foundry/proposal/${req.params.id}`);
        }
        req.flash('warning', `Confirm that this file belongs in ${scopeWarning.workspaceName} before continuing.`);
        return res.redirect(303, `/foundry/proposal/${req.params.id}`);
      }
    }
    const answers = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (!key.startsWith('answer_')) continue;
      const questionId = key.slice('answer_'.length);
      const answer = trimOrNull(value);
      // '__foundry__' means "let Foundry decide" — recorded, not answered.
      if (answer && answer !== '__foundry__') answers[questionId] = answer;
    }

    try {
      const alreadyConfigured = planApplier.isConfigured(req.db, req.ctx.workspaceId);
      const ownerInventoryLines = parseOwnerInventoryLines(req.body);
      const planId = inTransaction(req.db, () => {
        if (existingDocument) {
          documentIntake.setSupplierCodeLabel(req.db, req.ctx, req.params.id, req.body.supplierCodeLabel);
        }
        const built = planBuilder.buildPlan(req.db, req.ctx, {
          understandingId: req.params.id,
          answers,
          acceptedRecommendationIds: toArray(req.body.acceptRecommendation),
          ownerInventoryLines,
        });
        // A later supplier invoice adds evidenced records to the operation; it
        // must not replace the inventory model the owner already configured.
        if (!alreadyConfigured || ownerInventoryLines.length) {
          planApplier.applyPlan(req.db, req.ctx, built.planId, { updateConfiguration: !alreadyConfigured });
        }
        /*
         * Which button the owner pressed. The document says what it is; this
         * says what they want done about it, and the two are different
         * questions — a proforma is still a proforma whether they are placing
         * the order or using it as the opening count of a new business.
         */
        documentIntake.apply(req.db, req.ctx, req.user, req.params.id, built.planId, {
          documentIntent: trimOrNull(req.body.documentIntent),
        });
        return built.planId;
      });
      res.redirect(303, `/foundry/ready/${planId}`);
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      req.flash('error', error.message);
      res.redirect(303, `/foundry/proposal/${req.params.id}`);
    }
  })
);

function parseOwnerInventoryLines(body) {
  if (body.owner_records_present !== '1') return [];
  const count = Number.parseInt(body.owner_record_count, 10);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    throw new ValidationError('Review the inventory records and try again.');
  }
  const lines = [];
  for (let index = 0; index < count; index += 1) {
    const productName = trimOrNull(body[`owner_product_${index}`]);
    const variantLabel = trimOrNull(body[`owner_variant_${index}`]) || '';
    const locationName = trimOrNull(body[`owner_location_${index}`]);
    const quantityText = String(body[`owner_quantity_${index}`] || '').trim();
    const quantity = Number(quantityText);
    if (!productName) throw new ValidationError(`Enter the product name on row ${index + 1}.`);
    if (!locationName) throw new ValidationError(`Enter where the stock is located on row ${index + 1}.`);
    if (!/^\d+$/.test(quantityText) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000000) {
      throw new ValidationError(`Enter a whole-number quantity above zero on row ${index + 1}.`);
    }
    lines.push({ productName, variantLabel, quantity, locationName });
  }
  return lines;
}

router.get(
  '/foundry/ready/:planId',
  asyncRoute(async (req, res) => {
    const stored = planBuilder.getPlan(req.db, req.ctx.workspaceId, req.params.planId);
    if (!stored) {
      req.flash('error', 'That configuration could not be found.');
      return res.redirect(303, '/foundry');
    }
    return res.page('foundry/ready', {
      title: 'Your inventory is ready',
      nav: 'foundry',
      plan: stored.plan,
      summary: stored.applied_summary ? JSON.parse(stored.applied_summary) : null,
      setupDocument: documentIntake.getByPlan(req.db, req.ctx.workspaceId, stored.id),
      addedToExisting: Boolean(documentIntake.getByPlan(req.db, req.ctx.workspaceId, stored.id) && !stored.applied_summary),
      decisions: planBuilder.listDecisions(req.db, req.ctx.workspaceId, stored.id),
      acceptedRecommendations: understandingService.listAcceptedRecommendations(
        req.db,
        req.ctx.workspaceId,
        stored.id
      ),
      // What Foundry would create from what they already described. Null once
      // the inventory has anything in it.
      firstItem: firstItemService.suggest(req.db, req.ctx.workspaceId),
    });
  })
);

/**
 * Creates the product the customer described, with the combinations they listed.
 *
 * The shape comes from their own words; the quantity comes from nobody, because
 * nobody has said what is on the shelf yet.
 */
router.post(
  '/foundry/first-item',
  asyncRoute(async (req, res) => {
    const suggestion = firstItemService.suggest(req.db, req.ctx.workspaceId);
    if (!suggestion) {
      req.flash('info', 'There is already something in this inventory.');
      return res.redirect(303, '/inventory');
    }
    try {
      const created = firstItemService.create(req.db, req.ctx, {
        ...suggestion,
        // Whatever they edited on the page wins over the suggestion.
        name: trimOrNull(req.body.name) || suggestion.name,
      });
      req.flash(
        'success',
        created.skuCount > 1
          ? `Created ${created.name} with ${created.skuCount} combinations. Nothing is in stock yet — receive some to get started.`
          : `Created ${created.name}. Nothing is in stock yet — receive some to get started.`
      );
      onboardingPaths.setStatus(req.db, req.ctx.workspaceId, 'collecting');
      return res.redirect(303, `/foundry/quantities/${created.itemId}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/foundry/ready');
    }
  })
);

/**
 * Finish the starting-fresh conversation. Foundry has built the structure, but
 * it must not pretend that zeroes are the customer's real stock. The customer
 * chooses how to supply current quantities instead of being dropped into a
 * traditional item screen.
 */
router.get(
  '/foundry/quantities',
  asyncRoute(async (req, res) => {
    const item = req.db
      .prepare('SELECT id FROM items WHERE workspace_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1')
      .get(req.ctx.workspaceId);
    if (!item) return res.redirect(303, '/foundry');
    return res.redirect(303, `/foundry/quantities/${item.id}`);
  })
);

router.get(
  '/foundry/quantities/:itemId',
  asyncRoute(async (req, res) => {
    onboardingPaths.reconcileWithInventoryTruth(req.db, req.ctx.workspaceId);
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.itemId);
    const skus = repo.listSkusForItem(req.db, req.ctx.workspaceId, item.id);
    const locations = repo.listLocations(req.db, req.ctx.workspaceId);
    const total = req.db
      .prepare(
        `SELECT COALESCE(SUM(b.on_hand), 0) AS total
           FROM balances b JOIN skus s ON s.id = b.sku_id
          WHERE b.workspace_id = ? AND s.item_id = ?`
      )
      .get(req.ctx.workspaceId, item.id).total;

    return res.page('foundry/quantities', {
      title: 'Add your current quantities',
      nav: 'foundry',
      item,
      skus,
      skuCount: skus.length,
      locations,
      total,
      canEnterGrid: skus.every((sku) => sku.tracking_mode === 'quantity'),
    });
  })
);

router.post(
  '/foundry/quantities/:itemId/save',
  requireOwner,
  asyncRoute(async (req, res) => {
    const item = repo.requireItem(req.db, req.ctx.workspaceId, req.params.itemId);
    const allowedSkus = new Set(repo.listSkusForItem(req.db, req.ctx.workspaceId, item.id)
      .filter((sku) => sku.tracking_mode === 'quantity').map((sku) => sku.id));
    const allowedLocations = new Set(repo.listLocations(req.db, req.ctx.workspaceId).map((location) => location.id));
    const skuIds = toArray(req.body.skuId);
    const locationIds = toArray(req.body.locationId);
    const quantities = toArray(req.body.quantity);
    let recorded = 0;

    inTransaction(req.db, () => {
      for (let index = 0; index < skuIds.length; index += 1) {
        const skuId = skuIds[index];
        const locationId = locationIds[index];
        const raw = String(quantities[index] ?? '').trim();
        if (!raw) continue;
        const quantity = Number(raw);
        if (!allowedSkus.has(skuId) || !allowedLocations.has(locationId)
          || !Number.isInteger(quantity) || quantity < 0) {
          throw new ValidationError('Enter whole quantities of zero or more in the opening inventory grid.');
        }
        if (quantity === 0) continue;
        inventoryEngine.adjust(req.db, req.ctx, {
          skuId,
          locationId,
          countedQty: quantity,
          reasonCode: 'physical_count',
          notes: 'Opening inventory',
        });
        recorded += quantity;
      }
    });

    if (!recorded) {
      req.flash('info', 'No opening quantities were entered. Add at least one quantity, or choose “starting with no stock”.');
      return res.redirect(303, `/foundry/quantities/${item.id}`);
    }
    onboardingPaths.reconcileWithInventoryTruth(req.db, req.ctx.workspaceId);
    req.flash('success', `Opening inventory recorded: ${recorded} unit${recorded === 1 ? '' : 's'}.`);
    return res.redirect(303, '/');
  })
);

router.post(
  '/foundry/quantities/complete',
  asyncRoute(async (req, res) => {
    onboardingPaths.setStatus(req.db, req.ctx.workspaceId, 'ready');
    req.flash('success', 'Setup complete. Foundry is now watching and managing this inventory.');
    return res.redirect(303, '/');
  })
);

router.post(
  '/foundry/ask',
  asyncRoute(async (req, res) => {
    const question = trimOrNull(req.body.question) || '';
    try {
      await assistant.ask(req.db, req.ctx, question, {
        provider: req.app.locals.aiProvider || undefined,
      });
    } catch (err) {
      if (err.status && err.status < 500) {
        req.flash('error', err.message);
      } else {
        throw err;
      }
    }
    res.redirect(303, '/foundry#conversation');
  })
);

router.post(
  '/foundry/change',
  requireOwner,
  asyncRoute(async (req, res) => {
    const request = trimOrNull(req.body.request) || '';
    const result = await assistant.proposeChange(req.db, req.ctx, request, {
      provider: req.app.locals.aiProvider || undefined,
    });
    if (!result.supported) {
      req.flash('info', 'Foundry explained why that is not something it can change yet.');
      return res.redirect(303, '/foundry#conversation');
    }
    return res.redirect(303, `/foundry/change/${result.planId}`);
  })
);

router.get(
  '/foundry/change/:planId',
  asyncRoute(async (req, res) => {
    const stored = planBuilder.getPlan(req.db, req.ctx.workspaceId, req.params.planId);
    if (!stored || stored.kind !== 'change') {
      req.flash('error', 'That change could not be found.');
      return res.redirect(303, '/foundry');
    }
    const current = planApplier.getConfiguration(req.db, req.ctx.workspaceId);
    return res.page('foundry/change', {
      title: 'Proposed change',
      nav: 'foundry',
      planId: stored.id,
      plan: stored.plan,
      current,
      applied: stored.status === 'applied',
      totals: inventoryQuery.overview(req.db, req.ctx.workspaceId),
    });
  })
);

router.post(
  '/foundry/change/:planId/apply',
  requireOwner,
  asyncRoute(async (req, res) => {
    assistant.applyChange(req.db, req.ctx, req.params.planId);
    req.flash('success', 'Configuration updated.');
    res.redirect(303, '/foundry');
  })
);

module.exports = router;
