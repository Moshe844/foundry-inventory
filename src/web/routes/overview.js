'use strict';

const express = require('express');
const inventoryQuery = require('../../domain/inventory-query');
const activityService = require('../../domain/activity-service');
const planApplier = require('../../foundry/plan-applier');
const onboardingPaths = require('../../onboarding/paths');
const canonicalMigration = require('../../onboarding/canonical-migration');
const ownerMigration = require('../../onboarding/owner-migration');
const attention = require('../../attention/attention-engine');
const needsYouInbox = require('../../manager/needs-you-inbox');
const needsYouCount = require('../../attention/needs-you-count');
const presenter = require('../../attention/presenter');
const briefService = require('../../attention/brief-service');
const { purchasingBrief } = require('../../purchasing/brief-lines');
const autopilotPresenter = require('../../autopilot/presenter');
const guidance = require('../../manager/guidance');
const permissions = require('../../actions/permissions');
const { requireAuth, asyncRoute } = require('../middleware');

const router = express.Router();

function homeSignature(db, workspaceId) {
  const tables = ['domain_events', 'work_items', 'attention_items', 'inventory_investigations', 'purchase_orders', 'sales_orders', 'sales_order_events', 'movements', 'accounting_journal_entries', 'accounting_payments', 'payment_requests'];
  return tables.map((table) => {
    const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS last, COUNT(*) AS total FROM ${table} WHERE workspace_id = ?`).get(workspaceId);
    return `${table}:${row.last}:${row.total}`;
  }).join('|');
}

function activeMigrationSummary(db,workspaceId) {
  const pkg = canonicalMigration.listPackages(db,workspaceId,20)
    .find((entry) => !['CUTOVER_ACTIVE','CANCELLED'].includes(entry.status));
  if (!pkg) return null;
  const datasets = ownerMigration.listDatasets(db,workspaceId,pkg.id);
  const operational = datasets.filter((entry) => entry.entityType !== 'reference_only');
  const staged = operational.filter((entry) => entry.status === 'STAGED');
  const filenames = [...new Set(datasets.map((entry) => entry.sourceName).filter(Boolean))];
  return {
    id:pkg.id,status:pkg.status,sourceLabel:pkg.sourceLabel,filenames,
    operationalCount:operational.length,preparedCount:staged.length,
    remainingCount:operational.length - staged.length,
    sourceRowsPrepared:staged.reduce((sum,entry) => sum + Number(entry.sourceRowCount || 0),0),
    foundryRecordsPrepared:pkg.stagedCount,liveRecords:pkg.appliedCount,
  };
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
    const wantsClassic = req.path === '/overview';
    const stats = inventoryQuery.overview(req.db, req.ctx.workspaceId);
    // Recover onboarding automatically once real ledger evidence exists. The
    // customer has already supplied inventory truth; asking them to confirm
    // that StockChief may start using it is ceremony, not safety.
    onboardingPaths.reconcileWithInventoryTruth(req.db, req.ctx.workspaceId);
    const { groups } = activityService.listActivity(req.db, req.ctx.workspaceId, { limit: 6 });
    const configuration = planApplier.getConfiguration(req.db, req.ctx.workspaceId);

    const items = attention.listAttention(req.db, req.ctx.workspaceId, { limit: 20 });
    const terminology = (configuration && configuration.terminology) || {};
    const purchasing = purchasingBrief(req.db, req.ctx.workspaceId, { storedOnly: !wantsClassic });
    const context = { stockNoun: terminology.item || null, purchasingLines: purchasing.lines };

    const brief =
      briefService.currentBrief(req.db, req.ctx.workspaceId, items, briefService.purchasingSignature(purchasing)) ||
      { body: briefService.deterministicBrief(items, context), source: 'deterministic', createdAt: null };

    // Once StockChief has an approved configuration, its home owns the first-run
    // journey too. An empty configured workspace is exactly where the customer
    // most needs a clear next step; sending it to the traditional overview made
    // the guided setup invisible until after products already existed.
    if (!wantsClassic) {
      const activeMigration = activeMigrationSummary(req.db,req.ctx.workspaceId);
      // One authoritative inbox read supplies both the briefing and the badge.
      // Rebuilding it independently for guidance used to double the cost of
      // opening StockChief on a large inventory.
      const homeInbox = needsYouInbox.inbox(req.db, req.ctx.workspaceId, req.user, {
        productBrain: req.app.locals.productBrain,
        limit: 6,
      });
      const home = autopilotPresenter.operatorHome(req.db, req.ctx.workspaceId, {
        preparedInbox: homeInbox,
      });
      const homeNeedsCount = Number.isInteger(homeInbox.totalCount)
        ? homeInbox.totalCount : homeInbox.length;
      // When a real decision already occupies Home, the setup guide's exact
      // next-action lookup is not rendered. On a large, fully populated
      // catalogue that lookup still had to prove that no SKU lacked a supplier
      // or reorder rule. Keep the truthful readiness state and useful examples
      // without performing two catalogue-wide negative searches for content
      // the page will not display.
      home.guidance = homeNeedsCount > 0 && stats.itemCount > 0 && stats.locationCount > 0
        ? {
            operationalReady: !home.setup,
            checklistActive: false,
            steps: [],
            next: null,
            examples: ['What needs my attention?', 'What is running low?', 'What did you handle today?'],
          }
        : guidance.build(req.db, req.ctx.workspaceId, req.user, {
            productBrain: req.app.locals.productBrain,
            preparedInbox: homeInbox,
          });
      let brain = null;
      let financialPulse = null;
      try {
        // Home is read-only presentation. Recovery of opening balances can
        // scan an entire migrated catalogue and belongs to setup/background
        // accounting work, never to every page view.
        const accountingSettings = require('../../accounting/ledger').settings(
          req.db, req.ctx.workspaceId
        );
        if (accountingSettings.enabled) {
          const today = new Date().toISOString().slice(0, 10);
          const from = `${today.slice(0, 7)}-01`;
          const ownerAccounting = require('../../accounting/owner-dashboard');
          const reports = require('../../accounting/reports');
          // Brief needs six totals, not the complete accounting dashboard
          // (inventory ageing, valuation rows, duplicate-payment analysis and
          // every insight). Keep the full report on Money.
          const customers = ownerAccounting.customerBalances(req.db, req.ctx.workspaceId, today);
          const confirmedOrders = ownerAccounting.confirmedOrderBalances(req.db, req.ctx.workspaceId, today);
          const suppliers = ownerAccounting.supplierBalances(req.db, req.ctx.workspaceId, today);
          const pnl = reports.profitAndLoss(req.db, req.ctx.workspaceId, { from, to: today });
          const balance = reports.balanceSheet(
            req.db, req.ctx.workspaceId, { asOf: today }
          );
          const cashPayments = req.db.prepare(`SELECT
              COALESCE(SUM(CASE WHEN direction='CUSTOMER_RECEIPT' THEN amount_minor ELSE 0 END),0) AS customer_minor
            FROM accounting_payments WHERE workspace_id=? AND status='POSTED'
              AND payment_date BETWEEN ? AND ?`).get(req.ctx.workspaceId, from, today);
          const currentCashMinor = balance.assets
            .filter((account) => account.subtype === 'CASH')
            .reduce((sum, account) => sum + Number(account.net_minor || 0), 0);
          financialPulse = { from, to: today,
            currency: accountingSettings.currency || 'USD', pnl,
            cashMinor: currentCashMinor,
            // Home answers the owner's broad question, "what are customers
            // expected to pay me?" This includes confirmed orders awaiting
            // fulfilment as well as completed, invoiced sales. Profit remains
            // based only on earned revenue in the P&L above.
            receivableMinor: customers.balanceMinor + confirmedOrders.balanceMinor,
            invoicedReceivableMinor: customers.balanceMinor,
            confirmedOrderBalanceMinor: confirmedOrders.balanceMinor,
            customerCashReceivedMinor: Number(cashPayments.customer_minor || 0),
            customerPrepaymentsMinor: confirmedOrders.prepaymentMinor,
            payableMinor: suppliers.balanceMinor };
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
       * What StockChief expects to go wrong.
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

      // guidance/business state above has refreshed the authoritative inbox.
      // Reflect that fresh cached count in this same response's navigation.
      res.locals.attentionCount = needsYouCount.countNeedsYou(req.db,req.ctx.workspaceId);
      return res.page('foundry/brief', {
        title: 'StockChief',
        nav: 'home',
        room: true,
        /*
         * A brand-new inventory has nothing to be under control yet, and the
         * brief has to say so and hand over the first step. Sending somebody to
         * a calm morning briefing about an empty database is the friendliest
         * possible way to leave them stuck.
         */
        isEmpty: stats.itemCount === 0 && (stats.locationCount === 0 || Boolean(activeMigration)),
        activeMigration,
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

    const operatingDecisions = needsYouInbox.inbox(req.db, req.ctx.workspaceId, req.user, {
      productBrain: req.app.locals.productBrain,
    });
    res.locals.attentionCount = Number.isInteger(operatingDecisions.totalCount)
      ? operatingDecisions.totalCount : operatingDecisions.length;
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
      // inputs StockChief is missing. Reading only the findings here let this page
      // say "All clear" about the same inventory that Needs You said had a
      // thing waiting, which leaves a new customer with two screens
      // contradicting each other and no way to tell which is lying.
      operatingDecisions,
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
      title: 'How to use StockChief',
      nav: 'guide',
      guidance: current,
      topics: guidance.guideTopics(req.db, req.ctx.workspaceId),
    });
  })
);

module.exports = router;
