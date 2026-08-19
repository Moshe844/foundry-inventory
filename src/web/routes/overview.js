'use strict';

const express = require('express');
const inventoryQuery = require('../../domain/inventory-query');
const activityService = require('../../domain/activity-service');
const planApplier = require('../../foundry/plan-applier');
const onboardingPaths = require('../../onboarding/paths');
const attention = require('../../attention/attention-engine');
const readiness = require('../../manager/readiness');
const presenter = require('../../attention/presenter');
const briefService = require('../../attention/brief-service');
const { purchasingBrief } = require('../../purchasing/brief-lines');
const autopilotPresenter = require('../../autopilot/presenter');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

/**
 * The Overview answers one question first: what needs my attention right now?
 * The counts and recent activity stay underneath it, because they are context
 * for that answer rather than the answer itself.
 */
router.get(
  ['/', '/overview'],
  requireAuth,
  asyncRoute(async (req, res) => {
    const stats = inventoryQuery.overview(req.db, req.ctx.workspaceId);
    // Recover onboarding automatically once real ledger evidence exists. The
    // customer has already supplied inventory truth; asking them to confirm
    // that Foundry may start using it is ceremony, not safety.
    onboardingPaths.reconcileWithInventoryTruth(req.db, req.ctx.workspaceId);
    const { groups } = activityService.listActivity(req.db, req.ctx.workspaceId, { limit: 6 });
    const configuration = planApplier.getConfiguration(req.db, req.ctx.workspaceId);

    const items = attention.listAttention(req.db, req.ctx.workspaceId, { limit: 20 });
    const terminology = (configuration && configuration.terminology) || {};
    const purchasing = purchasingBrief(req.db, req.ctx.workspaceId);
    const context = { stockNoun: terminology.item || null, purchasingLines: purchasing.lines };

    const brief =
      briefService.currentBrief(req.db, req.ctx.workspaceId, items, briefService.purchasingSignature(purchasing)) ||
      { body: briefService.deterministicBrief(items, context), source: 'deterministic', createdAt: null };

    // Once Foundry has an approved configuration, its home owns the first-run
    // journey too. An empty configured workspace is exactly where the customer
    // most needs a clear next step; sending it to the traditional overview made
    // the guided setup invisible until after products already existed.
    const wantsClassic = req.path === '/overview';
    const foundryConfigured = Boolean(configuration && configuration.configuredAt);
    if (!wantsClassic && foundryConfigured) {
      const home = autopilotPresenter.operatorHome(req.db, req.ctx.workspaceId);
      return res.page('operator-home', {
        title: 'Foundry',
        nav: 'home',
        home,
        brief,
        stats,
        terminology,
        canOperate: permissions.can(req.user, permissions.OPERATE),
      });
    }

    res.page('overview', {
      title: 'Overview',
      nav: 'overview',
      stats,
      activity: groups,
      configuration,
      brief,
      purchasing,
      attention: presenter.presentAll(req.db, req.ctx.workspaceId, items.slice(0, 4)),
      attentionSummary: attention.summarise(items),
      attentionTotal: items.length,
      // Needs You counts more than stock findings — it also holds the operating
      // inputs Foundry is missing. Reading only the findings here let this page
      // say "All clear" about the same inventory that Needs You said had a
      // thing waiting, which leaves a new customer with two screens
      // contradicting each other and no way to tell which is lying.
      operatingDecisions: readiness.decisions(req.db, req.ctx.workspaceId),
      isEmpty: stats.itemCount === 0 && stats.locationCount === 0,
    });
  })
);

module.exports = router;
