'use strict';

/**
 * The autopilot surface: what Foundry is doing, what it needs, and the controls
 * for taking that authority away again.
 *
 * The controls are deliberately close to the status. A customer who is unsure
 * about an automaton should never have to hunt through settings to stop it.
 */

const express = require('express');
const modes = require('../../autopilot/modes');
const policyService = require('../../autopilot/policy-service');
const workItems = require('../../autopilot/work-items');
const runner = require('../../autopilot/runner');
const presenter = require('../../autopilot/presenter');
const policyAuthor = require('../../autopilot/policy-author');
const preferences = require('../../autopilot/preferences');
const permissions = require('../../actions/permissions');
const repo = require('../../domain/repository');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/autopilot', requireAuth);

/** How Foundry is set up, and everything it may do. */
router.get(
  '/autopilot',
  asyncRoute(async (req, res) => {
    const workspaceId = req.ctx.workspaceId;
    res.page('autopilot/settings', {
      title: 'What Foundry does',
      nav: 'autopilot',
      state: modes.get(req.db, workspaceId),
      limits: modes.limits(req.db, workspaceId),
      policies: policyService.list(req.db, workspaceId),
      describe: policyService.describe,
      locations: repo.listLocations(req.db, workspaceId).filter((location) => location.is_active),
      recent: workItems.list(req.db, workspaceId, { limit: 20 }),
      preferences: preferences.list(req.db, workspaceId),
      preferenceKeys: Object.values(preferences.KEYS),
      // A draft read from a sentence, carried through the redirect so the
      // customer reads the policy rather than their own words echoed back.
      drafted: req.session.policyDraft || null,
      canAdmin: permissions.can(req.user, permissions.ADMIN),
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
    delete req.session.policyDraft;
  })
);

/**
 * "Handle ordinary transfers yourself."
 *
 * Reads the sentence and shows what it would write. Nothing is stored, nothing
 * is approved, and the customer sees the limits before anything exists.
 */
router.post(
  '/autopilot/policies/read',
  asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permissions.ADMIN, 'decide what Foundry may do');
    try {
      const drafted = await policyAuthor.draft(req.db, req.ctx.workspaceId, req.body.instruction, {
        provider: req.app.locals.aiProvider || undefined,
      });
      req.session.policyDraft = drafted;
      if (!drafted.understood) req.flash('info', drafted.unsupportedReason);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot');
  })
);

/** What the customer wants Foundry to aim for. Never inferred, always stated. */
router.post(
  '/autopilot/preferences',
  asyncRoute(async (req, res) => {
    try {
      for (const definition of Object.values(preferences.KEYS)) {
        const raw = req.body[definition.key];
        if (raw === undefined) continue;
        if (String(raw).trim() === '') {
          preferences.clear(req.db, req.ctx, req.user, definition.key);
          continue;
        }
        preferences.set(req.db, req.ctx, req.user, {
          key: definition.key,
          value: raw,
          source: 'configuration',
          statedAs: req.body[`${definition.key}__saidAs`] || null,
        });
      }
      req.flash('success', 'Saved how you want this inventory run.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot');
  })
);

/** Foundry's work history, in words rather than movements. */
router.get(
  '/autopilot/history',
  asyncRoute(async (req, res) => {
    const items = workItems.list(req.db, req.ctx.workspaceId, { limit: 100 });
    res.page('autopilot/history', {
      title: 'What Foundry has done',
      nav: 'autopilot',
      groups: {
        automatic: items.filter((item) => item.executionStatus === 'COMPLETED' && item.isAutomatic),
        prepared: items.filter((item) => item.executionStatus === 'COMPLETED' && !item.isAutomatic),
        needsYou: items.filter((item) => item.needsPerson),
        blocked: items.filter((item) => ['FAILED', 'BLOCKED'].includes(item.executionStatus)),
      },
      describe: presenter.describeCompleted,
    });
  })
);

/** "Why did you do that?" */
router.get(
  '/autopilot/work/:id',
  asyncRoute(async (req, res) => {
    const explanation = presenter.explain(req.db, req.ctx.workspaceId, req.params.id);
    res.page('autopilot/work', {
      title: explanation.item.categoryLabel,
      nav: 'autopilot',
      ...explanation,
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

router.post(
  '/autopilot/work/:id/approve',
  asyncRoute(async (req, res) => {
    try {
      runner.approveWorkItem(req.db, req.ctx, req.user, req.params.id);
      const result = runner.executeWorkItem(req.db, req.ctx, req.user, req.params.id);
      req.flash(
        result.verified === false && result.executed ? 'error' : 'success',
        result.executed && result.verified !== false
          ? 'Done, and the result checks out.'
          : result.because || result.error || 'That could not be carried out.'
      );
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, `/autopilot/work/${req.params.id}`);
  })
);

router.post(
  '/autopilot/work/:id/cancel',
  asyncRoute(async (req, res) => {
    runner.cancelWorkItem(req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.reason));
    req.flash('success', 'Left alone.');
    return res.redirect(303, '/');
  })
);

/** Run a round of the loop by hand. */
router.post(
  '/autopilot/run',
  asyncRoute(async (req, res) => {
    permissions.assertCan(req.user, permissions.OPERATE, 'run Foundry');
    const result = runner.run(req.db, req.ctx, req.user, { trigger: 'manual' });
    req.flash(
      'success',
      result.nothingToDo
        ? 'Checked everything. Nothing needs doing.'
        : `${result.planned} planned, ${result.executed} carried out, ${result.awaiting} waiting for you.`
    );
    return res.redirect(303, '/');
  })
);

// --- authority ---------------------------------------------------------------

router.post(
  '/autopilot/mode',
  asyncRoute(async (req, res) => {
    try {
      modes.setMode(req.db, req.ctx, req.user, trimOrNull(req.body.mode));
      req.flash('success', 'Changed what Foundry is allowed to do.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot');
  })
);

router.post(
  '/autopilot/pause',
  asyncRoute(async (req, res) => {
    modes.pause(req.db, req.ctx, req.user, trimOrNull(req.body.reason));
    req.flash('success', 'Foundry is paused. Nothing will happen automatically until you resume it.');
    return res.redirect(303, req.body.back || '/');
  })
);

router.post(
  '/autopilot/resume',
  asyncRoute(async (req, res) => {
    try {
      const state = modes.get(req.db, req.ctx.workspaceId);
      if (state.suspended) modes.clearSuspension(req.db, req.ctx, req.user);
      modes.resume(req.db, req.ctx, req.user);
      req.flash('success', 'Foundry is running again.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, req.body.back || '/');
  })
);

router.post(
  '/autopilot/limits',
  asyncRoute(async (req, res) => {
    try {
      modes.setLimits(req.db, req.ctx, req.user, req.body);
      req.flash('success', 'Limits updated.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot');
  })
);

// --- policies ----------------------------------------------------------------

router.post(
  '/autopilot/policies',
  asyncRoute(async (req, res) => {
    try {
      const locations = Array.isArray(req.body.locationScope)
        ? req.body.locationScope
        : req.body.locationScope ? [req.body.locationScope] : [];
      const policy = policyService.propose(req.db, req.ctx, req.user, {
        name: req.body.name,
        description: req.body.description,
        allowedActionTypes: ['transfer'],
        locationScope: locations,
        conditions: [
          policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK,
          policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
        ],
        maximumQuantity: req.body.maximumQuantity,
        dailyLimit: req.body.dailyLimit,
      });
      req.flash('success', `“${policy.name}” is written down. Read it and approve it before it does anything.`);
      return res.redirect(303, `/autopilot/policies/${policy.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/autopilot');
    }
  })
);

router.get(
  '/autopilot/policies/:id',
  asyncRoute(async (req, res) => {
    const policy = policyService.get(req.db, req.ctx.workspaceId, req.params.id);
    res.page('autopilot/policy', {
      title: policy.name,
      nav: 'autopilot',
      policy,
      lines: policyService.describe(policy),
      locations: repo.listLocations(req.db, req.ctx.workspaceId),
      canAdmin: permissions.can(req.user, permissions.ADMIN),
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
  })
);

router.post(
  '/autopilot/policies/:id/approve',
  asyncRoute(async (req, res) => {
    try {
      policyService.approve(req.db, req.ctx, req.user, req.params.id, {
        expectedHash: trimOrNull(req.body.integrityHash),
      });
      req.flash('success', 'Approved. Foundry may now do this on its own — switch it to Autopilot to let it.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, `/autopilot/policies/${req.params.id}`);
  })
);

/** "Stop doing that." */
router.post(
  '/autopilot/policies/:id/disable',
  asyncRoute(async (req, res) => {
    const policy = policyService.disable(req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.reason));
    req.flash(
      'success',
      `${policy.name} is off. Nothing new will happen under it; what it already did stays in the history.`
    );
    return res.redirect(303, '/autopilot');
  })
);

// --- notifications -----------------------------------------------------------

router.post(
  '/autopilot/notifications/read',
  asyncRoute(async (req, res) => {
    req.db
      .prepare('UPDATE notifications SET read_at = ? WHERE workspace_id = ? AND read_at IS NULL')
      .run(new Date().toISOString(), req.ctx.workspaceId);
    return res.redirect(303, req.body.back || '/');
  })
);

module.exports = router;
