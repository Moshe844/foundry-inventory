'use strict';

const express = require('express');
const inventoryQuery = require('../../domain/inventory-query');
const activityService = require('../../domain/activity-service');
const planApplier = require('../../foundry/plan-applier');
const onboardingPaths = require('../../onboarding/paths');
const attention = require('../../attention/attention-engine');
const needsYouInbox = require('../../manager/needs-you-inbox');
const presenter = require('../../attention/presenter');
const briefService = require('../../attention/brief-service');
const { purchasingBrief } = require('../../purchasing/brief-lines');
const autopilotPresenter = require('../../autopilot/presenter');
const guidance = require('../../manager/guidance');
const permissions = require('../../actions/permissions');
const businessBrain = require('../../manager/business-brain');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

function homeSignature(db, workspaceId) {
  const tables = ['domain_events', 'work_items', 'attention_items', 'inventory_investigations', 'purchase_orders', 'sales_orders', 'sales_order_events', 'movements', 'accounting_journal_entries'];
  return tables.map((table) => {
    const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS last, COUNT(*) AS total FROM ${table} WHERE workspace_id = ?`).get(workspaceId);
    return `${table}:${row.last}:${row.total}`;
  }).join('|');
}

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
      home.guidance = guidance.build(req.db, req.ctx.workspaceId);
      let brain = null;
      let financialPulse = null;
      try {
        // Accounting is part of every Keeper workspace. This is idempotent and
        // makes upgraded workspaces behave like newly-created ones before the
        // unified state is read.
        const ensuredAccounting = require('../../accounting/automatic').ensure(
          req.db, req.ctx.workspaceId, { actorId: req.ctx.actorId, recoverCurrent: true }
        );
        brain = businessBrain.build(req.db, req.ctx.workspaceId);
        if (ensuredAccounting.configured.enabled) {
          financialPulse = { from: brain.period.from, to: brain.period.to,
            currency: brain.currency, pnl: brain.finance.pnl,
            cashMinor: brain.finance.currentCashMinor,
            receivableMinor: brain.finance.customers.balanceMinor,
            payableMinor: brain.finance.suppliers.balanceMinor };
        }
      } catch {
        // Financial presentation cannot make the operating home unavailable.
      }
      /*
       * The forward half of the briefing. Defensive like the financial pulse
       * beside it: Home is the page somebody lands on, and a query that throws
       * must cost a paragraph rather than the whole morning.
       */
      let whatsNext = [];
      try {
        whatsNext = require('../../attention/whats-next').build(req.db, req.ctx.workspaceId);
      } catch { whatsNext = []; }

      return res.page('operator-home', {
        title: 'Foundry',
        nav: 'home',
        home,
        whatsNext,
        homeSignature: homeSignature(req.db, req.ctx.workspaceId),
        brief,
        stats,
        terminology,
        canOperate: permissions.can(req.user, permissions.OPERATE),
        financialPulse,
        brain,
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
      operatingDecisions: needsYouInbox.inbox(req.db, req.ctx.workspaceId),
      guidance: guidance.build(req.db, req.ctx.workspaceId),
      isEmpty: stats.itemCount === 0 && stats.locationCount === 0,
    });
  })
);

router.get('/api/home-state', requireAuth, asyncRoute(async (req, res) => {
  res.json({ signature: homeSignature(req.db, req.ctx.workspaceId) });
}));

/** A compact, task-based guide; contextual guidance remains on Home. */
router.get(
  '/guide',
  requireAuth,
  asyncRoute(async (req, res) => {
    const current = guidance.build(req.db, req.ctx.workspaceId);
    return res.page('guide', {
      title: 'How to use Foundry',
      nav: 'guide',
      guidance: current,
      topics: guidance.guideTopics(req.db, req.ctx.workspaceId),
    });
  })
);

module.exports = router;
