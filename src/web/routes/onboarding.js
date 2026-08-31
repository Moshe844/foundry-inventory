'use strict';

/**
 * Getting a business's inventory into Foundry.
 *
 * The first question is no longer "describe your business" — that is the right
 * question for one kind of customer and the wrong one for everybody who already
 * has their inventory written down somewhere. So the first screen asks how they
 * manage it today, and each answer leads somewhere that suits it.
 */

const express = require('express');
const paths = require('../../onboarding/paths');
const sourceService = require('../../onboarding/source-service');
const migration = require('../../onboarding/migration-service');
const providerRegistry = require('../../connections/providers/registry');
const connections = require('../../connections/service');
const permissions = require('../../actions/permissions');
const config = require('../../config');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/onboarding', requireAuth);

/** The four paths. */
router.get(
  '/onboarding',
  asyncRoute(async (req, res) => {
    const state = paths.ensure(req.db, req.ctx.workspaceId);
    const hasProducts = Boolean(req.db.prepare(
      'SELECT 1 FROM items WHERE workspace_id = ? AND is_active = 1 LIMIT 1'
    ).get(req.ctx.workspaceId));
    // A model can understand the kind of business without receiving a single
    // real product record. Do not call that onboarding complete and trap the
    // owner on a Home page that points only to manual item entry.
    if (state.isComplete && hasProducts) return res.redirect(303, '/');

    return res.page('onboarding/start', {
      title: 'Get your inventory into Foundry',
      nav: 'foundry',
      state,
      paths: paths.PATHS,
      sourceOptions: paths.SOURCE_OPTIONS,
      recommendation: null,
      sourcePrompt: null,
      description: '',
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

router.post(
  '/onboarding/choose',
  asyncRoute(async (req, res) => {
    const chosen = trimOrNull(req.body.path);
    const state = paths.choose(req.db, req.ctx.workspaceId, chosen, {
      chosenBy: req.body.chosenBy === 'foundry' ? 'foundry' : 'customer',
      reason: req.body.reason,
      describedAs: req.body.describedAs,
    });
    return res.redirect(303, state.step);
  })
);

/** "Not sure — here's what's going on." */
router.post(
  '/onboarding/describe',
  asyncRoute(async (req, res) => {
    const description = trimOrNull(req.body.description) || '';
    const recommendation = paths.recommendFromDescription(description);
    const state = paths.ensure(req.db, req.ctx.workspaceId);

    return res.page('onboarding/start', {
      title: 'Get your inventory into Foundry',
      nav: 'foundry',
      state,
      paths: paths.PATHS,
      sourceOptions: paths.SOURCE_OPTIONS,
      recommendation,
      sourcePrompt: description && !recommendation
        ? 'That explains the kind of business, but it does not contain the actual product names, variants, locations, or quantities. Choose where Foundry should get those real records.'
        : null,
      description,
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

// Email is one supported way of supplying inventory evidence, alongside files,
// connected systems and manual entry. It belongs in onboarding, not somewhere
// a new owner has to discover in Settings.
router.get(
  '/onboarding/mailbox',
  asyncRoute(async (req, res) => {
    const connected = connections.list(req.db, req.ctx.workspaceId)
      .filter((row) => ['gmail', 'microsoft365'].includes(row.provider_type));
    return res.page('onboarding/mailbox', {
      title: 'Use inventory files from email',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      connected,
      providerCatalog: providerRegistry.catalog().filter((provider) =>
        ['gmail', 'microsoft365'].includes(provider.type)),
      canManageConnections: req.user.role === 'owner',
    });
  })
);

// ---------------------------------------------------------------------------
// Paths B and D — files
// ---------------------------------------------------------------------------

router.get(
  '/onboarding/files',
  asyncRoute(async (req, res) => {
    const state = paths.ensure(req.db, req.ctx.workspaceId);
    return res.page('onboarding/files', {
      title: 'Give Foundry what you have',
      nav: 'foundry',
      state,
      messy: req.query.mode === 'messy' || state.path === 'messy',
      sources: sourceService.list(req.db, req.ctx.workspaceId),
      plan: migration.latestPlan(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
      error: null,
    });
  })
);

router.post(
  '/onboarding/files',
  asyncRoute(async (req, res) => {
    const files = (req.files || []).filter((entry) => entry.field === 'files' && entry.size > 0);
    const pasted = trimOrNull(req.body.pasted);

    if (!files.length && !pasted) {
      req.flash('error', 'Choose a file, or paste your data.');
      return res.redirect(303, '/onboarding/files');
    }

    try {
      for (const file of files) {
        sourceService.addSource(req.db, req.ctx, req.user, {
          buffer: file.buffer,
          filename: file.filename,
        });
      }
      if (pasted) {
        sourceService.addSource(req.db, req.ctx, req.user, { text: pasted, filename: 'pasted data' });
      }
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/onboarding/files');
  })
);

router.post(
  '/onboarding/files/:id/remove',
  asyncRoute(async (req, res) => {
    sourceService.remove(req.db, req.ctx, req.user, req.params.id);
    return res.redirect(303, '/onboarding/files');
  })
);

/** Read everything, work out the structure, and propose a migration. */
router.post(
  '/onboarding/understand',
  asyncRoute(async (req, res) => {
    try {
      const plan = migration.buildPlan(req.db, req.ctx, req.user);
      return res.redirect(303, `/onboarding/review/${plan.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/onboarding/files');
    }
  })
);

/** What Foundry understood, and what it needs decided. */
router.get(
  '/onboarding/review/:id',
  asyncRoute(async (req, res) => {
    const plan = migration.getPlan(req.db, req.ctx.workspaceId, req.params.id);
    const conflicts = migration.conflictsFor(req.db, req.ctx.workspaceId, plan.id);
    // What the files come to once the duplicates and any settled conflicts are
    // applied, so the figure approved here is the figure that gets created.
    const correction = migration.resolvedUnits(
      plan,
      migration.decisionsFor(req.db, req.ctx.workspaceId, plan.id)
    );
    if (correction !== null && typeof plan.expectedTotals.units === 'number') {
      plan.expectedTotals = { ...plan.expectedTotals, units: plan.expectedTotals.units + correction };
    }

    return res.page('onboarding/review', {
      title: 'How Foundry would set this up',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      plan,
      sources: sourceService.list(req.db, req.ctx.workspaceId),
      conflicts,
      open: conflicts.filter((conflict) => !conflict.isSettled),
      blocking: conflicts.filter((conflict) => !conflict.isSettled && conflict.severity === 'blocking'),
      run: migration.latestRun(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

router.post(
  '/onboarding/conflicts/:id',
  asyncRoute(async (req, res) => {
    const conflict = migration.decide(req.db, req.ctx, req.user, req.params.id, req.body.decision);
    return res.redirect(303, `/onboarding/review/${conflict.planId}`);
  })
);

router.post(
  '/onboarding/review/:id/accept-recommendations',
  asyncRoute(async (req, res) => {
    const result = migration.acceptRecommendations(req.db, req.ctx, req.user, req.params.id);
    req.flash(
      'success',
      result.remaining
        ? `${result.accepted} settled. ${result.remaining} still need you.`
        : `${result.accepted} settled — nothing left to decide.`
    );
    return res.redirect(303, `/onboarding/review/${req.params.id}`);
  })
);

/** The takeover itself. */
router.post(
  '/onboarding/review/:id/migrate',
  asyncRoute(async (req, res) => {
    try {
      const { run } = await migration.migrate(req.db, req.ctx, req.user, req.params.id, {
        // Keyed to the plan, so a resubmitted form finishes the first migration
        // rather than building the inventory a second time.
        idempotencyKey: `migration:${req.params.id}`,
      });
      return res.redirect(303, `/onboarding/done/${run.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, `/onboarding/review/${req.params.id}`);
    }
  })
);

/** The takeover report. */
router.get(
  '/onboarding/done/:id',
  asyncRoute(async (req, res) => {
    const run = migration.hydrateRun(req.db, req.ctx.workspaceId, req.params.id);
    return res.page('onboarding/done', {
      title: run.verified ? 'Foundry is ready' : 'Migration needs checking',
      nav: 'foundry',
      run,
      plan: migration.getPlan(req.db, req.ctx.workspaceId, run.planId),
      sources: sourceService.list(req.db, req.ctx.workspaceId),
    });
  })
);

// ---------------------------------------------------------------------------
// Path C — another system
// ---------------------------------------------------------------------------

router.get(
  '/onboarding/system',
  asyncRoute(async (req, res) => {
    return res.page('onboarding/system', {
      title: 'Which system are you using?',
      nav: 'foundry',
      state: paths.ensure(req.db, req.ctx.workspaceId),
      connectors: connections.list(req.db, req.ctx.workspaceId),
      providerCatalog: providerRegistry.catalog().filter((provider) =>
        provider.available && ['selling', 'business'].includes(provider.category)),
      sourceOfTruth: paths.sourceOfTruth(req.db, req.ctx.workspaceId),
      canOperate: permissions.can(req.user, permissions.OPERATE),
      canManageConnections: req.user.role === 'owner',
    });
  })
);

router.post(
  '/onboarding/system',
  asyncRoute(async (req, res) => {
    paths.setExternalSystem(req.db, req.ctx.workspaceId, req.body.system);
    // Without a connector there is exactly one honest next step: an export.
    return res.redirect(303, '/onboarding/files');
  })
);

module.exports = router;
