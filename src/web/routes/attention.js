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
const replenishmentPlan = require('../../purchasing/replenishment-plan');
const signalEngine = require('../../signals/signal-engine');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull, nowIso } = require('../../lib/util');
const ledger = require('../../assistant/ledger');
const assistantTurns = require('../../assistant/turns');

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

/**
 * The replenishment plan for the product a finding is about, as it stands now.
 *
 * Returns null rather than throwing: a finding whose product has since been
 * archived should still open and still explain itself.
 */
function withPlanWording(presented, plan) {
  if (!plan) return presented;
  const preparedOnly = Boolean(plan.prepared?.orders?.length && !plan.purchase && plan.transfers.length === 0);
  const numbers = preparedOnly ? plan.prepared.orders.map((order) => order.poNumber).join(', ') : '';
  return {
    ...presented,
    title: preparedOnly
      ? `${plan.displayName}: ${plan.prepared.units} ${plan.unitLabel}(s) ready to order`
      : plan.blocked === 'no_supplier' ? presented.title : `${plan.displayName}: ${plan.headline.toLowerCase()}`,
    conciseSummary: preparedOnly
      ? `${plan.onHandTotal} on hand. ${numbers} is a draft; nothing has been ordered yet.`
      : presented.conciseSummary,
    narrativeTitle: null,
    explanation: plan.explanation,
    recommendation: replenishmentPlan.recommendationFor(plan),
  };
}

function currentPlan(db, workspaceId, item) {
  const skuId = (item.affectedEntityIds || [])[0];
  if (!skuId) return null;
  try {
    const sku = signalEngine.skuSignals(db, workspaceId, { skuIds: [skuId] })[0];
    if (!sku) return null;
    return replenishmentPlan.buildPlan(db, workspaceId, sku);
  } catch {
    return null;
  }
}

router.get(
  '/attention/:id',
  asyncRoute(async (req, res) => {
    const item = attention.getAttention(req.db, req.ctx.workspaceId, req.params.id);
    if (!item) {
      req.flash('error', 'That item is no longer on your briefing.');
      return res.redirect(303, '/attention');
    }
    // Only a finding an operation StockChief actually has can address is offered
    // an action. Inventing one for a stockout would be worse than offering none.
    const isReplenishment =
      item.category === 'replenishment_needed' || item.relatedCategories.includes('replenishment_needed');

    // Rebuilt now rather than read back from the finding.
    //
    // A plan is a statement about stock as it currently stands, and the gap
    // between a nightly sweep and someone opening the page is exactly where a
    // delivery lands or a sale happens. Showing the stored version would mean
    // approving arithmetic that was true yesterday.
    const plan = isReplenishment ? currentPlan(req.db, req.ctx.workspaceId, item) : null;

    const actionable =
      ((item.category === 'location_imbalance' || item.relatedCategories.includes('location_imbalance')) &&
        Number(item.metrics.suggestedTransferQuantity) >= 1 &&
        actionPermissions.can(req.user, actionPermissions.OPERATE)) ||
      Boolean(plan && plan.transfers.length && actionPermissions.can(req.user, actionPermissions.OPERATE));

    const presented = withPlanWording(presenter.present(req.db, req.ctx.workspaceId, item), plan);

    return res.page('attention/detail', {
      // The tab title comes from the same place as the heading. Reading the
      // stored one here left the browser tab advertising an order the page had
      // already withdrawn.
      title: presented.title,
      nav: 'attention',
      // The detail route recalculates replenishment against live stock and open
      // orders. Its contextual next step must use that same live presentation;
      // otherwise the shell can repeat the stale title stored when the finding
      // was first detected (for example, still offering an order that is now
      // already drafted).
      screenGuide: {
        description: 'Understand this decision, why StockChief stopped, and the one safe action available now.',
        next: {
          title: presented.title,
          action: null,
          href: null,
        },
      },
      // A finding stores its wording when it is detected. By the time someone
      // opens it, an order may have been drafted or stock received, and the
      // stored heading would then contradict the plan printed beneath it — the
      // same screen arguing with itself. The live plan wins where there is one.
      item: presented,
      history: feedback.listFeedback(req.db, req.ctx.workspaceId, item.attentionId),
      actionable,
      plan,
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
    req.flash('info', `Hidden until ${result.dismissedUntil.slice(0, 10)}. StockChief keeps measuring it.`);
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
        : 'Noted. StockChief records this; it will not quietly change what it checks.'
    );
    res.redirect(303, req.body.returnTo || `/attention/${req.params.id}`);
  })
);

/**
 * Ask StockChief. A GET because it only reads: the answer is shareable, the back
 * button behaves, and nothing is resubmitted by refreshing.
 */

/** Question suggestions a customer could actually send, from their own records. */
function askExamples(db, workspaceId) {
  const item = db
    .prepare('SELECT name FROM items WHERE workspace_id = ? AND is_active = 1 ORDER BY created_at LIMIT 1')
    .get(workspaceId);
  const place = repo.listLocations(db, workspaceId)[0];
  const model = (planApplier.getConfiguration(db, workspaceId) || {}).inventoryModel || {};

  const examples = [];
  if (item) examples.push(`How many ${item.name} do we have?`);
  if (place) examples.push(`What moved at ${place.name} this week?`);
  examples.push('What needs my attention?');
  if ((model.lotRules || {}).enabled) examples.push('Which lots expire soon?');
  examples.push('What has not sold in three months?');
  if (workItems.list(db, workspaceId, { limit: 1 }).length) examples.push('What did you do today?');
  return examples;
}

/*
 * The conversation, as the person remembers it.
 *
 * Ask used to show one question and one answer, with the question before it
 * folded away under a "Previous question" line and everything earlier gone.
 * A person who has asked three things wants to see the three things and what
 * came back, so each turn is kept here — the question, the sentence
 * StockChief said, how many records it read and where it pointed — for this
 * workspace, twelve turns deep. It is a record of what was said, not a cache:
 * an old turn is never re-read and never re-run.
 */
/*
 * What the page says about a goal, in the ledger's terms: the sentence, the
 * status a person can read, and where the answer came from — which lookup,
 * which records, which filters, how many rows, as of when.
 */
function askOutcome(question, result, error) {
  if (error) return { status: 'failed', said: error, provenance: {} };
  const said = result.spoken && !result.progressiveDisclosure ? result.spoken : result.answer;
  const parts = (result.semanticPlan && result.semanticPlan.parts) || [];
  const reads = parts.map((part) => ({
    intent: part.intent,
    dataset: part.recordQuery ? part.recordQuery.dataset : null,
    filters: part.recordQuery ? (part.recordQuery.filters || []).map((f) => `${f.field} ${f.operator}${f.value === null || f.value === undefined ? '' : ` ${f.value}`}`) : [],
    entity: part.entityQuery || null, location: part.locationQuery || null,
  }));
  // "Thanks!" answered with "You're welcome" is not a question waiting on the person.
  const smallTalk = /^\s*(?:thanks|thank you|thx|cheers|hi|hello|hey|ok|okay|great|cool|nice|good morning|good afternoon|bye)\b/i.test(question);
  const status = result.isAction ? 'clarify' : result.needsClarification && !smallTalk ? 'clarify' : result.supported === false && !smallTalk ? 'refused' : 'answered';
  return {
    status, said: String(said || ''),
    resultHref: result.handoff ? result.handoff.href : null, resultLabel: result.handoff ? result.handoff.label : null,
    provenance: {
      intent: result.plan ? result.plan.intent : null, interpretation: result.interpretation || null,
      // A clarification or refusal read nothing; only an answer has reads.
      reads: status !== 'answered' ? [] : reads.length ? reads : (result.plan && result.plan.intent && result.plan.intent !== 'unsupported' ? [{ intent: result.plan.intent, entity: result.plan.entityQuery || null, location: result.plan.locationQuery || null }] : []),
      rowCount: status === 'answered' ? Number(result.totalMatches ?? result.rowCount ?? 0) : null, asOf: status === 'answered' ? nowIso() : null,
    },
  };
}

/*
 * The goal this page answers. A question that came through the composer has
 * an open goal in the session; one reached by a link (an example chip, a
 * hand-off back to Ask) opens its own turn here, unless it is the same
 * question as the last turn — a refresh — in which case it re-settles that.
 */
function goalFor(req, question) {
  const open = req.session.assistantOpenGoal;
  if (open && open.message === question) return open.goalId;
  const convo = assistantTurns.conversationId(req);
  const turns = ledger.conversation(req.db, req.ctx, convo, { limit: 1 });
  const last = turns[turns.length - 1];
  if (last && last.message === question && last.goals.length === 1) return last.goals[0].id;
  const turn = ledger.openTurn(req.db, req.ctx, { conversationId: convo, channel: 'ask', message: question,
    understanding: { how: 'link' }, goals: [{ kind: 'lookup', text: question }] });
  return turn.goals[0].id;
}

router.post('/ask/new', asyncRoute(async (req, res) => {
  assistantTurns.newConversation(req);
  delete req.session.askTranscript;
  delete req.session.askConversation;
  delete req.session.askTurns;
  delete req.session.pendingAskResult;
  res.redirect(303, '/ask');
}));

router.post('/ask/leave-the-rest', asyncRoute(async (req, res) => {
  const n = assistantTurns.skipQueue(req);
  if (n) req.flash('info', `Left ${n === 1 ? 'the last part' : `${n} parts`} of your message undone. That is on the record.`);
  res.redirect(303, trimOrNull(req.body.back) || '/ask');
}));

router.get(
  '/ask',
  asyncRoute(async (req, res) => {
    const question = trimOrNull(req.query.q);
    let result = null;
    let error = null;
    const submittedTurn = (req.session.askTurns || []).find(turn => turn.token === req.query.turn
      && turn.workspaceId === req.ctx.workspaceId && turn.question === question);
    const conversation = req.query.followup === '1' && submittedTurn
      ? submittedTurn.conversation : null;

    /*
     * "What did I just do?" — read back from the ledger: the last few turns,
     * what was asked and what became of each. No model, no guessing.
     */
    if (question && req.query.recap === '1') {
      // The question itself is a turn too; it is not part of the answer.
      const openGoal = req.session.assistantOpenGoal ? req.session.assistantOpenGoal.goalId : null;
      const turns = ledger.conversation(req.db, req.ctx, assistantTurns.conversationId(req), { limit: 8 })
        .filter((turn) => !turn.goals.some((g) => g.id === openGoal || (g.status === 'pending' && g.text === question)));
      const recent = turns.slice(-3);
      const lines = recent.flatMap((turn) => turn.goals.map((g) => `You said “${turn.message.length > 80 ? turn.message.slice(0, 80) + '…' : turn.message}” — ${g.statusLabel.toLowerCase()}${g.said ? `: ${g.said.length > 120 ? g.said.slice(0, 120) + '…' : g.said}` : ''}`));
      result = {
        question, answer: lines.length ? `Here is what just happened, newest last:\n${lines.join('\n')}` : 'Nothing yet in this conversation. Ask me something, or tell me what happened.',
        rows: [], columns: [], rowCount: 0, supported: true, isAction: false, needsClarification: false, handoff: null,
        plan: { intent: 'conversation_recap', entityQuery: '', locationQuery: '' }, interpretation: 'what this conversation has done so far', spoken: null,
      };
    } else if (question) {
      try {
        const pending = req.session.pendingAskResult;
        const reusable = pending && pending.token === req.query.turn && pending.workspaceId === req.ctx.workspaceId && pending.question === question;
        if (reusable) delete req.session.pendingAskResult;
        if (reusable && pending.error) error=pending.error;
        result = reusable ? pending.result : await queryPlanner.ask(req.db, req.ctx.workspaceId, question, {
          provider: req.app.locals.aiProvider || undefined,
          context: briefingContext(req.db, req.ctx.workspaceId),
          membership: req.user,
          productBrain: req.app.locals.productBrain,
          actorId: req.ctx.actorId,
          currentHref: req.get('referer') || '',
          conversation,
          timezone: 'America/New_York',
        });
        /*
         * An instruction typed into the question box.
         *
         * StockChief has one understanding of what somebody said; which box they
         * typed it in should not change whether it understands them. So this
         * hands the sentence to the part that carries instructions out rather
         * than explaining, from here, what StockChief supposedly cannot do —
         * which is how "please delete my entire inventory" got answered with
         * "StockChief cannot delete or wipe an entire inventory". It can.
         */
        if (result && result.plan && result.plan.intent === 'action' && !result.semanticPlan) {
          req.session.pendingActionQuestion = {
            instruction: question,
            question: 'That is something to do rather than something to look up, '
              + 'so StockChief brought it here. Press Continue and it will work out what changes.',
          };
          return res.redirect(303, '/actions');
        }
        if (result && !result.isAction) {
          // The earlier question is joined to this one only when the planner
          // read this message as an answer to it. A pending clarification used
          // to swallow whatever came next — "Draft an email…" typed after
          // "which product did you mean?" became one sentence about prices.
          const continues = conversation?.clarification && result.semanticPlan?.continuesPrevious === true;
          req.session.askConversation = {workspaceId:req.ctx.workspaceId,
            question: continues ? `${conversation.question}\nFollow-up answer: ${question}` : question,
            semanticPlan:result.semanticPlan || null,
            // What the turn found, so a follow-up that leans on it can be told
            // when there was nothing there to lean on.
            rowCount:Number(result.totalMatches ?? result.rowCount ?? 0),
            clarification:result.needsClarification ? result.answer : null};
        }
      } catch (err) {
        if (err.status && err.status < 500) error = err.message;
        else throw err;
      }
    }
    if (question && (result || error)) {
      const goalId = goalFor(req, question);
      delete req.session.assistantOpenGoal;
      ledger.settle(req.db, req.ctx, goalId, askOutcome(question, result, error));
      req.currentGoalId = goalId;
    }
    const transcript = ledger.conversation(req.db, req.ctx, assistantTurns.conversationId(req), { limit: 12 });

    /*
     * The rules already said, beside the box they were said into. A standing
     * rule that never appears next to the place it was created is a setting
     * somebody has to go looking for, which is the thing this replaces.
     */
    let recentRules = [];
    let pendingRules = [];
    try {
      const instructions = require('../../manager/operating-instructions');
      recentRules = instructions.list(req.db, req.ctx.workspaceId, { status: 'APPROVED' });
      pendingRules = instructions.list(req.db, req.ctx.workspaceId, { status: 'PENDING' });
    } catch {
      // The conversation is worth more than the list beside it.
    }

    res.page('attention/ask', {
      title: 'Ask StockChief',
      nav: 'ask',
      room: true,
      recentRules,
      pendingRules,
      about: trimOrNull(req.query.about) || '',
      question: question || '',
      result,
      error,
      conversation,
      transcript,
      currentGoalId: req.currentGoalId || null,
      conversationId: assistantTurns.conversationId(req),
      aiConfigured: config.ai.configured,
      // Written with this inventory's own product and place where there is one.
      // "How many navy oxfords do we have?" in a business that sells t-shirts
      // teaches nothing except that the screen was written for somebody else,
      // and a new customer cannot tell whether the answer would be empty
      // because StockChief is broken or because the product does not exist.
      examples: askExamples(req.db, req.ctx.workspaceId),
    });
  })
);

module.exports = router;
