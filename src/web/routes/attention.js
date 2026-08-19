'use strict';

const express = require('express');
const config = require('../../config');
const attention = require('../../attention/attention-engine');
const presenter = require('../../attention/presenter');
const feedback = require('../../attention/feedback-service');
const briefService = require('../../attention/brief-service');
const interpretation = require('../../attention/interpretation-service');
const reevaluate = require('../../attention/reevaluate');
const queryPlanner = require('../../attention/query-planner');
const planApplier = require('../../foundry/plan-applier');
const repo = require('../../domain/repository');
const actionService = require('../../actions/action-service');
const workItems = require('../../autopilot/work-items');
const actionPermissions = require('../../actions/permissions');
const proposalService = require('../../actions/proposal-service');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/attention', requireAuth);
router.use('/ask', requireAuth);

/** Enough to read in one sitting; a briefing is not a backlog. */
const PAGE_SIZE = 25;

/** What the interpretation layer and the query planner need to sound right. */
function briefingContext(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const terminology = (configuration && configuration.terminology) || {};
  return {
    businessType: (configuration && configuration.businessType) || null,
    stockNoun: terminology.item || terminology.stock || null,
    vocabulary: terminology.item || null,
    locationNames: repo.listLocations(db, workspaceId).map((l) => l.name),
  };
}

/**
 * The briefing. Deterministic detection has already happened; the model, if it
 * is configured, only rewords what is here. A failure to reword is invisible.
 */
router.get(
  '/attention',
  asyncRoute(async (req, res) => {
    const category = req.query.category || null;
    const showResolved = req.query.show === 'resolved';
    const statuses = showResolved ? ['RESOLVED', 'DISMISSED'] : ['OPEN', 'ACKNOWLEDGED'];

    const total = attention.countAttention(req.db, req.ctx.workspaceId, { statuses, category });
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const current = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), pages);
    const offset = (current - 1) * PAGE_SIZE;

    const items = attention.listAttention(req.db, req.ctx.workspaceId, {
      statuses,
      category,
      limit: PAGE_SIZE,
      offset,
    });
    const presented = presenter.presentAll(req.db, req.ctx.workspaceId, items);

    res.page('attention/list', {
      title: 'Needs attention',
      nav: 'attention',
      groups: presenter.groupBySeverity(presented),
      items: presented,
      // The counts describe everything that matches, not just this page.
      summary: {
        ...attention.summarise(
          attention.listAttention(req.db, req.ctx.workspaceId, { statuses, category, limit: 500 })
        ),
        total,
        healthy: total === 0,
      },
      page: {
        current,
        pages,
        total,
        from: total === 0 ? 0 : offset + 1,
        to: offset + items.length,
        href: (n) => {
          const params = new URLSearchParams();
          if (showResolved) params.set('show', 'resolved');
          if (category) params.set('category', category);
          if (n > 1) params.set('page', String(n));
          const query = params.toString();
          return query ? `/attention?${query}` : '/attention';
        },
      },
      usefulness: feedback.usefulnessByCategory(req.db, req.ctx.workspaceId),
      // An inventory with nothing in it yet is a different answer from one with
      // nothing wrong. Saying so beats silently redirecting somewhere else.
      isEmpty:
        req.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM locations WHERE workspace_id = @w)
                  + (SELECT COUNT(*) FROM items WHERE workspace_id = @w) AS n`
          )
          .get({ w: req.ctx.workspaceId }).n === 0,
      showResolved,
      category,
      categoryLabels: presenter.CATEGORY_LABEL,
      lastRun: req.db
        .prepare('SELECT * FROM attention_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(req.ctx.workspaceId),
    });
  })
);

router.get(
  '/attention/:id',
  asyncRoute(async (req, res) => {
    const item = attention.getAttention(req.db, req.ctx.workspaceId, req.params.id);
    if (!item) {
      req.flash('error', 'That item is no longer on your briefing.');
      return res.redirect(303, '/attention');
    }
    // Only a finding an operation Foundry actually has can address is offered
    // an action. Inventing one for a stockout would be worse than offering none.
    const actionable =
      (item.category === 'location_imbalance' || item.relatedCategories.includes('location_imbalance')) &&
      Number(item.metrics.suggestedTransferQuantity) >= 1 &&
      actionPermissions.can(req.user, actionPermissions.OPERATE);

    return res.page('attention/detail', {
      title: item.title,
      nav: 'attention',
      item: presenter.present(req.db, req.ctx.workspaceId, item),
      history: feedback.listFeedback(req.db, req.ctx.workspaceId, item.attentionId),
      actionable,
      actionMessage: actionable ? null : actionService.actionabilityMessage(item),
      proposals: proposalService.listForAttention(req.db, req.ctx.workspaceId, item.attentionId),
    });
  })
);

/** Recalculate now. Deterministic; the wording pass is separate and optional. */
router.post(
  '/attention/refresh',
  asyncRoute(async (req, res) => {
    const result = reevaluate.refresh(req.db, req.ctx.workspaceId, 'manual');
    const items = attention.listAttention(req.db, req.ctx.workspaceId);

    if (config.ai.configured || req.app.locals.aiProvider) {
      const context = briefingContext(req.db, req.ctx.workspaceId);
      // Wording only. If it fails the deterministic text is already correct.
      await interpretation.interpret(req.db, req.ctx.workspaceId, items, {
        provider: req.app.locals.aiProvider || undefined,
        context,
      });
      await briefService.buildBrief(req.db, req.ctx.workspaceId, {
        items: attention.listAttention(req.db, req.ctx.workspaceId),
        context,
        provider: req.app.locals.aiProvider || undefined,
      });
    }

    req.flash(
      'success',
      result.opened || result.resolved
        ? `Checked your inventory: ${result.opened} new, ${result.resolved} resolved.`
        : 'Checked your inventory. Nothing has changed.'
    );
    res.redirect(303, req.body.returnTo === 'overview' ? '/' : '/attention');
  })
);

router.post(
  '/attention/:id/acknowledge',
  asyncRoute(async (req, res) => {
    feedback.acknowledge(req.db, req.ctx, req.params.id, { note: trimOrNull(req.body.note) });
    req.flash('success', 'Marked as being handled.');
    res.redirect(303, req.body.returnTo || '/attention');
  })
);

router.post(
  '/attention/:id/dismiss',
  asyncRoute(async (req, res) => {
    const result = feedback.dismiss(req.db, req.ctx, req.params.id, {
      note: trimOrNull(req.body.note),
      days: req.body.days || undefined,
    });
    req.flash('info', `Hidden until ${result.dismissedUntil.slice(0, 10)}. Foundry keeps measuring it.`);
    res.redirect(303, req.body.returnTo || '/attention');
  })
);

router.post(
  '/attention/:id/reopen',
  asyncRoute(async (req, res) => {
    feedback.reopen(req.db, req.ctx, req.params.id);
    req.flash('success', 'Back on your briefing.');
    res.redirect(303, req.body.returnTo || '/attention');
  })
);

router.post(
  '/attention/:id/rate',
  asyncRoute(async (req, res) => {
    feedback.rate(req.db, req.ctx, req.params.id, req.body.verdict, { note: trimOrNull(req.body.note) });
    req.flash(
      'info',
      req.body.verdict === 'useful'
        ? 'Noted — thanks.'
        : 'Noted. Foundry records this; it will not quietly change what it checks.'
    );
    res.redirect(303, req.body.returnTo || `/attention/${req.params.id}`);
  })
);

/**
 * Ask Foundry. A GET because it only reads: the answer is shareable, the back
 * button behaves, and nothing is resubmitted by refreshing.
 */
router.get(
  '/ask',
  asyncRoute(async (req, res) => {
    const question = trimOrNull(req.query.q);
    let result = null;
    let error = null;

    if (question) {
      try {
        result = await queryPlanner.ask(req.db, req.ctx.workspaceId, question, {
          provider: req.app.locals.aiProvider || undefined,
          context: briefingContext(req.db, req.ctx.workspaceId),
        });
      } catch (err) {
        if (err.status && err.status < 500) error = err.message;
        else throw err;
      }
    }

    res.page('attention/ask', {
      title: 'Ask Foundry',
      nav: 'home',
      question: question || '',
      result,
      error,
      aiConfigured: config.ai.configured,
      examples: [
        'How many navy oxfords do we have?',
        'What moved at the warehouse this week?',
        'Which lots expire soon?',
        'What has not sold in three months?',
        'What needs my attention?',
        'Receive 100 of every black size into Brooklyn.',
        // Only offered once Foundry has work of its own to talk about. Suggesting
        // it to a workspace where the answer is "nothing" advertises a hollow
        // trick rather than a capability.
        ...(workItems.list(req.db, req.ctx.workspaceId, { limit: 1 }).length
          ? ['What did you do today?']
          : []),
      ],
    });
  })
);

module.exports = router;
