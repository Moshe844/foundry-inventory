'use strict';

const express = require('express');
const config = require('../../config');
const understandingService = require('../../foundry/understanding-service');
const planBuilder = require('../../foundry/plan-builder');
const planApplier = require('../../foundry/plan-applier');
const onboardingPaths = require('../../onboarding/paths');
const assistant = require('../../foundry/assistant-service');
const jobRunner = require('../../foundry/job-runner');
const inventoryQuery = require('../../domain/inventory-query');
const repo = require('../../domain/repository');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const { toArray, trimOrNull, nowIso } = require('../../lib/util');

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

/**
 * Reading a business takes a minute or more of real model time, so the request
 * starts a background job and hands back a page that reports progress. Holding
 * the POST open would just spin the browser with nothing to show.
 */
router.post(
  '/foundry/understand',
  asyncRoute(async (req, res) => {
    const description = trimOrNull(req.body.description) || '';

    // Cheap validation happens now, so an obviously unusable description gets an
    // immediate answer instead of a progress page that fails a second later.
    if (description.length < understandingService.MIN_DESCRIPTION) {
      return res.status(400).page('foundry/setup', {
        title: 'Set up your inventory',
        nav: 'foundry',
      otherWorkspaces: Math.max(0, (res.locals.workspaces || []).length - 1),
        aiConfigured: config.ai.configured,
        description,
        error: 'Tell Foundry a little more about what you keep track of — a sentence or two is enough.',
      });
    }

    const jobId = jobRunner.createJob(req.ctx.workspaceId, 'understanding');
    const ctx = req.ctx;
    const db = req.db;
    const provider = req.app.locals.aiProvider || undefined;

    jobRunner.run(jobId, async (setStage) => {
      const { id } = await understandingService.describeBusiness(db, ctx, description, {
        provider,
        onStage: setStage,
      });
      return { understandingId: id };
    });

    return res.redirect(303, `/foundry/thinking/${jobId}`);
  })
);

/** The progress page. Works with JavaScript, and without it. */
router.get(
  '/foundry/thinking/:jobId',
  asyncRoute(async (req, res) => {
    const job = jobRunner.getJob(req.params.jobId, req.ctx.workspaceId);

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
        description: '',
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
    const job = jobRunner.getJob(req.params.jobId, req.ctx.workspaceId);
    if (!job) return res.status(404).json({ error: { code: 'not_found', message: 'No such job.' } });

    return res.json({
      status: job.status,
      stage: job.stage,
      stageLabel: job.stageLabel,
      stageDetail: job.stageDetail,
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
    return res.page('foundry/proposal', {
      title: "Here's how I'd organize your inventory",
      nav: 'foundry',
      understandingId: stored.id,
      understanding: stored.understanding,
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
    const answers = {};
    for (const [key, value] of Object.entries(req.body)) {
      if (!key.startsWith('answer_')) continue;
      const questionId = key.slice('answer_'.length);
      const answer = trimOrNull(value);
      // '__foundry__' means "let Foundry decide" — recorded, not answered.
      if (answer && answer !== '__foundry__') answers[questionId] = answer;
    }

    const { planId } = planBuilder.buildPlan(req.db, req.ctx, {
      understandingId: req.params.id,
      answers,
      acceptedRecommendationIds: toArray(req.body.acceptRecommendation),
    });

    planApplier.applyPlan(req.db, req.ctx, planId);
    res.redirect(303, `/foundry/ready/${planId}`);
  })
);

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
      decisions: planBuilder.listDecisions(req.db, req.ctx.workspaceId, stored.id),
    });
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
