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
  const tables = ['domain_events', 'work_items', 'attention_items', 'inventory_investigations', 'purchase_orders', 'sales_orders', 'sales_order_events', 'movements', 'accounting_journal_entries', 'accounting_payments', 'payment_requests'];
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
    if (!wantsClassic) {
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
            // Home answers the owner's broad question, "what are customers
            // expected to pay me?" This includes confirmed orders awaiting
            // fulfilment as well as completed, invoiced sales. Profit remains
            // based only on earned revenue in the P&L above.
            receivableMinor: brain.finance.customerMoneyOutstandingMinor,
            invoicedReceivableMinor: brain.finance.customers.balanceMinor,
            confirmedOrderBalanceMinor: brain.finance.confirmedOrders.balanceMinor,
            customerCashReceivedMinor: brain.finance.cashActivity.customerReceivedMinor,
            customerPrepaymentsMinor: brain.finance.confirmedOrders.prepaymentMinor,
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

      /*
       * What Foundry expects to go wrong.
       *
       * Read from what the planning pass has already worked out, never
       * forecast here: Home is the page somebody lands on, and predicting four
       * hundred products before it renders would make it the page they stop
       * landing on. Same defensive treatment as everything else on this
       * screen — a planning table that cannot be read costs a paragraph.
       */
      let noticed = [];
      try {
        noticed = req.db.prepare(`SELECT r.id, r.kind, r.headline, r.why, r.confidence, r.sku_id,
            r.authority_verdict
          FROM planning_recommendations r
          WHERE r.workspace_id = ? AND r.status = 'OPEN'
          ORDER BY CASE r.kind WHEN 'order_now' THEN 0 WHEN 'transfer' THEN 1 ELSE 2 END,
            r.created_at DESC
          LIMIT 4`).all(req.ctx.workspaceId);
      } catch { noticed = []; }

      return res.page('foundry/brief', {
        title: 'Foundry',
        nav: 'home',
        room: true,
        /*
         * A brand-new inventory has nothing to be under control yet, and the
         * brief has to say so and hand over the first step. Sending somebody to
         * a calm morning briefing about an empty database is the friendliest
         * possible way to leave them stuck.
         */
        isEmpty: stats.itemCount === 0 && stats.locationCount === 0,
        foundryConfigured: Boolean(configuration && configuration.configuredAt),
        /*
         * The real inventory sources, so the first screen offers the same five
         * paths the onboarding chooser does and every one of them starts
         * something. The three buttons this replaced pointed at a generic
         * import page and at the connections page, where the first thing an
         * owner with no products met was Stripe.
         */
        sourceOptions: require('../../onboarding/paths').SOURCE_OPTIONS,
        home,
        whatsNext,
        noticed,
        homeSignature: homeSignature(req.db, req.ctx.workspaceId),
        brief,
        observedBrief: briefService.deterministicObservationBrief(items, context),
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
      operatingDecisions: needsYouInbox.inbox(req.db, req.ctx.workspaceId, req.user, {
        productBrain: req.app.locals.productBrain,
      }),
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
