'use strict';

const express = require('express');
const inventoryQuery = require('../../domain/inventory-query');
const activityService = require('../../domain/activity-service');
const planApplier = require('../../foundry/plan-applier');
const attention = require('../../attention/attention-engine');
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
    const { groups } = activityService.listActivity(req.db, req.ctx.workspaceId, { limit: 6 });
    const configuration = planApplier.getConfiguration(req.db, req.ctx.workspaceId);

    const items = attention.listAttention(req.db, req.ctx.workspaceId, { limit: 20 });
    const terminology = (configuration && configuration.terminology) || {};
    // What purchasing would say today, counted from real orders and usage.
    const purchasing = purchasingBrief(req.db, req.ctx.workspaceId);
    const context = { stockNoun: terminology.item || null, purchasingLines: purchasing.lines };

    // A stored brief is reused only while it still describes these exact
    // findings; otherwise the deterministic text is composed here and now, so
    // the page never waits on a model to render.
    const brief =
      briefService.currentBrief(req.db, req.ctx.workspaceId, items, briefService.purchasingSignature(purchasing)) ||
      { body: briefService.deterministicBrief(items, context), source: 'deterministic', createdAt: null };

    // A working inventory lands on Operator Home: what Foundry did, what needs
    // a person, what is coming. The classic overview stays one click away at
    // /overview, and an inventory with nothing in it still gets it by default —
    // an autopilot summary of an empty warehouse would be theatre.
    const wantsClassic = req.path === '/overview';
    const hasSomethingToRun = stats.itemCount > 0 && configuration && configuration.configuredAt;
    if (!wantsClassic && hasSomethingToRun) {
      const home = autopilotPresenter.operatorHome(req.db, req.ctx.workspaceId);
      return res.page('operator-home', {
        title: 'Foundry',
        nav: 'overview',
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
      // Nothing here yet is a different thing from nothing wrong, and the
      // Overview should say which rather than send you somewhere else.
      isEmpty: stats.itemCount === 0 && stats.locationCount === 0,
    });
  })
);

module.exports = router;
