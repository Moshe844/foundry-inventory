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
const managerEvents = require('../../manager/events');
const reactions = require('../../manager/reactions');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/autopilot', requireAuth);

const react = (req, payload, options = {}) => reactions.publishAndReact(
  req.db, req.ctx.workspaceId, managerEvents.TYPES.AUTHORITY_UPDATED, payload, options
);

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
      routine: policyService.routineSetup(req.db, workspaceId),
      describe: policyService.describe,
      locations: repo.listLocations(req.db, workspaceId).filter((location) => location.is_active),
      suppliers: req.db.prepare("SELECT id, name FROM suppliers WHERE workspace_id = ? AND status = 'active' ORDER BY name").all(workspaceId),
      recent: workItems.list(req.db, workspaceId, { limit: 20 }),
      preferences: preferences.list(req.db, workspaceId),
      preferenceKeys: Object.values(preferences.KEYS),
      advanced: req.query.advanced === '1' || Boolean(req.session.policyDraft),
      // A draft read from a sentence, carried through the redirect so the
      // customer reads the policy rather than their own words echoed back.
      drafted: req.session.policyDraft || null,
      reviewAll: Boolean(req.session.policyReviewAll),
      canAdmin: permissions.can(req.user, permissions.ADMIN),
      canOperate: permissions.can(req.user, permissions.OPERATE),
    });
    delete req.session.policyDraft;
    delete req.session.policyReviewAll;
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
    return res.redirect(303, '/autopilot?advanced=1');
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
      react(req, { change: 'operating_preferences' });
      req.flash('success', 'Saved how you want this inventory run.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot?advanced=1');
  })
);

/** Foundry's work history, in words rather than movements. */
router.get(
  '/autopilot/history',
  asyncRoute(async (req, res) => {
    const items = workItems.list(req.db, req.ctx.workspaceId, { limit: 100 });
    res.page('autopilot/history', {
      title: 'What Foundry has done',
      nav: 'history',
      groups: {
        automatic: items.filter((item) => item.executionStatus === 'COMPLETED' && item.isAutomatic),
        prepared: items.filter((item) => item.executionStatus === 'COMPLETED' && !item.isAutomatic),
        needsYou: items.filter((item) => presenter.isCurrentlyActionable(req.db, req.ctx.workspaceId, item)),
        blocked: items.filter((item) => ['FAILED', 'BLOCKED'].includes(item.executionStatus)),
      },
      evaluations: presenter.recentEvaluations(req.db, req.ctx.workspaceId, { limit: 50 }),
      // Bound to who owns each order, so history does not offer an approval the
      // replenishment plan has taken over.
      describe: ((owned) => (item) => presenter.describeCompleted(
        item,
        owned,
        presenter.currentOrderForWork(req.db, req.ctx.workspaceId, item)
      ))(
        new Set(presenter.ordersOwnedByAPlan(req.db, req.ctx.workspaceId).keys())
      ),
    });
  })
);

/** "Why did you do that?" */
router.get(
  '/autopilot/work/:id',
  asyncRoute(async (req, res) => {
    const explanation = presenter.explain(req.db, req.ctx.workspaceId, req.params.id);
    if (explanation.item.category === 'replenishment_plan'
        && (explanation.item.recommendedAction || {}).blocked === 'no_supplier') {
      req.flash('info', 'Add the supplier first. Foundry will then recalculate the exact replenishment plan; there is nothing to approve yet.');
      return res.redirect(303, `/purchasing/supplier-for/${explanation.item.recommendedAction.skuId}`);
    }
    res.page('autopilot/work', {
      // Named, so the browser tab and the heading say which product is being
      // decided rather than only what kind of decision it is.
      title: explanation.approvalCopy
        ? explanation.approvalCopy.heading
        : (explanation.item.affectedEntities || {}).displayName
          ? `${explanation.item.affectedEntities.displayName} — ${explanation.item.categoryLabel.toLowerCase()}`
          // An order has a number, and it is the thing the reader is looking for.
          : (explanation.item.recommendedAction || {}).poNumber
            ? `${explanation.item.recommendedAction.poNumber} — ${explanation.item.categoryLabel.toLowerCase()}`
            : explanation.item.categoryLabel,
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
      reactions.drainWorkspace(req.db, req.ctx.workspaceId);
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
    reactions.drainWorkspace(req.db, req.ctx.workspaceId);
    const currentNeeds = require('../../manager/needs-you-inbox').inbox(req.db, req.ctx.workspaceId).length;
    const noNewWork = result.planned === 0 && result.executed === 0 && result.recovered === 0;
    req.flash(
      'success',
      noNewWork
        ? `Check complete — no new work found. ` +
          (currentNeeds
            ? `${currentNeeds} existing ${currentNeeds === 1 ? 'item still needs' : 'items still need'} you.`
            : 'Nothing is waiting in Needs you.')
        : `Check complete — ${result.planned} planned, ${result.executed} carried out, ` +
          `${currentNeeds} ${currentNeeds === 1 ? 'item needs' : 'items need'} you now.`
    );
    return res.redirect(303, '/');
  })
);

// --- authority ---------------------------------------------------------------

router.post(
  '/autopilot/mode',
  asyncRoute(async (req, res) => {
    try {
      const state = modes.setMode(req.db, req.ctx, req.user, trimOrNull(req.body.mode));
      react(req, { change: 'mode', mode: state.mode });
      req.flash('success', 'Changed what Foundry is allowed to do.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot');
  })
);

/**
 * The short path to bounded routine authority. These controls write and
 * approve the same versioned automation policies shown under Custom.
 */
router.post(
  '/autopilot/routine-authority',
  asyncRoute(async (req, res) => {
    try {
      const routine = policyService.configureRoutine(req.db, req.ctx, req.user, req.body);
      react(req, { change: 'routine_authority', transfer: routine.transfer, purchasing: routine.purchasing });
      const allowed = [];
      if (routine.transfer.enabled) {
        allowed.push(`move up to ${routine.transfer.maximumQuantity} units at a time between your active locations`);
      }
      if (routine.purchasing.enabled) {
        allowed.push(
          `approve supplier orders up to $${Number(routine.purchasing.maximumValue).toLocaleString('en-US')} from the suppliers you selected`
        );
      }
      req.flash(
        'success',
        allowed.length
          ? `Routine work is ready. Foundry may automatically ${allowed.join(' and ')}. Everything outside these limits comes to you first.`
          : 'Routine authority removed. Foundry will ask before carrying out consequential work.'
      );
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
    react(req, { change: 'paused', paused: true });
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
      reactions.publishAndReact(
        req.db, req.ctx.workspaceId, managerEvents.TYPES.FOUNDRY_RESUMED,
        { change: 'resumed', paused: false },
        { idempotencyKey: `${managerEvents.TYPES.FOUNDRY_RESUMED}:${Date.now()}` }
      );
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
      const limits = modes.setLimits(req.db, req.ctx, req.user, req.body);
      react(req, { change: 'hard_limits', limits });
      req.flash('success', 'Limits updated.');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
    }
    return res.redirect(303, '/autopilot?advanced=1');
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
      const actionType = req.body.actionType === 'approve_purchase_order' ? 'approve_purchase_order' : 'transfer';
      const suppliers = Array.isArray(req.body.supplierScope)
        ? req.body.supplierScope : req.body.supplierScope ? [req.body.supplierScope] : [];
      const purchaseConditions = [
        policyService.CONDITIONS.REPLENISHMENT_EVIDENCE,
        policyService.CONDITIONS.MOQ_ORDER_MULTIPLE_COMPLIANT,
        policyService.CONDITIONS.NO_DUPLICATE_INCOMING_DEMAND,
        policyService.CONDITIONS.PRICE_WITHIN_POLICY,
      ];
      const policy = policyService.propose(req.db, req.ctx, req.user, {
        name: req.body.name,
        description: req.body.description,
        allowedActionTypes: [actionType],
        locationScope: locations,
        supplierScope: suppliers,
        conditions: actionType === 'approve_purchase_order' ? purchaseConditions : [
          policyService.CONDITIONS.DESTINATION_STOCKOUT_RISK, policyService.CONDITIONS.SOURCE_ABOVE_SAFETY,
        ],
        maximumQuantity: req.body.maximumQuantity,
        maximumValue: req.body.maximumValue,
        thresholds: actionType === 'approve_purchase_order'
          ? { maxUnitPriceChangePercent: Number(req.body.maxUnitPriceChangePercent) || 0 } : {},
        dailyLimit: req.body.dailyLimit,
      });
      req.flash('success', `“${policy.name}” is written down. Read it and approve it before it does anything.`);
      return res.redirect(303, `/autopilot/policies/${policy.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('error', err.message);
      return res.redirect(303, '/autopilot?advanced=1');
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
      const approved = policyService.approve(req.db, req.ctx, req.user, req.params.id, {
        expectedHash: trimOrNull(req.body.integrityHash),
      });
      react(req, { change: 'policy_approved', policyId: approved.id, policyVersion: approved.version });
      req.flash('success', 'Approved. Choose “Handle routine work” to let Foundry use this rule automatically.');
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
    react(req, { change: 'policy_disabled', policyId: policy.id, policyVersion: policy.version });
    req.flash(
      'success',
      `${policy.name} is off. Nothing new will happen under it; what it already did stays in the history.`
    );
    return res.redirect(303, '/autopilot?advanced=1');
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
