'use strict';

const express = require('express');
const crypto = require('node:crypto');
const { ProviderError } = require('../../ai/provider');
const intentRouter = require('../../manager/intent-router');
const paymentIntent = require('../../accounting/payment-intent');
const managerContext = require('../../manager/context');
const investigations = require('../../manager/investigations');
const physicalEvents = require('../../manager/physical-events');
const documentEvents = require('../../manager/document-events');
const documentIntake = require('../../foundry/document-intake');
const documentRemovals = require('../../manager/document-removals');
const importRemovals = require('../../manager/import-removals');
const catalogCodeChanges = require('../../manager/catalog-code-changes');
const managerReadiness = require('../../manager/readiness');
const actionService = require('../../actions/action-service');
const proposals = require('../../actions/proposal-service');
const actionPresenter = require('../../actions/presenter');
const assistantTurns = require('../../assistant/turns');
const ledger = require('../../assistant/ledger');
const tools = require('../../assistant/tools');
const undoService = require('../../assistant/undo');
const importPlans = require('../../imports/plan-service');
const workItems = require('../../autopilot/work-items');
const operatingInstructions = require('../../manager/operating-instructions');
const actionResolver = require('../../actions/resolver');
const managerRunner = require('../../autopilot/runner');
const supplierCodeMappings = require('../../purchasing/supplier-code-mappings');
const managerEvents = require('../../manager/events');
const reactions = require('../../manager/reactions');
const salesIntent = require('../../sales/sales-intent');
const permissions = require('../../actions/permissions');
const priceChanges = require('../../pricing/price-changes');
const inventoryCostInstructions = require('../../accounting/inventory-cost-instructions');
const connectionTell = require('../../connections/tell');
const { requireAuth, requireOwner, asyncRoute } = require('../middleware');
const actionHandoff = require('../action-handoff');
const { trimOrNull } = require('../../lib/util');
const productNavigation = require('../../product-brain/navigation');
const jobRunner = require('../../foundry/job-runner');
const structuredCatalogue = require('../../actions/structured-catalogue');
const catalogueIntelligence = require('../../actions/catalogue-intelligence');
const queryPlanner = require('../../attention/query-planner');

const router = express.Router();
const MAX_PRODUCT_DESCRIPTION = 12_000;
router.use(['/foundry/tell', '/foundry/navigate', '/inventory/describe', '/inventory/catalogue-review', '/needs-you', '/investigations', '/document-removals', '/import-removals', '/catalog-code-changes'], requireAuth);

/** One validated gateway for every destination StockChief offers in conversation. */
router.get('/foundry/navigate', (req, res) => {
  const href = String(req.query.to || '');
  const access = req.app.locals.productBrain.accessForHref(href, req.user);
  if (!access.exists || !access.available || !access.allowed) {
    req.flash('warn', access.reason || 'That destination is not available to you.');
    return res.redirect(303, '/ask');
  }
  const label = String(req.query.label || 'requested page').slice(0, 100);
  const returnTo = String(req.query.return || '/ask');
  productNavigation.remember(req, { href, label }, returnTo);
  return res.redirect(303, href);
});

/**
 * An answer StockChief gives in its own words, shown on the Ask page as any
 * other answer and settled in the ledger as answered.
 */
function plainAnswer(req, res, question, answer, handoff = null, settledAs = null) {
  const token = crypto.randomUUID();
  req.session.askTurns = [...(req.session.askTurns || []).slice(-7), { token, workspaceId: req.ctx.workspaceId, question, conversation: null }];
  req.session.pendingAskResult = { token, workspaceId: req.ctx.workspaceId, question, result: {
    question, answer, rows: [], columns: [], rowCount: 0, supported: true, isAction: false, needsClarification: false, handoff,
    plan: { intent: settledAs ? 'undo' : 'small_talk', entityQuery: '', locationQuery: '' }, interpretation: 'a reply, not a lookup', spoken: null, settledAs,
  } };
  return res.redirect(303, `/ask?q=${encodeURIComponent(question)}&followup=1&turn=${token}`);
}

/** Whether the sentence names one of this inventory's products. */
function productNavigationMentions(req, text) {
  try {
    return Boolean(productNavigation.mentionsProduct(req.db, req.ctx.workspaceId, text));
  } catch { return false; }
}

function actionRedirect(result) {
  if (result.kind === 'proposal' || result.kind === 'existing') return `/actions/${result.proposal.proposalId}`;
  if (result.kind === 'plan') return `/actions/plan/${result.plan.planId}`;
  return null;
}

function catalogueSubject(description, max = 90) {
  const oneLine = String(description || '').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  const cut = oneLine.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trim()}…`;
}

function startCatalogueReview(req, description) {
  const instruction = `Create: ${description}`;
  const db = req.db;
  const ctx = req.ctx;
  const membership = req.user;
  const provider = req.app.locals.aiProvider || undefined;
  const jobId = jobRunner.createJob(ctx.workspaceId, 'catalogue_review', description, {
    track: 'catalogue',
    subject: catalogueSubject(description),
    subjectDetail: 'the products you asked StockChief to add',
    db,
  });

  jobRunner.run(jobId, async (setStage, signal) => {
    setStage('catalogue_reading');
    const structured = structuredCatalogue.parse(instruction);
    const catalogueUnderstanding = structured && structured.structuredRecords
      ? await catalogueIntelligence.analyze(description, structured.structuredRecords, { provider, signal })
      : null;
    const result = await actionService.interpret(db, ctx, membership, instruction, {
      provider,
      maxInstruction: MAX_PRODUCT_DESCRIPTION + 'Create: '.length,
      signal,
      catalogueUnderstanding,
    });
    setStage('catalogue_preparing');
    const target = actionRedirect(result);
    if (target) return { redirectTo: target };
    if (result.kind === 'catalogue_question') {
      return {
        catalogueReview: {
          recordCount: result.structuredRecordCount,
          records: result.structuredRecords,
          issues: result.structuredIssues,
          understanding: catalogueUnderstanding,
        },
      };
    }
    if (result.kind === 'question' && result.question) {
      return {
        question: result.question,
        instruction,
        choices: result.choices || null,
        continuation: result.continuation || null,
      };
    }
    return {
      errorMessage: result.message || result.unsupported
        || 'StockChief could not make a safe product preview from that description. Nothing was added.',
    };
  }, {
    db,
    deadlineMs: Number(req.app.locals.catalogueReviewDeadlineMs) || 30_000,
    timeoutMessage: 'StockChief could not finish reviewing those products within 30 seconds. Nothing was created, and your description is still here.',
  });

  return jobId;
}

/**
 * Describing products is an inventory action, not another pass through
 * business setup. Keep it on its own URL so an already-configured workspace
 * can turn ordinary words into the same reviewable catalogue proposals as
 * Ask StockChief without ever falling back into onboarding.
 */
router.get('/inventory/describe', (req, res) => {
  const priorJobId = String(req.query.review || '');
  const priorJob = priorJobId ? jobRunner.getJob(priorJobId, req.ctx.workspaceId, req.db) : null;
  res.page('inventory/describe', {
    title: 'Tell StockChief what you sell',
    nav: 'inventory',
    description: priorJob && priorJob.kind === 'catalogue_review' ? (priorJob.description || '') : '',
    error: null,
    catalogueReview: null,
  });
});

router.post('/inventory/describe', asyncRoute(async (req, res) => {
  const description = trimOrNull(req.body.description) || '';
  if (description.length < 3) {
    return res.status(400).page('inventory/describe', {
      title: 'Tell StockChief what you sell',
      nav: 'inventory',
      description,
      error: 'Describe at least one product you want StockChief to add.',
      catalogueReview: null,
    });
  }
  if (description.length > MAX_PRODUCT_DESCRIPTION) {
    return res.status(400).page('inventory/describe', {
      title: 'Tell StockChief what you sell',
      nav: 'inventory',
      description,
      error: `Keep this description to ${MAX_PRODUCT_DESCRIPTION.toLocaleString()} characters or import a file for a larger catalogue.`,
      catalogueReview: null,
    });
  }

  const jobId = startCatalogueReview(req, description);
  return res.redirect(303, `/foundry/thinking/${jobId}`);
}));

function catalogueReviewJob(req) {
  const job = jobRunner.getJob(req.params.jobId, req.ctx.workspaceId, req.db);
  if (!job || job.kind !== 'catalogue_review' || job.status !== 'done'
      || !job.result || !job.result.catalogueReview) return null;
  return job;
}

function renderMissingDetails(req, res, job, options = {}) {
  const originalReview = job.result.catalogueReview;
  const reconciledRecords = structuredCatalogue.reconcileComponentSkus(originalReview.records || []);
  const review = options.review || {
    ...originalReview,
    records: reconciledRecords,
    issues: structuredCatalogue.issueList(reconciledRecords),
  };
  const existing = req.db.prepare(`SELECT s.code, i.name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1
    ORDER BY i.name, s.code`).all(req.ctx.workspaceId);
  const submitted = review.records
    .filter((record) => record.code)
    .map((record) => ({ code: record.code, name: record.name }));
  const seen = new Set();
  const knownSkus = [...submitted, ...existing].filter((sku) => {
    const code = String(sku.code || '').toLowerCase();
    if (!code || seen.has(code)) return false;
    seen.add(code);
    return true;
  });
  return res.status(options.status || 200).page('inventory/catalogue-missing', {
    title: 'Complete the missing product details',
    nav: 'inventory',
    jobId: job.id,
    description: job.description || '',
    review,
    errors: options.errors || [],
    answers: options.answers || {},
    knownSkus,
  });
}

router.get('/inventory/catalogue-review/:jobId', (req, res) => {
  const job = catalogueReviewJob(req);
  if (!job) {
    req.flash('warn', 'That catalogue review is no longer available. Start the review again.');
    return res.redirect(303, '/inventory/describe');
  }
  const originalReview = job.result.catalogueReview;
  const records = structuredCatalogue.reconcileComponentSkus(originalReview.records || []);
  const review = { ...originalReview, records, issues: structuredCatalogue.issueList(records) };
  // Reviews completed by an older parser may already contain every answer in
  // their literal fields. Re-read that evidence and continue instead of
  // presenting an empty or repeated question screen.
  if (!review.issues.length) {
    const nextJobId = startCatalogueReview(req, structuredCatalogue.serialize(records));
    return res.redirect(303, `/foundry/thinking/${nextJobId}`);
  }
  return renderMissingDetails(req, res, job, { review });
});

router.post('/inventory/catalogue-review/:jobId', asyncRoute(async (req, res) => {
  const job = catalogueReviewJob(req);
  if (!job) {
    req.flash('warn', 'That catalogue review is no longer available. Start the review again.');
    return res.redirect(303, '/inventory/describe');
  }
  const storedReview = job.result.catalogueReview;
  const records = structuredCatalogue.reconcileComponentSkus(storedReview.records || []);
  const review = { ...storedReview, records, issues: structuredCatalogue.issueList(records) };
  const existingCodes = req.db.prepare(`SELECT code FROM skus
    WHERE workspace_id = ? AND is_active = 1`).all(req.ctx.workspaceId).map((row) => row.code);
  const resolved = structuredCatalogue.resolveIssues(review.records, review.issues, req.body, { existingCodes });
  if (!resolved.ok) {
    return renderMissingDetails(req, res, job, { status: 422, errors: resolved.errors, answers: req.body });
  }
  const nextJobId = startCatalogueReview(req, resolved.description);
  return res.redirect(303, `/foundry/thinking/${nextJobId}`);
}));

/**
 * A capability question is not yet a policy change.
 *
 * "Can you set up restrictions?" asks what StockChief can do and where to begin.
 * Sending that sentence straight into the rule compiler produces a technically
 * accurate but useless list of missing fields. Keep the product knowledge
 * deterministic, answer the question, and offer one bounded next choice.
 */
function asksAboutRestrictions(message) {
  const clean = String(message || '').trim();
  // A button answer is appended to the original sentence by the shared
  // continuation form. It is no longer the broad capability question and
  // must continue into the selected restriction instead of reopening the
  // same menu.
  if (/\bClarification\s*:/i.test(clean)) return false;
  return /^(?:(?:can|could|would|will)\s+(?:you|foundry)\s+(?:help\s+(?:me\s+)?)?(?:set(?:\s*up)?|create|configure|add|manage)\s+(?:some\s+|any\s+)?(?:restrictions?|limits?|guardrails?|rules?)|(?:what|which)\s+(?:restrictions?|limits?|guardrails?|rules?)\s+(?:can|could|does|would)\s+(?:you|foundry)\b)/i.test(clean)
    && !/\b\d+(?:\.\d+)?\b/.test(clean);
}

function restrictionHelp(message) {
  return {
    question: 'Yes. StockChief can protect low stock, limit automatic purchasing or transfers, control supplier price and quantity changes, and decide when supplier emails may be sent. Which restriction do you want to set first?',
    instruction: message,
    choices: [
      {
        label: 'Protect low stock',
        value: 'Set up stock protection. Ask me for the product, location if relevant, limit, and what should be blocked.',
        workflowKind: 'stock_protection',
      },
      {
        label: 'Limit purchasing',
        value: 'Set a purchasing approval or spend limit. Ask me for the supplier, product scope, and amount.',
        workflowKind: 'purchase_authority',
      },
      {
        label: 'Limit transfers',
        value: 'Set a transfer restriction. Ask me for the product or locations and maximum quantity.',
        workflowKind: 'transfer_authority',
      },
      {
        label: 'Control supplier changes',
        value: 'Set supplier price or quantity-change tolerances. Ask me which supplier and percentage.',
        workflowKind: 'supplier_tolerance',
      },
      {
        label: 'Control supplier emails',
        value: 'Set supplier email sending authority. Ask me which supplier and automatic send limit.',
        workflowKind: 'supplier_email_authority',
      },
    ],
    tone: null,
    answerAction: '/foundry/tell',
    workflow: 'restriction_setup',
    workflowStep: 'category',
  };
}

const RESTRICTION_FLOW_TTL_MS = 30 * 60 * 1000;

function activeRestrictionFlow(req) {
  const flow = req.session.pendingRestrictionFlow;
  return Boolean(flow && Number(flow.startedAt) > Date.now() - RESTRICTION_FLOW_TTL_MS);
}

const PRODUCT_RULE_DOMAINS = new Set([
  'replenishment', 'location_stock', 'supplier_assignment', 'supplier_terms', 'stock_protection',
]);

/**
 * Turn a failed product resolution into a product decision, not a generic
 * "missing detail" or a misleading preview about "this inventory".
 */
function productResolution(db, workspaceId, proposal) {
  for (let index = 0; index < proposal.resolvedChanges.length; index += 1) {
    const resolved = proposal.resolvedChanges[index] || {};
    if (!PRODUCT_RULE_DOMAINS.has(resolved.domain) || resolved.skuId) continue;
    const raw = proposal.changes[index] || {};
    const result = actionResolver.resolveSku(db, workspaceId, raw.itemText, raw.variantText, {
      instruction: proposal.statedAs,
      groundIdentity: true,
    });
    if (result && result.ok) continue;
    const query = trimOrNull(raw.itemText) || trimOrNull(raw.variantText)
      || (proposal.questions.join(' ').match(/[“"]([^”"]+)[”"]/) || [])[1]
      || 'that product';
    // Six candidates that are one product's variants are not six guesses:
    // the product was found, and the question is which variants the rule
    // covers. The page can then offer all of them as one answer.
    const itemIds = new Set((result?.candidates || []).map((candidate) => candidate.item_id).filter(Boolean));
    const oneProduct = result?.reason === 'ambiguous' && itemIds.size === 1 && (result.candidates || []).length > 1
      ? { itemId: [...itemIds][0], name: result.candidates[0].item_name || result.candidates[0].name, count: result.candidates.length } : null;
    return {
      query,
      reason: result?.reason || 'not_found',
      oneProduct,
      candidates: (result?.candidates || []).map((candidate) => ({
        skuId: candidate.item_id ? candidate.id : null,
        label: [candidate.item_name || candidate.name, candidate.variant_label].filter(Boolean).join(' — '),
        answer: [candidate.item_name || candidate.name, candidate.variant_label].filter(Boolean).join(' '),
      })),
      createHref: `/inventory/new?name=${encodeURIComponent(query)}&resumeInstructionId=${encodeURIComponent(proposal.id)}`,
    };
  }
  return null;
}

/** Convert an incomplete rule into the next human question, never model/debug prose. */
function incompleteRestrictionQuestion(message) {
  const clean = String(message || '').toLowerCase();
  if (/price|quantity[- ]?change|tolerance/.test(clean)) {
    return 'Which supplier should this apply to, and what percentage change may StockChief accept without asking you?';
  }
  if (/email|message|send/.test(clean)) {
    return 'Which supplier is this for, and up to what order value may StockChief send without asking you?';
  }
  if (/transfer|move/.test(clean)) {
    return 'What product or locations should the transfer restriction cover, and what maximum quantity should be allowed?';
  }
  if (/purchase|buy|spend|order approval/.test(clean)) {
    return 'Which supplier or products should the purchasing restriction cover, and what approval or spending limit do you want?';
  }
  if (/stock|sale|outgoing|issue|low/.test(clean)) {
    return 'Which product should StockChief protect, at what quantity, and should it block outgoing stock or only warn you?';
  }
  return 'What should StockChief restrict: low-stock sales, purchasing, transfers, supplier changes, or supplier email sending?';
}

/*
 * Truthful when a reader cannot be reached.
 *
 * The model behind a reader going away is not a failure of the request and
 * not "something went wrong on our side": nothing was read, nothing was
 * guessed, nothing changed. The message goes back into the box with that
 * said above it, and the ledger records the goal as unavailable — not
 * failed, not refused. It used to be a generic 500 page with the sentence
 * gone.
 */
function readerUnavailable(err) {
  if (!err) return false;
  if (err.code === 'ai_provider_error' || err.code === 'ai_invalid_output' || err.code === 'ai_refusal') return true;
  if (err instanceof ProviderError) return true;
  return /could not reach its (?:reading|question|model)|took too long to read|ran out of room|reading service/i.test(String(err.message || ''));
}

router.post('/foundry/tell', asyncRoute(async (req, res) => {
  try {
    return await tellStockChief(req, res);
  } catch (err) {
    const unavailable = readerUnavailable(err) || require('../../assistant/calls').unavailableNow();
    if (!unavailable) throw err;
    const message = String(req.body.message || '').trim();
    const said = 'StockChief could not reach its reading service just now, so your message was not read; no figures were guessed and nothing changed. It is still in the box — try again in a moment.';
    try { assistantTurns.settleNow(req, { status: 'unavailable', said, provenance: { reason: 'provider_unavailable' } }); } catch (settleErr) { console.error('[foundry] could not settle the goal as unavailable', settleErr); }
    if (req.body.queryConversation === '1') {
      const token = crypto.randomUUID();
      req.session.pendingAskResult = { token, workspaceId: req.ctx.workspaceId, question: message, error: said, result: null, unavailable: true };
      return res.redirect(303, `/ask?q=${encodeURIComponent(message)}&followup=1&turn=${token}`);
    }
    req.flash('warn', said);
    return res.redirect(303, '/#tell-foundry');
  }
}));

async function tellStockChief(req, res) {
  const attached = (req.files || []).find((entry) => entry.field === 'file' && entry.size > 0);
  // A clarification answer must continue the original manager request. The
  // action surface carries these two fields back rather than making someone
  // retype the sentence; recombining them here lets the manager classify the
  // completed thought again instead of forcing every answer through the stock
  // movement parser.
  const original = trimOrNull(req.body.original) || '';
  const answer = trimOrNull(req.body.answer) || '';
  const workflow = trimOrNull(req.body.workflow) || '';
  const workflowStep = trimOrNull(req.body.workflowStep) || '';
  const workflowKind = trimOrNull(req.body.workflowKind) || '';
  let message = answer
    ? `${original}${original ? ' — Clarification: ' : ''}${answer}`
    : trimOrNull(req.body.message) || (attached ? `Import ${attached.filename}` : '');
  // The same semantic boundary handles every Ask submission. Reads remain
  // reads; instructions continue directly into the registered manager handler
  // in this POST, rather than displaying a second 'work out' button.
  let chatAction = req.body.prepareOnly === '1';
  /*
   * One understanding, one ledger row per goal, before anything runs.
   *
   * A message with several things in it used to be whichever of them the
   * first reader noticed. Now it is split once, every goal is recorded as
   * pending, the first is carried through the dispatcher below, and the rest
   * wait in the session for the person to continue or leave undone — either
   * way, on the record.
   */
  if (!attached && message) {
    const earlier = req.session.askConversation?.workspaceId === req.ctx.workspaceId
      ? req.session.askConversation : null;
    message = await assistantTurns.begin(req, res, message, {
      channel: req.body.queryConversation === '1' ? 'ask' : 'tell',
      provider: req.app.locals.aiProvider || undefined,
      previousQuestion: earlier ? earlier.question : null,
      noSplit: Boolean(answer),
    });
  }
  /*
   * "What did I just do?" is answered from the ledger, not by a model asking
   * what is meant. The Ask page composes it from the last turns.
   */
  if (!attached && message && /^\s*(?:what (?:did|have) i (?:just )?(?:do|done|ask|asked|say|said)|what was the last thing|what have we done|recap|what did you (?:just )?do)\b/i.test(message)) {
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}&recap=1`);
  }
  /*
   * "Thanks" and "hello" are answered as a person would, without a model and
   * without dragging the last question along. A thank-you also closes the
   * question that was open, so the next message starts clean.
   */
  const thanks = /^\s*(?:ok(?:ay)?[,!.]?\s*)?(?:thanks|thank you|thx|cheers|great|cool|nice|perfect|awesome|got it|good|bye|see you)(?:\s+(?:a lot|so much|very much|stockchief|foundry))?\s*[.!]*\s*$/i.test(message);
  const greeting = /^\s*(?:hi|hello|hey|good (?:morning|afternoon|evening))(?:\s+(?:there|stockchief|foundry))?\s*[.!]*\s*$/i.test(message);
  if (!attached && message && (thanks || greeting)) {
    if (thanks) delete req.session.askConversation;
    return plainAnswer(req, res, message, thanks
      ? 'You’re welcome.'
      : 'Hello. Ask about stock, orders, suppliers or money — or tell StockChief what happened.');
  }
  /*
   * "Undo that" is the last thing this conversation did, from the ledger:
   * withdrawn if it had not run, cancelled if it was a draft, reversed as a
   * new change for approval if it ran, and said plainly when it cannot be.
   */
  if (!attached && message && undoService.ASKS_UNDO.test(message)) {
    const target = undoService.findTarget(req.db, req.ctx, assistantTurns.conversationId(req));
    let outcome;
    try {
      outcome = undoService.undo(req.db, req.ctx, req.user, target, { session: req.session });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      outcome = { done: false, said: err.message };
    }
    assistantTurns.settleNow(req, { status: outcome.done ? (outcome.status || 'done') : 'refused', said: outcome.said, resultHref: outcome.href || null, resultLabel: outcome.label || null });
    if (outcome.href && outcome.status === 'needs_approval') { req.flash('info', outcome.said); return res.redirect(303, outcome.href); }
    return plainAnswer(req, res, message, outcome.said, outcome.href ? { href: outcome.href, label: outcome.label } : null, outcome.done ? 'done' : 'refused');
  }
  /*
   * "Do it" typed into the chat means the thing waiting for approval. It is
   * opened, not run: a stock change is approved on its own page, with the
   * checks that page runs, never from a chat message.
   */
  if (!attached && message && actionService.AGREEMENT.test(message)) {
    // The one this conversation just prepared comes first; only when the
    // conversation has none does the workspace-wide list decide.
    const last = ledger.lastSettled(req.db, req.ctx, assistantTurns.conversationId(req));
    const lastId = last && last.status === 'needs_approval' && /^\/actions\/([A-Za-z0-9_-]+)$/.exec(String(last.resultHref || '').split('?')[0]);
    const fromConversation = lastId ? proposals.get(req.db, req.ctx.workspaceId, lastId[1]) : null;
    const open = fromConversation && fromConversation.status === 'AWAITING_APPROVAL'
      ? [fromConversation]
      : proposals.listOpen(req.db, req.ctx.workspaceId, { limit: 5 }).filter((p) => p.status === 'AWAITING_APPROVAL');
    if (open.length === 1) {
      req.flash('info', 'Here it is. Press Approve to carry it out — StockChief does not change stock from a chat message.');
      assistantTurns.settleNow(req, { status: 'needs_approval', resultHref: `/actions/${open[0].proposalId}`, resultLabel: 'Review and approve', said: 'Opened for your approval. Press Approve there to carry it out; nothing has changed yet.' });
      return res.redirect(303, `/actions/${open[0].proposalId}`);
    }
    if (open.length > 1) chatAction = true;
  }
  /*
   * "Actually, make it 15" right after a proposal is a correction to that
   * proposal. It goes to the action reader, which already knows the
   * proposal on the table, rather than to the question planner, which
   * asked what "15" was meant to be.
   */
  /*
   * The understanding already said what kind of thing this goal is. A rule
   * ("when it reaches 4, notify me… and I shouldn't be able to sell more")
   * or a change typed into the chat is not a question, and sending it to
   * the question planner got back "which product are you referring to?"
   * — a question about a rule the rule reader would simply have compiled.
   */
  if (!attached && req.body.queryConversation === '1' && message && req.assistantGoal
      && ['instruction', 'change', 'send'].includes(req.assistantGoal.kind) && !req.assistantCorrection) {
    chatAction = true;
  }
  if (!attached && req.body.queryConversation === '1' && message && (req.assistantCorrection || chatAction)) {
    // What is being corrected, in full: the proposal on the table when there
    // is one (with the place and batch it settled on), otherwise the question
    // still open, otherwise the sentence as the ledger holds it.
    let earlier = '';
    if (req.assistantCorrection) {
      const of = req.assistantCorrection.of;
      const proposalId = of.status === 'needs_approval' && /^\/actions\/([A-Za-z0-9_-]+)$/.exec(String(of.resultHref || '').split('?')[0]);
      const prepared = proposalId ? proposals.get(req.db, req.ctx.workspaceId, proposalId[1]) : null;
      if (prepared) {
        earlier = actionPresenter.oneLine(req.db, req.ctx.workspaceId, prepared);
        // The question that led to this proposal was answered; it is not what
        // "actually" refers to.
        delete req.session.pendingActionQuestion;
      } else {
        const handedQuestion = req.session.pendingActionQuestion;
        earlier = (handedQuestion && handedQuestion.instruction) || req.assistantCorrection.text || '';
      }
    }
    if (earlier && !/ — Clarification: /.test(earlier)) message = `${earlier} — Clarification: ${message}`;
    chatAction = true;
  } else if (!attached && req.body.queryConversation === '1' && message) {
    const token = crypto.randomUUID();
    const previous = req.session.askConversation?.workspaceId === req.ctx.workspaceId
      ? req.session.askConversation : null;
    // Snapshot the referent at submission time. Refresh/back must not reinterpret
    // a follow-up against its own answer.
    let result;
    try {
      result = await tools.use(req.db, req.ctx, req.user, 'question.ask', { question: message }, {
        provider:req.app.locals.aiProvider || undefined,
        productBrain:req.app.locals.productBrain,
        conversation:previous,timezone:'America/New_York',
        referentNote:req.assistantReferentNote || '',
      });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.session.askTurns=[...(req.session.askTurns||[]).slice(-7),{
        token,workspaceId:req.ctx.workspaceId,question:message,conversation:previous,
      }];
      req.session.pendingAskResult={token,workspaceId:req.ctx.workspaceId,question:message,error:err.message,result:null};
      return res.redirect(303, `/ask?q=${encodeURIComponent(message)}&followup=1&turn=${token}`);
    }
    if (!result.isAction) {
      req.session.askTurns = [...(req.session.askTurns || []).slice(-7), {
        token,workspaceId:req.ctx.workspaceId,question:message,conversation:previous,
      }];
      // One interpretation, not a second paid call after the redirect. Consume
      // once; later refreshes perform fresh reads against the immutable turn.
      req.session.pendingAskResult={token,workspaceId:req.ctx.workspaceId,question:message,result};
      // Settled now, with the answer; the page settles it again the same way.
      if (req.assistantGoal) { try { require('./attention').settleAsked(req, req.assistantGoal.id, message, result, null); } catch (err) { console.error('[foundry] could not settle the asked goal', err); } }
      return res.redirect(303, `/ask?q=${encodeURIComponent(message)}&followup=1&turn=${token}`);
    }
    chatAction = true;
    /*
     * A pending clarification joins this message only when the planner read
     * it as the answer. Before, any message typed after "which product did
     * you mean?" was glued to that question, so "Draft an email to Acme"
     * became a selling-price change. A message that starts something new
     * closes the old question instead.
     */
    if (previous?.clarification && result.semanticPlan?.continuesPrevious === true) message=`${previous.question}\nFollow-up answer: ${message}`;
    else delete req.session.askConversation;
  }
  const tabular = attached && /\.(csv|tsv|xlsx|xls|txt)$/i.test(attached.filename || '');
  // A photo or screenshot is a document too; it is read by OCR on the same
  // path as a PDF, instead of being filed unread as "evidence".
  const operationalDocument = attached && /\.(pdf|docx|xlsx|xls|csv|tsv|txt|png|jpe?g|webp|bmp|tiff?)$/i.test(attached.filename || '');
  const receivingHint = /arriv|deliver|shipment|packing|receive|received|supplier invoice/i.test(message);
  const pricingUpdateHint = /\b(?:price|prices|pricing|selling\s+price|retail\s+price)\b/i.test(message)
    && /\b(?:apply|change|set|update|use)\b/i.test(message);
  const photo = attached && /\.(png|jpe?g|webp|bmp|tiff?)$/i.test(attached.filename || '');
  let understood = null;
  if (operationalDocument && (!tabular || receivingHint)) {
    try {
      understood = await documentEvents.understand(req.db, req.ctx, attached, {
        provider: req.app.locals.aiProvider || undefined,
      });
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      // A photo with no readable text is not a document: a picture of the
      // damage, of the shelf. It is kept as evidence of what the person
      // said, below, exactly as before. A document that cannot be read is
      // said so.
      if (!photo) {
        req.flash('warn', err.message);
        return res.redirect(303, req.body.queryConversation === '1' ? '/ask' : '/#tell-foundry');
      }
    }
  }
  if (understood) {
    const matched = understood.match.matched ? {
      purchaseOrderId: understood.match.purchaseOrderId,
      poNumber: understood.match.poNumber,
      receiptLines: understood.match.receiptLines,
      matchReasons: understood.match.reasons,
      documentNumber: understood.interpretation.documentNumber,
    } : { candidates: understood.match.candidates, documentNumber: understood.interpretation.documentNumber };
    // An invoice or stock report with real line-item evidence is not an
    // "unknown physical event" merely because no earlier PO exists. It may be
    // the first supplier invoice or an owner adding a new line of inventory.
    // Preserve the exact interpretation and show the ordinary document review;
    // nothing is created or received until the owner approves that preview.
    const canBecomeInventory = !understood.match.matched
      && ['invoice', 'stock_report'].includes(understood.interpretation.documentType)
      && understood.interpretation.lines.length > 0;
    if (canBecomeInventory) {
      const prepared = documentIntake.prepareFromInterpretation(
        req.db, req.ctx, req.user, attached, understood.interpretation, understood.extractedText
      );
      // A previous version filed this same document as an unresolved physical
      // event. Once the document has a concrete review, that generic exception
      // is stale and must not remain actionable beside the real preview.
      req.db.prepare(`UPDATE physical_events SET status = 'COMPLETED', updated_at = datetime('now')
        WHERE workspace_id = ? AND status = 'NEEDS_HUMAN'
          AND attachment_name = ? AND attachment_content = ?`)
        .run(req.ctx.workspaceId, attached.filename, attached.buffer);
      req.flash('success', `StockChief read ${attached.filename}. Review every product, variant, quantity, supplier and destination before anything changes.`);
      return res.redirect(303, `/foundry/proposal/${prepared.understandingId}`);
    }
    const event = physicalEvents.record(req.db, req.ctx, {
      eventType: 'shipment_arrived', statedAs: trimOrNull(req.body.message) || `Uploaded ${attached.filename}.`,
      details: { interpretation: understood.interpretation }, matchedEntities: matched,
      attachmentName: attached.filename, attachmentMime: attached.mimeType, attachmentBuffer: attached.buffer,
    });
    if (event.status === 'ROUTED') {
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: event.matchedEntities.purchaseOrderId,
        entities: { purchaseOrderId: event.matchedEntities.purchaseOrderId, physicalEventId: event.id } });
      req.flash('success', `StockChief read ${attached.filename}, matched it to ${event.matchedEntities.poNumber}, and prepared the receipt. Review the physical quantities before stock changes.`);
      return res.redirect(303, `/purchasing/orders/${event.matchedEntities.purchaseOrderId}/receive?event=${event.id}`);
    }
    req.flash('info', `StockChief read ${attached.filename}, but could not safely match it to exactly one open purchase order.`);
    return res.redirect(303, '/needs-you');
  }
  if (tabular) {
    const { plan } = await importPlans.analyse(req.db, req.ctx, req.user, {
      buffer: attached.buffer, filename: attached.filename,
      operationScope: pricingUpdateHint ? 'selling_price_update' : null,
    });
    req.flash('success', pricingUpdateHint
      ? `StockChief read ${attached.filename} as a pricing update. Review the exact existing variants and prices; this cannot create products or change stock.`
      : `StockChief read ${attached.filename}. Review the exact changes before anything is applied.`);
    return res.redirect(303, `/imports/${plan.id}`);
  }
  if (attached) {
    const lower = message.toLowerCase();
    const eventType = /damag|broken|spoiled/.test(lower) ? 'damage'
      : /arriv|deliver|shipment|packing/.test(lower) ? 'shipment_arrived'
        : /count|counted/.test(lower) ? 'physical_count'
          : /return/.test(lower) ? 'return' : /found/.test(lower) ? 'found_stock' : 'reported_event';
    const event = physicalEvents.record(req.db, req.ctx, {
      eventType, statedAs: trimOrNull(req.body.message) || `Attached ${attached.filename} for StockChief to review.`,
      attachmentName: attached.filename, attachmentMime: attached.mimeType, attachmentBuffer: attached.buffer,
    });
    req.flash('info', 'StockChief saved the evidence. The unresolved physical fact is in Needs you.');
    return res.redirect(303, '/needs-you');
  }

  // Purchase cost is the current price paid per inventory unit, not the
  // historical value of whatever happens to be on hand today. Preview the
  // exact products and their customer-price consequence before changing it.
  if (inventoryCostInstructions.matchesInstruction(message)) {
    try {
      const prepared = inventoryCostInstructions.prepare(req.db, req.ctx, message);
      req.session.pendingPurchaseCostBatch = prepared.proposals.map((proposal) => proposal.id);
      req.flash('success', `StockChief understood ${prepared.currency} ${(prepared.unitCostMinor / 100).toFixed(2)} as the current purchase cost for ${prepared.productCount} product${prepared.productCount === 1 ? '' : 's'}. Review what changes${prepared.belowCostCount ? ` — ${prepared.belowCostCount} would sell below cost` : ''}.`);
      return res.redirect(303, '/pricing/purchase-costs/batch');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warn', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }

  /*
   * "Lower the price of all the gloves by 10%": a percentage over a product
   * or its variants, read by pattern, one proposal per priced variant on the
   * batch page. It used to be read as a rule about supplier price tolerance.
   */
  if (priceChanges.matchesPercentInstruction(message)) {
    try {
      const batch = priceChanges.interpretPercent(req.db, req.ctx, message);
      req.session.pendingPriceBatch = batch.proposals.map((proposal) => proposal.id);
      req.flash('success', `StockChief worked out ${batch.proposals.length} selling-price change${batch.proposals.length === 1 ? '' : 's'}, ${batch.direction < 0 ? 'down' : 'up'} ${batch.pct}% from today's prices.${batch.unpriced ? ` ${batch.unpriced} variant${batch.unpriced === 1 ? ' has' : 's have'} no selling price yet and ${batch.unpriced === 1 ? 'was' : 'were'} left alone.` : ''} Review the list before anything changes.`);
      return res.redirect(303, batch.proposals.length === 1 ? `/pricing/proposals/${batch.proposals[0].id}` : '/pricing/proposals/batch');
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.session.pendingActionQuestion = { unsupported: err.message, instruction: message };
      return res.redirect(303, '/actions');
    }
  }

  if (priceChanges.matchesInstruction(message)) {
    try {
      /*
       * "Add a price for each item" names no product and gives one amount, so
       * it used to reach the single-change path — where the resolver picked one
       * product out of the catalogue and prepared a price for that. The owner
       * asked for every item and got one, which looks like it worked.
       */
      if (priceChanges.matchesEveryProductInstruction(message)) {
        const batch = priceChanges.interpretEvery(req.db, req.ctx, message);
        req.session.pendingPriceBatch = batch.map((proposal) => proposal.id);
        req.flash('success', `StockChief understood one selling price for every product — ${batch.length} in all. Review the complete list before anything changes.`);
        return res.redirect(303, '/pricing/proposals/batch');
      }
      if (priceChanges.matchesBulkInstruction(message)) {
        const batch = await priceChanges.interpretMany(req.db, req.ctx, message, {
          provider: req.app.locals.aiProvider || undefined,
        });
        req.session.pendingPriceBatch = batch.map((proposal) => proposal.id);
        req.flash('success', `StockChief understood ${batch.length} selling-price changes. Review the complete list before anything changes.`);
        return res.redirect(303, '/pricing/proposals/batch');
      }
      const proposal = await priceChanges.interpret(req.db, req.ctx, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      req.flash('success', 'StockChief understood the selling-price change. Review it before anything changes.');
      return res.redirect(303, `/pricing/proposals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      if (err.details && err.details.kind === 'price_clarification') {
        req.session.pendingPriceContinuation = err.details.continuation;
        req.session.pendingActionQuestion = {
          question: err.message,
          instruction: message,
          choices: err.details.choices || null,
          answerAction: '/pricing/clarify',
        };
        return res.redirect(303, '/actions');
      }
      req.flash('warn', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }

  /*
   * "Add a new supplier called Bright Tools, email sales@brighttools.com".
   *
   * The word "supplier" sent this to purchasing, purchasing found no product
   * to buy, and the fallback ran the whole replenishment planner — eight
   * pieces of unrelated work prepared from a sentence about a new supplier.
   * A supplier is added on the suppliers page; the sentence fills the form
   * in and the person presses Add. Nothing is saved from here.
   */
  const newSupplier = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+)?(?:add|create|set\s+up|register)\s+(?:a\s+)?(?:new\s+)?(?:supplier|vendor)\b(.*)$/i.exec(message);
  if (newSupplier && !/\b(?:order|po|purchase order|for|reorder)\b/i.test(newSupplier[1].replace(/\S+@\S+/g, ''))) {
    const rest = newSupplier[1];
    const email = (/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i.exec(rest) || [])[1] || '';
    const phone = (/\b(?:phone|tel|call)\s*:?\s*(\+?[\d\s().-]{7,})/i.exec(rest) || [])[1] || '';
    let name = (/^\s*(?:called|named|name[d]?\s*:?)?\s*["“']?([^,;"”']+?)["”']?\s*(?:,|;|\s+(?:with|whose|their|email|e-mail|phone|tel|contact)\b|$)/i.exec(rest.replace(/\S+@\S+/g, '').trim()) || [])[1] || '';
    name = name.replace(/^(?:called|named)\s+/i, '').replace(/\s+(?:with|and)$/i, '').trim();
    const contact = (/\b(?:contact|rep|representative)\s+(?:is\s+|named\s+|called\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(rest) || [])[1] || '';
    const query = new URLSearchParams({ ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone: phone.trim() } : {}), ...(contact ? { contactName: contact } : {}) });
    req.flash('info', name
      ? `StockChief filled in the new supplier “${name}”${email ? ` (${email})` : ''}. Check it and press Add — nothing is saved yet.`
      : 'Add the supplier here. Nothing is saved until you press Add.');
    return res.redirect(303, `/suppliers?${query.toString()}#add-supplier`);
  }

  /*
   * "Can you create a customer? Name: Moshe, email: …" — a customer is added
   * on the customer form, and the sentence fills it in. Nothing is saved from
   * here. It used to reach the reader, which said "creating a new customer
   * record is not one of the operations listed above" — a model's aside,
   * shown to the owner as a refusal.
   */
  const newCustomer = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|i\s+want\s+to\s+|i'?d\s+like\s+to\s+)?(?:add|create|set\s+up|register|make|new)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:customer|client)\b\s*\??(.*)$/is.exec(message);
  if (newCustomer && !/\b(?:order|invoice|return|payment)\b/i.test(newCustomer[1].replace(/\S+@\S+/g, ''))) {
    const rest = newCustomer[1];
    const email = (/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i.exec(rest) || [])[1] || '';
    const phone = (/\b(?:phone|tel|mobile|cell)\s*:?\s*(\+?[\d\s().-]{7,})/i.exec(rest) || [])[1] || '';
    const stripped = rest.replace(/\S+@\S+/g, '').replace(/\b(?:e-?mail|phone|tel|mobile|cell)\s*:?\s*[\d\s().+-]*/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    let name = (/\b(?:name[d]?|called)\s*:?\s*["“']?([^,;"”'\n]+?)["”']?\s*(?:,|;|$|\s+(?:with|and|whose|their)\b)/i.exec(stripped) || [])[1] || '';
    if (!name) name = (/^[\s,;:—-]*["“']?([^,;"”'\n]+?)["”']?\s*(?:,|;|$)/.exec(stripped) || [])[1] || '';
    name = name.replace(/^(?:called|named|name[d]?\s*:?)\s*/i, '').replace(/\s+(?:with|and)$/i, '').trim();
    const query = new URLSearchParams({ ...(name ? { name } : {}), ...(email ? { email } : {}), ...(phone ? { phone: phone.trim() } : {}) });
    assistantTurns.settleNow(req, { status: 'handed', said: name
      ? `Opened the new-customer form with “${name}”${email ? ` (${email})` : ''} filled in. Check it and press Save — nothing is saved until you do.`
      : 'Opened the new-customer form. Nothing is saved until you press Save.', resultHref: `/sales/customers/new?${query.toString()}`, resultLabel: 'Open the form' });
    req.flash('info', name
      ? `StockChief filled in the new customer “${name}”${email ? ` (${email})` : ''}. Check it and press Save — nothing is saved yet.`
      : 'Add the customer here. Nothing is saved until you press Save.');
    return res.redirect(303, `/sales/customers/new?${query.toString()}`);
  }

  /*
   * "We got a return today, 2 children's sweater navy 4 from Marlow, one is
   * damaged." A customer return is authorised, quarantined, inspected and
   * refunded on the warehouse page; the sentence fills that form in —
   * customer's order, product, quantity, reason — and the person presses
   * Request. It used to be read as a stock change and refused.
   */
  const customerReturn = /\b(?:got|received|had|have)\s+(?:a\s+)?returns?\b|\b(?:returned|sent\s+back|brought\s+back)\b|\bwants?\s+to\s+return\b/i.test(message)
    && !/\b(?:supplier|vendor|send\s+(?:it\s+)?back\s+to)\b/i.test(message);
  if (customerReturn && !attached) {
    const customers = req.db.prepare(`SELECT id, name FROM customers WHERE workspace_id = ? AND (record_state IS NULL OR record_state <> 'ARCHIVED')`).all(req.ctx.workspaceId);
    const said = message.toLowerCase();
    const named = customers.filter((c) => {
      const words = String(c.name || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      return words.length && words.some((w) => new RegExp(`\\b${w}\\b`).test(said));
    });
    // No customer by that name is still a return: the form opens with the
    // name shown, and the person picks the order.
    const spoken = (/\bfrom\s+([A-Z][A-Za-z0-9'&. -]{1,40}?)(?=\s*(?:,|\.|;|$|\s+(?:one|two|and|who|which|the|they|it)\b))/.exec(message) || [])[1] || '';
    if (named.length === 1 || (named.length === 0 && spoken)) {
      const quantity = (/\b(\d+)\s+(?:x\s+)?[a-z]/i.exec(message.replace(/\b(?:one|two|three|four|five)\b/gi, (w) => ({ one: 1, two: 2, three: 3, four: 4, five: 5 })[w.toLowerCase()])) || [])[1] || '1';
      const reason = /\bdamaged\b/i.test(message) ? 'Damaged' : /\bwrong\s+size\b/i.test(message) ? 'Wrong size' : /\bfaulty|broken|defective\b/i.test(message) ? 'Faulty' : /\bunwanted|changed\s+(?:their|his|her)\s+mind\b/i.test(message) ? 'Unwanted' : '';
      const product = mentionsKnownProduct(req.db, req.ctx.workspaceId, message) ? (req.db.prepare('SELECT name FROM items WHERE workspace_id = ? AND is_active = 1').all(req.ctx.workspaceId)
        .map((r) => r.name).find((name) => said.includes(String(name).toLowerCase().replace(/'/g, ''))) || '') : '';
      const who = named[0] ? named[0].name : spoken.trim();
      const query = new URLSearchParams({ returnCustomer: who, returnQuantity: quantity, ...(reason ? { returnReason: reason } : {}), ...(product ? { returnProduct: product } : {}) });
      req.flash('info', named[0]
        ? `StockChief filled in a return from ${who}${quantity !== '1' ? ` for ${quantity}` : ''}${reason ? ` (${reason.toLowerCase()})` : ''}. Check the order and the line, then press Request — nothing is recorded yet.`
        : `StockChief has no customer called “${who}”. Pick the order the return is against, then press Request — nothing is recorded yet.`);
      return res.redirect(303, `/warehouse/operations?${query.toString()}#customer-returns`);
    }
  }

  /*
   * "Rename Downtown Store to City Store." A location is renamed on the
   * locations page; the sentence opens that location's edit form with the
   * new name typed in, and the person presses Save. It used to be refused
   * with "not one of the operations listed".
   */
  const renameLocation = /^\s*(?:please\s+)?(?:rename|call|change\s+the\s+name\s+of)\s+(?:the\s+)?(?:location\s+|store\s+|warehouse\s+)?["“']?(.+?)["”']?\s+(?:to|as)\s+["“']?(.+?)["”']?\s*\.?$/i.exec(message);
  if (renameLocation && !attached) {
    const places = req.db.prepare('SELECT id, name FROM locations WHERE workspace_id = ? AND is_active = 1').all(req.ctx.workspaceId);
    const wanted = renameLocation[1].trim().toLowerCase();
    const place = places.find((p) => p.name.toLowerCase() === wanted) || (places.filter((p) => p.name.toLowerCase().includes(wanted)).length === 1 ? places.find((p) => p.name.toLowerCase().includes(wanted)) : null);
    if (place) {
      const newName = renameLocation[2].trim();
      req.flash('info', `To rename ${place.name} to “${newName}”, check the form and press Save — nothing is renamed yet.`);
      return res.redirect(303, `/locations?edit=${encodeURIComponent(place.id)}&name=${encodeURIComponent(newName)}#modal-location-${place.id}`);
    }
  }

  /*
   * "Cancel PO-1009, we don't need it." A cancellation is done on the
   * order's own page, where the confirmation and the reason live; the
   * sentence takes the person there and says so, and nothing is cancelled
   * from here. It used to be met with "read that as being about
   * purchasing, but not what to do".
   */
  const cancelling = /\b(?:cancel|void|scrap|kill|drop)\b/i.test(message) && /\b(PO-\d+)\b/i.exec(message);
  if (cancelling) {
    const order = req.db.prepare(`SELECT id, po_number, status FROM purchase_orders WHERE workspace_id = ? AND UPPER(po_number) = ?`)
      .get(req.ctx.workspaceId, cancelling[1].toUpperCase());
    if (order) {
      req.flash('info', ['CANCELLED', 'RECEIVED', 'CLOSED'].includes(order.status)
        ? `${order.po_number} is already ${order.status.toLowerCase()}; there is nothing to cancel.`
        : `To cancel ${order.po_number}, press Cancel on its page and say why — nothing is cancelled until you do.`);
      return res.redirect(303, `/purchasing/orders/${order.id}#cancel`);
    }
  }

  // "Newly added products" is a provenance request, not an ambiguous product
  // name. Resolve it from the most recent completed import before asking the
  // general language router, whose catalogue candidates cannot know which
  // records were created together.
  if (importRemovals.matchesInstruction(message)) {
    try {
      const proposal = importRemovals.create(req.db, req.ctx, req.user, message);
      req.flash('warning', `StockChief traced the newly added products to ${proposal.snapshot.source.sourceName}. Choose any combination or remove all; nothing changes until you approve.`);
      return res.redirect(303, `/import-removals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }

  // A sentence the planner already read as work to do is not a request to
  // be taken somewhere. "Send Acme an email about PO-1013" was caught by the
  // navigation resolver on the words "send" and "email", bounced back to
  // Ask, and shown a second "Prepare for review" button.
  const navigation = chatAction ? null : await productNavigation.resolveNatural(req.db, req.ctx.workspaceId, req.user, message, {
    brain: req.app.locals.productBrain,
    provider: req.app.locals.aiProvider || undefined,
    actorId: req.ctx.actorId,
    currentHref: req.get('referer') || '',
  });
  if (navigation) {
    if (navigation.canNavigate && navigation.navigateNow) {
      productNavigation.remember(req, navigation, `/ask?q=${encodeURIComponent(message)}`);
      return res.redirect(303, navigation.href);
    }
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }

  const intent = await intentRouter.classify(req.db, req.ctx, message, {
    provider: req.app.locals.aiProvider || undefined,
    referentNote: req.assistantReferentNote || '',
    goalKind: req.assistantGoal ? req.assistantGoal.kind : null,
  });
  if (asksAboutRestrictions(message)) {
    req.session.pendingRestrictionFlow = { startedAt: Date.now(), instruction: message };
    req.session.pendingActionQuestion = restrictionHelp(message);
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'restriction_help', null, 'NEEDS_CLARIFICATION');
    return res.redirect(303, '/actions');
  }
  // Once somebody has entered the restriction setup, their short answers are
  // answers to that workflow. "Snacks" is a product name, not a new question
  // for the general Ask page. Keep this route deterministic even if the model
  // classifies the isolated word differently.
  const structuredRestriction = workflow === 'restriction_setup';
  const continuingRestriction = answer && (structuredRestriction || activeRestrictionFlow(req)
    || /\bClarification\s*:/i.test(original) && /\b(?:restriction|stock protection|purchase|transfer|supplier)\b/i.test(original));
  if (continuingRestriction) {
    intent.handler = 'operating_instruction';
    intent.intentClass = 'OPERATING_INSTRUCTION';
    intent.clarifyingQuestion = '';
  }
  const restrictionFlow = activeRestrictionFlow(req) ? req.session.pendingRestrictionFlow : null;
  const stockProductAnswer = Boolean(
    (workflowKind === 'stock_protection' && workflowStep === 'product')
    || (restrictionFlow?.kind === 'stock_protection' && restrictionFlow.stage === 'product')
    // Compatibility for a form that was already open before this deployment:
    // the original text names the chosen category, so a server restart must
    // not make the next product answer disappear.
    || /\bClarification\s*:\s*Set up stock protection\b/i.test(original)
  );
  if ((restrictionFlow || structuredRestriction) && (workflowKind === 'stock_protection' || /\bset up stock protection\b/i.test(answer))) {
    const flow = restrictionFlow || (req.session.pendingRestrictionFlow = {
      startedAt: Date.now(), instruction: original || message,
    });
    flow.kind = 'stock_protection';
    flow.stage = 'product';
  }
  if (stockProductAnswer && answer) {
    const proposal = operatingInstructions.proposeStockProtectionAnswer(
      req.db, req.ctx, req.user, answer, message
    );
    delete req.session.pendingRestrictionFlow;
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', proposal.id);
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  }
  // A question from the classifier is a last resort, not a first one.
  //
  // It is written by a model that has seen only the sentence, while the
  // handlers below can look at the actual records — so it asked "should this go
  // to your regular supplier?" where the grounded answer was "no supplier is on
  // file for Trail Ration Pack". Whenever there is a handler that can resolve
  // or ask from real data, it gets the chance first.
  if (intent.handler === 'connection_management' && /^\s*(?:why|what|which|when|where|how)\b/i.test(message)) {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'ask');
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }
  if (intent.handler === 'connection_management' || connectionTell.matches(message)) {
    try {
      const result = connectionTell.apply(req.db, req.ctx, req.user, message);
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'connection_management', result.connection.id);
      req.flash('success', result.message);
      return res.redirect(303, `/settings/connections/${result.connection.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'connection_management', null, 'NEEDS_CLARIFICATION');
      req.flash('warn', err.message);
      return res.redirect(303, '/settings/connections');
    }
  }
  if (intent.clarifyingQuestion && intent.intentClass === 'UNKNOWN') {
    req.session.pendingActionQuestion = {
      question: intent.clarifyingQuestion,
      instruction: message,
      choices: null,
      tone: 'warning',
      answerAction: '/foundry/tell',
    };
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'manager_clarification', null, 'NEEDS_CLARIFICATION');
    return res.redirect(303, '/actions');
  }
  /*
   * A payment that already happened.
   *
   * The sentence is the only way StockChief learns about money that moved outside
   * it. The fields are read from the sentence, the proposal is built against
   * real records, and nothing is posted until the owner sees what it will do —
   * the same shape as every other consequential action here.
   */
  if (intent.intentClass === 'PAYMENT_REPORT') {
    let fields = null;
    try {
      fields = await paymentIntent.read(message, {
        provider: req.app.locals.aiProvider || undefined,
      });
    } catch {
      fields = null;
    }
    if (!fields) {
      req.flash('warn', 'StockChief could not read that payment. Try naming who was paid, how much, and which invoice.');
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'payment_report', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/accounting');
    }
    /*
     * One page for a supplier payment, however the sentence was read.
     *
     * A model that read "I paid ABC Apparel $100 toward invoice 9281" as a
     * pay_supplier action landed on the supplier-payment confirmation with
     * the bill and the amount; the closed keyword form landed somewhere
     * else. The same sentence now reaches the same page: the bill is matched
     * here, and only a payment that cannot be placed on one bill goes to
     * the general reported-payment page.
     */
    if (fields.direction === 'SUPPLIER_PAYMENT' && fields.counterpartyName) {
      const supplierPayments = require('../../actions/supplier-payment');
      const planned = supplierPayments.plan(req.db, req.ctx, {
        supplierText: fields.counterpartyName, amountMinor: paymentIntent.amountFrom(fields.amountText),
        reference: fields.reference || '', instruction: message,
      });
      const handedOn = planned && actionHandoff.handOff(req, planned);
      if (handedOn) {
        intentRouter.markRouted(req.db, req.ctx, intent.id, handedOn.routedTo, handedOn.related);
        return res.redirect(303, handedOn.target);
      }
    }
    req.session.reportedPayment = { fields, said: message };
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'payment_report', null, 'ROUTED');
    return res.redirect(303, '/accounting/payments/reported');
  }

  if (intent.handler === 'sales_order' || intent.intentClass === 'SALES_ORDER') {
    try {
      const parsed = await salesIntent.interpret(req.db, req.ctx, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      if (parsed.operation === 'list_waiting') {
        permissions.assertCan(req.user, permissions.VIEW_SALES, 'view sales orders');
      } else if (parsed.operation === 'fulfill' || parsed.operation === 'complete_order' || parsed.operation === 'cancel_line' || parsed.operation === 'cancel_order') {
        permissions.assertCan(req.user, permissions.FULFILL_SALES, 'fulfill or cancel sales orders');
      } else permissions.assertCan(req.user, permissions.MANAGE_SALES, 'create or change sales orders');
      const result = salesIntent.apply(req.db, req.ctx, parsed, {
        idempotencyKey: `tell-sales:${intent.id}`,
        previewOnly: chatAction,
      });
      if (result.kind === 'question') {
        req.session.pendingSalesContinuation = result.continuation;
        req.session.pendingActionQuestion = {
          question: result.question,
          instruction: message,
          choices: result.choices || null,
          answerAction: '/sales/clarify',
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', null, 'NEEDS_CLARIFICATION');
        return res.redirect(303, '/actions');
      }
      if (result.kind === 'list') {
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_orders');
        return res.redirect(303, '/sales?status=BACKORDERED');
      }
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', result.order.id);
      managerContext.remember(req.db, req.ctx, { entities: { salesOrderId: result.order.id } });
      const summary = result.message || `${result.order.order_number} is ${result.order.status.toLowerCase().replace(/_/g, ' ')}. `
        + `${result.order.totals.allocated} committed, ${result.order.totals.backordered} waiting for stock, `
        + `${result.order.totals.fulfilled} fulfilled.`;
      req.flash(result.kind === 'blocked' || result.order.totals.backordered ? 'warn'
        : result.kind === 'already_completed' ? 'info' : 'success', summary);
      return res.redirect(303, `/sales/orders/${result.order.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'sales_order', null, 'NEEDS_CLARIFICATION');
      req.flash('warn', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  /*
   * Two readers, one sentence. The semantic planner read "send Acme an email
   * asking when PO-1013 will ship" as work to do; the classifier called it
   * a question and sent it back to Ask, where it was shown a "Prepare for
   * review" button for the work the person had already asked for. When the
   * planner has said it is work, a classifier's "question" does not send
   * it back: it goes to the action reader, which asks its own questions.
   */
  const readAsWork = chatAction || (req.assistantGoal && ['send', 'change'].includes(req.assistantGoal.kind));
  if ((intent.handler === 'ask' || ['QUESTION', 'EXPLANATION'].includes(intent.intentClass)) && !readAsWork) {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'ask');
    return res.redirect(303, `/ask?q=${encodeURIComponent(message)}`);
  }
  // Rolling back a document has a much wider scope than archiving one named
  // product. Require explicit document/import wording at this boundary even if
  // the language planner selected the broader capability.
  if (documentRemovals.matchesInstruction(message)) {
    try {
      const proposal = documentRemovals.create(req.db, req.ctx, req.user, message);
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'document_removal', proposal.id);
      req.flash('warning', `StockChief found the earlier file and prepared the exact products it created. Nothing has been removed yet.`);
      return res.redirect(303, `/document-removals/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'document_removal', null, 'NEEDS_CLARIFICATION');
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  if (intent.handler === 'catalog_code_change' || catalogCodeChanges.matchesInstruction(message)) {
    try {
      const proposal = catalogCodeChanges.create(req.db, req.ctx, req.user, message, {
        operation: intent.parameters,
      });
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'catalog_code_change', proposal.id);
      req.flash('info', `StockChief prepared every matching internal code from ${proposal.operation.from} to ${proposal.operation.to}. Nothing has changed yet.`);
      return res.redirect(303, `/catalog-code-changes/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'catalog_code_change', null, 'NEEDS_CLARIFICATION');
      req.flash('warning', err.message);
      return res.redirect(303, '/#tell-foundry');
    }
  }
  if (intent.handler === 'attachment_required' || intent.intentClass === 'IMPORT') {
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'attachment_required', null, 'NEEDS_CLARIFICATION');
    req.flash('info', 'Attach the spreadsheet, PDF or document you want StockChief to read.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.handler === 'purchasing' || intent.intentClass === 'PURCHASING_REQUEST') {
    // Naming a product wins over a remembered order.
    //
    // The classifier is given durable context so short follow-ups like "approve
    // it" resolve, and it duly attached the last purchase order to "order 50
    // more Trail Ration Pack" — which opened a draft for a different product
    // entirely. A message that names something in the catalogue is about that
    // thing, not about whatever was on screen last.
    const namesAProduct = mentionsKnownProduct(req.db, req.ctx.workspaceId, message);
    const reference = intent.resolvedReference;
    if (reference && /^po_/.test(reference) && !namesAProduct) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'purchase_order', reference);
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: reference });
      return res.redirect(303, /receive|arriv|rest/i.test(message)
        ? `/purchasing/orders/${reference}/receive` : `/purchasing/orders/${reference}`);
    }
    // A request naming a product is answered about that product; "order what we
    // need" has named nothing and stays a request for the general plan.
    //
    // Every purchasing request used to run the general replenishment planner
    // and report how many lines it prepared, so "order 50 more Trail Ration
    // Pack" came back as a summary that never mentioned Trail Ration Pack —
    // and the real answer, that nobody is on file to buy it from, was never
    // given. The specific path already exists and answers or asks properly; it
    // just had no caller.
    const specific = await tools.use(req.db, req.ctx, req.user, 'action.prepare', { instruction: message, previewOnly: Boolean(chatAction) }, {
      provider: req.app.locals.aiProvider || undefined,
    });
    if (specific.kind === 'purchase_order' && specific.order) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'purchase_order', specific.order.id);
      managerContext.remember(req.db, req.ctx, { purchaseOrderId: specific.order.id });
      assistantTurns.remember(req, { kind: 'purchase_order', refId: specific.order.id, label: specific.order.poNumber, href: `/purchasing/orders/${specific.order.id}` });
      req.flash('success', `StockChief drafted ${specific.order.poNumber}${(specific.order.lines || []).length > 1 ? ` with ${specific.order.lines.length} lines` : ""}. Nothing is ordered until you approve it.`);
      return res.redirect(303, `/purchasing/orders/${specific.order.id}`);
    }
    /*
     * "We buy it at $1.10" reads as purchasing, but the reader prepared a
     * stock change — a new product, received. What was prepared is what is
     * shown; it used to be left on the actions list while the page asked
     * whether a purchase order was wanted.
     */
    const prepared = actionRedirect(specific);
    if (prepared) {
      const related = specific.proposal ? specific.proposal.proposalId : specific.plan.planId;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'action', related);
      managerContext.remember(req.db, req.ctx, { entities: { actionId: related } });
      assistantTurns.remember(req, { kind: specific.proposal ? 'proposal' : 'plan', refId: related,
        label: specific.proposal ? actionPresenter.oneLine(req.db, req.ctx.workspaceId, specific.proposal) : `the ${specific.plan.lines ? specific.plan.lines.length : ''} changes you asked for`, href: prepared });
      return res.redirect(303, prepared);
    }
    if (specific.kind === 'question' && specific.question && (specific.purchaseSpecific || namesAProduct)) {
      let continuationId = null;
      if (specific.continuation) continuationId = crypto.randomUUID();
      req.session.pendingActionQuestion = {
        question: specific.question,
        instruction: message,
        choices: specific.choices || null,
        continuation: specific.continuation ? {...specific.continuation,previewOnly:chatAction} : null,
        continuationId,
        answerAction: '/actions/ask',
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    if (specific.kind === 'unsupported' && specific.message && (specific.purchaseSpecific || namesAProduct)) {
      req.session.pendingActionQuestion = { unsupported: specific.message, where: specific.where || null, instruction: message };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }

    /*
     * The general replenishment planner runs only for a sentence that asks
     * for it — "what should I order", "order what we need", "plan the
     * restock". Anything else that merely mentions purchasing used to run
     * the whole planner and report the work it had prepared, as if that were
     * an answer to what was said.
     */
    const asksForThePlan = /\b(?:what|which|anything)\s+(?:should|do|to)\s+(?:i|we)\s+(?:order|buy|reorder|restock)|\b(?:order|buy|restock|replenish)\s+(?:what|whatever|everything)\s+(?:we|is|i)\s+(?:need|needed|are\s+low|am\s+low|running\s+low)|\b(?:run|do|make|prepare|plan)\s+(?:the\s+)?(?:replenishment|restock|reorder|purchasing)\b|\bwhat(?:'s|\s+is)\s+(?:running\s+)?low\b/i.test(message);
    if (!asksForThePlan) {
      req.session.pendingActionQuestion = {
        question: 'StockChief read that as being about purchasing, but not what to do. Do you want a purchase order for a product (say which and how many), the reorder plan (“what should I order?”), or something about a supplier?',
        instruction: message,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    const result = managerRunner.run(req.db, req.ctx, req.user, { trigger: 'tell-foundry-purchasing' });
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'manager_purchasing');
    req.flash('success', result.nothingToDo
      ? 'StockChief checked stock, incoming orders, usage, lead times and supplier rules. No purchase is currently supported.'
      : `${result.planned} piece${result.planned === 1 ? '' : 's'} of inventory work prepared; ${result.awaiting} need your decision.`);
    return res.redirect(303, '/');
  }
  if (intent.handler === 'supplier_code_mapping' || intent.intentClass === 'CONFIGURATION_CHANGE') {
    if (intent.handler === 'inventory_cost_update') {
      try {
        const prepared = inventoryCostInstructions.prepare(req.db, req.ctx, message);
        req.session.pendingPurchaseCostBatch = prepared.proposals.map((proposal) => proposal.id);
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'inventory_cost_update');
        req.flash('success', `StockChief understood ${prepared.currency} ${(prepared.unitCostMinor / 100).toFixed(2)} as the current purchase cost for ${prepared.productCount} product${prepared.productCount === 1 ? '' : 's'}. Review what changes${prepared.belowCostCount ? ` — ${prepared.belowCostCount} would sell below cost` : ''}.`);
        return res.redirect(303, '/pricing/purchase-costs/batch');
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'inventory_cost_update', null, 'NEEDS_CLARIFICATION');
        req.flash('warn', err.message);
        return res.redirect(303, '/#tell-foundry');
      }
    }
    const mappingInstruction = supplierCodeMappings.parseInstruction(message);
    if (mappingInstruction.matched) {
      try {
        const result = supplierCodeMappings.previewFromInstruction(req.db, req.ctx, req.user, message);
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'supplier_code_mapping', result.proposal.id);
        managerContext.remember(req.db, req.ctx, {
          entities: { supplierCodeMappingProposalId: result.proposal.id, supplierId: result.proposal.supplierId },
        });
        req.flash('success', `StockChief prepared the exact change from ${result.proposal.vendorCode} to ${result.proposal.internalBaseCode}. Nothing changes until you approve it.`);
        return res.redirect(303, `/supplier-code-mappings/${result.proposal.id}`);
      } catch (err) {
        if (!err.status || err.status >= 500) throw err;
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'supplier_code_mapping', null, 'NEEDS_CLARIFICATION');
        req.flash('info', err.message);
        return res.redirect(303, '/#tell-foundry');
      }
    }
  }
  if (intent.handler === 'inventory_action'
      || ['INVENTORY_ACTION', 'CATALOG_CHANGE', 'CONFIGURATION_CHANGE'].includes(intent.intentClass)
      || (readAsWork && ['QUESTION', 'EXPLANATION', 'UNKNOWN'].includes(intent.intentClass))) {
    const result = await tools.use(req.db, req.ctx, req.user, 'action.prepare', { instruction: message }, {
      provider: req.app.locals.aiProvider || undefined,
      referentNote: req.assistantReferentNote || '',
    });
    const target = actionRedirect(result);
    if (target) {
      const related = result.proposal ? result.proposal.proposalId : result.plan.planId;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'action', related);
      managerContext.remember(req.db, req.ctx, { entities: { actionId: related } });
      assistantTurns.remember(req, { kind: result.proposal ? 'proposal' : 'plan', refId: related,
        label: result.proposal ? actionPresenter.oneLine(req.db, req.ctx.workspaceId, result.proposal) : `the ${result.plan.lines ? result.plan.lines.length : ''} changes you asked for`, href: target });
      return res.redirect(303, target);
    }
    // A message to send, a supplier payment to confirm: understood, and
    // shown on the page that can carry it out.
    const handed = actionHandoff.handOff(req, result);
    if (handed) {
      intentRouter.markRouted(req.db, req.ctx, intent.id, handed.routedTo, handed.related);
      return res.redirect(303, handed.target);
    }
    // Deleting the whole inventory is done on its own page, by name. StockChief
    // says so and points at it, rather than asking "which item?" again.
    if (result.kind === 'delete_inventory') {
      req.session.pendingActionQuestion = {
        unsupported: result.message,
        where: result.where || null,
        instruction: message,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    if (result.kind === 'missing_location') {
      req.session.pendingLocationTransfer = {
        locationName: result.locationName,
        instruction: result.instruction,
        line: result.line,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'missing_location', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions/location-required');
    }
    // A question goes where it can be answered. Only a flat refusal — something
    // StockChief cannot do at all — belongs in a message you dismiss.
    if (result.kind === 'question' && result.question) {
      let continuationId = null;
      if (result.continuation) {
        continuationId = crypto.randomUUID();
        req.session.pendingActionContinuation = { id: continuationId, value: result.continuation };
      }
      req.session.pendingActionQuestion = {
        question: result.question,
        instruction: message,
        reason: result.reason || null,
        choices: result.choices || null,
        where: result.where || null,
        continuationId,
        // Kept server-side with the handed question. The actions GET restores
        // it into the one-use continuation slot immediately before rendering,
        // so a redirect/session save cannot separate the button from the
        // parsed request it is meant to continue.
        continuation: result.continuation || null,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    // The same refusal, whichever class the sentence was read as. Being
    // declined by a rule is not a request for clarification, and is not
    // recorded as one.
    if (result.kind === 'unsupported' && (result.message || result.unsupported)) {
      req.session.pendingActionQuestion = {
        unsupported: result.message || result.unsupported,
        blocked: result.blocked || null,
        where: result.where || null,
        instruction: message,
      };
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null,
        result.blocked ? 'REFUSED' : 'NEEDS_CLARIFICATION');
      return res.redirect(303, '/actions');
    }
    /*
     * Every kind the reader can return is handled above. If one is not, that
     * is a fault in StockChief, and it is reported as one — not as a request for
     * the person to explain a sentence that was already clear.
     */
    console.error('[tell] interpret returned a kind this route does not show', { kind: result.kind });
    req.flash('error', result.message
      || 'StockChief understood that but has no screen for it yet. That is a fault on our side, not in what you wrote. Nothing was changed.');
    return res.redirect(303, '/#tell-foundry');
  }
  if (intent.handler === 'physical_event' || intent.intentClass === 'PHYSICAL_EVENT') {
    const event = await physicalEvents.recordNatural(req.db, req.ctx, message, {
      provider: req.app.locals.aiProvider || undefined,
    });

    // A delivery with no purchase order behind it is still a delivery.
    //
    // Matching an arrival to an open order is the happy path, but plenty of
    // stock arrives without one — during setup there are no orders at all. That
    // case used to stop dead: StockChief had read the product, location and
    // quantity correctly and then parked the whole thing in Needs you as an
    // event it could not place, so "we received 12 bags into the Warehouse"
    // recorded nothing and offered nothing to do about it.
    //
    // It goes to the ordinary controlled path instead — the same interpret,
    // preview and approve that typing it as an instruction would have used. No
    // stock moves here; a proposal is created and somebody still says yes.
    // Any report StockChief could not place, not just a delivery.
    //
    // An event left needing a person with no investigation behind it is one
    // StockChief failed to resolve — "sold 5 House Blend" when House Blend comes
    // in two sizes. Parking it repeats the sentence back as though that were
    // the explanation. The ordinary controlled path knows how to ask "which
    // one?", so it gets asked. A count that genuinely produced an
    // investigation is excluded: that already has somewhere to go.
    if (event.status === 'NEEDS_HUMAN' && !event.investigationId && !event.matchedEntities.purchaseOrderId) {
      const asAction = await tools.use(req.db, req.ctx, req.user, 'action.prepare', { instruction: message }, {
        provider: req.app.locals.aiProvider || undefined,
      });
      const actionTarget = actionRedirect(asAction);
      if (actionTarget) {
        const related = asAction.proposal ? asAction.proposal.proposalId : asAction.plan.planId;
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'action', related);
        managerContext.remember(req.db, req.ctx, { entities: { actionId: related } });
        // The flash says what was prepared, not "receipt" for a write-off.
        const op = asAction.proposal ? String(asAction.proposal.operation || asAction.proposal.actionType || '') : '';
        req.flash('info', op === 'receive'
          ? 'No open order matches that delivery, so StockChief prepared it as a receipt. Nothing changes until you approve it.'
          : 'StockChief read what happened and prepared the matching stock change. Nothing changes until you approve it.');
        return res.redirect(303, actionTarget);
      }
      const handedOn = actionHandoff.handOff(req, asAction);
      if (handedOn) {
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        intentRouter.markRouted(req.db, req.ctx, intent.id, handedOn.routedTo, handedOn.related);
        return res.redirect(303, handedOn.target);
      }
      // A question about the delivery is still better asked than filed away.
      if (asAction.kind === 'question' && asAction.question) {
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        req.session.pendingActionQuestion = {
          question: asAction.question,
          instruction: message,
          choices: asAction.choices || null,
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'NEEDS_CLARIFICATION');
        return res.redirect(303, '/actions');
      }
      // Understood perfectly, and refused anyway.
      //
      // "We sold 10 Black Large at Downtown Store" leaves nothing to ask: the
      // product, the place, the quantity and the direction are all settled.
      // What stops it is that Downtown has four and this inventory does not
      // allow negative stock. That is a fact about the stock, not a gap in the
      // sentence — and it used to be filed as one, as a reported event sitting
      // in Needs you asking for details nobody could name, because this
      // fallback only forwarded proposals and questions and let a refusal
      // drop through to the generic "could not place it" ending.
      //
      // A refusal is an answer. It goes back to the person who asked, with the
      // numbers behind it, and the event is closed rather than left waiting.
      if (asAction.kind === 'unsupported' && asAction.message) {
        physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
        req.session.pendingActionQuestion = {
          unsupported: asAction.message,
          blocked: asAction.blocked || null,
          instruction: message,
        };
        intentRouter.markRouted(req.db, req.ctx, intent.id, 'actions', null, 'REFUSED');
        return res.redirect(303, '/actions');
      }
    }

    intentRouter.markRouted(req.db, req.ctx, intent.id, 'physical_event', event.id);
    // What is said, and where they are sent, both follow what actually happened.
    const outcome = physicalEvents.describeOutcome(req.db, req.ctx.workspaceId, event);
    req.flash('info', outcome.message);
    return res.redirect(303, outcome.redirectTo);
  }
  if (intent.handler === 'investigation' || intent.intentClass === 'INVESTIGATION_REQUEST') {
    const created = investigations.create(req.db, req.ctx.workspaceId, {
      trigger: 'operator_request', affectedEntities: managerContext.get(req.db, req.ctx.workspaceId, req.ctx.actorId).lastEntities,
      observedDifference: { statedAs: message }, confidence: 'low',
      recommendedNextStep: 'Name the product and location, or provide a physical count, so StockChief can compare it with the ledger.',
      actorUserId: req.ctx.actorId,
    });
    const investigated = investigations.investigate(req.db, req.ctx.workspaceId, created.investigation.investigationId);
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'investigation', investigated.investigationId);
    managerContext.remember(req.db, req.ctx, { investigationId: investigated.investigationId });
    return res.redirect(303, `/investigations/${investigated.investigationId}`);
  }
  // Somebody asking StockChief to stop gets StockChief stopped, now, not a form.
  // Pausing takes no inventory action, is reversible in one click, and is the
  // only reading of "stop" that is safe to be wrong about.
  // "Stop reordering PTFE tape" is about PTFE tape, not about StockChief.
  // A stop that names a product is a rule for that product, read below as an
  // operating instruction; it never pauses everything.
  if (intent.handler === 'autopilot_pause' || intent.intentClass === 'STOP') {
    const aboutAProduct = /^\s*(?:please\s+)?(?:stop|pause|halt|don'?t|do not|never|quit)\s+(?:re-?order(?:ing)?|order(?:ing)?|restock(?:ing)?|buy(?:ing)?|purchas(?:e|ing)|sell(?:ing)?|stock(?:ing)?|send(?:ing)?|email(?:ing)?)\s+(?:the\s+|any\s+|more\s+)?[a-z0-9]/i.test(message)
      && productNavigationMentions(req, message);
    if (aboutAProduct) {
      intent.handler = 'operating_instruction';
      intent.intentClass = 'OPERATING_INSTRUCTION';
    }
  }
  if (intent.handler === 'autopilot_pause' || intent.intentClass === 'STOP') {
    const state = autopilotModes.get(req.db, req.ctx.workspaceId);
    if (state.paused) {
      req.flash('info', 'StockChief is already paused. Nothing runs automatically until you resume it.');
    } else {
      autopilotModes.pause(req.db, req.ctx, req.user, message);
      req.flash('success', 'Stopped. StockChief will not do anything automatically until you resume it. Work already waiting for you is still there.');
    }
    intentRouter.markRouted(req.db, req.ctx, intent.id, 'autopilot_pause');
    return res.redirect(303, '/autopilot');
  }
  if (intent.handler === 'operating_instruction'
      || ['POLICY_CHANGE', 'OPERATING_INSTRUCTION'].includes(intent.intentClass)) {
    // “Everything” is not a bounded instruction. It can only open the guided
    // review; it can never be translated into broad authority or approved in
    // one step.
    /*
     * A shipping rule is a policy change with a shape StockChief can read exactly.
     *
     * Tried before the general path because the general path produces a
     * proposal for a person to approve, and this one does not need to: every
     * value in it came out of the owner's own characters by pattern, so there
     * is nothing for them to check that they did not just type. What it cannot
     * read cleanly falls through to the ordinary proposal, which is the right
     * place for anything uncertain about what StockChief may do.
     */
    const shippingRule = require('../../shipping/rule-intent').read(message);
    if (shippingRule.understood) {
      const saved = require('../../shipping/rule-intent').applySentence(req.db, req.ctx, message);
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'shipping_rule', saved.saved.id);
      req.flash('success', `Saved: ${saved.because} StockChief still needs permission to buy labels `
        + 'before it acts on this by itself.');
      return res.redirect(303, '/settings/shipping');
    }
    if (shippingRule.needs) {
      // Understood the subject, not the limits. Say what is missing rather
      // than sending a shipping sentence off to a generic policy proposal.
      req.flash('warn', shippingRule.because);
      return res.redirect(303, '/settings/shipping');
    }

    // “Everything” is not a bounded instruction.
    if (/handle\s+everything|everything\s+you\s+(?:safely\s+)?can/i.test(message)) {
      req.session.policyReviewAll = true;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'policy_settings');
      req.flash('info', 'Unlimited authority is never created. StockChief opened the bounded transfer and purchasing policies it can safely support.');
      return res.redirect(303, '/autopilot');
    }
    try {
      const proposal = await operatingInstructions.interpret(req.db, req.ctx, req.user, message, {
        provider: req.app.locals.aiProvider || undefined,
      });
      delete req.session.pendingRestrictionFlow;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', proposal.id);
      return res.redirect(303, `/operating-instructions/${proposal.id}`);
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      intentRouter.markRouted(req.db, req.ctx, intent.id, 'operating_instruction', null, 'NEEDS_CLARIFICATION');
      req.session.pendingActionQuestion = {
        question: incompleteRestrictionQuestion(message),
        instruction: message,
        choices: null,
        tone: 'warning',
        answerAction: '/foundry/tell',
        workflow: 'restriction_setup',
        workflowKind: /\bstock protection\b/i.test(message) ? 'stock_protection' : workflowKind || null,
        workflowStep: /\bstock protection\b/i.test(message) ? 'product' : workflowStep || null,
      };
      return res.redirect(303, '/actions');
    }
  }
  req.flash('warn', 'StockChief could not safely route that yet. Say what happened or what outcome you want.');
  return res.redirect(303, '/#tell-foundry');
}

/**
 * Does this message name a product this inventory actually has?
 *
 * Whole words only, so a size called "S" or a product called "Pack" inside
 * another word cannot make a general request look like a specific one.
 */
function mentionsKnownProduct(db, workspaceId, message) {
  const text = ` ${String(message || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const rows = db
    .prepare(
      `SELECT i.name, s.variant_label, s.code
         FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
        LIMIT 500`
    )
    .all(workspaceId);
  return rows.some((row) =>
    [row.name, row.code].some((value) => {
      const needle = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return needle.length > 1 && text.includes(` ${needle} `);
    })
  );
}

const autopilotPresenter = require('../../autopilot/presenter');
const needsYouInbox = require('../../manager/needs-you-inbox');
const needsYouDismissals = require('../../manager/needs-you-dismissals');
const autopilotModes = require('../../autopilot/modes');

router.get('/operating-instructions/:id', asyncRoute(async (req, res) => {
  const proposal = operatingInstructions.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/operating-instruction', {
    title: 'Review what StockChief should remember', nav: 'settings', proposal,
    clarification: operatingInstructions.clarificationFor(proposal),
    productResolution: productResolution(req.db, req.ctx.workspaceId, proposal),
    descriptions: proposal.resolvedChanges.map(operatingInstructions.describe),
  });
}));

router.get('/document-removals/:id', asyncRoute(async (req, res) => {
  const proposal = documentRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/document-removal', {
    title: proposal.status === 'COMPLETED' ? 'Imported products removed' : 'Review products to remove',
    nav: 'inventory', proposal,
  });
}));

router.get('/import-removals/:id', asyncRoute(async (req, res) => {
  const proposal = importRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/import-removal', {
    title: proposal.status === 'COMPLETED' ? 'Imported products removed' : 'Choose imported products to remove',
    nav: 'inventory', proposal,
  });
}));

router.post('/import-removals/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const pending = importRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
    const itemIds = req.body.selectionMode === 'all'
      ? pending.snapshot.items.map((item) => item.id)
      : req.body.itemIds;
    const proposal = importRemovals.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash), itemIds
    );
    req.flash('success', `Removed ${proposal.result.productsRemoved} product${proposal.result.productsRemoved === 1 ? '' : 's'} added by ${proposal.result.sourceName}. Earlier inventory was not affected.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/import-removals/${req.params.id}`);
}));

router.post('/import-removals/:id/cancel', asyncRoute(async (req, res) => {
  importRemovals.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No products or stock were changed.');
  return res.redirect(303, '/');
}));

router.post('/document-removals/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const pending = documentRemovals.get(req.db, req.ctx.workspaceId, req.params.id);
    const itemIds = req.body.selectionMode === 'all'
      ? pending.snapshot.items.map((item) => item.id)
      : req.body.itemIds;
    const proposal = documentRemovals.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash), itemIds
    );
    req.flash('success', `Removed ${proposal.result.productsRemoved} product${proposal.result.productsRemoved === 1 ? '' : 's'} added by ${proposal.result.sourceName}. The audit history remains.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/document-removals/${req.params.id}`);
}));

router.post('/document-removals/:id/cancel', asyncRoute(async (req, res) => {
  documentRemovals.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No products or stock were changed.');
  return res.redirect(303, '/');
}));

router.get('/catalog-code-changes/:id', asyncRoute(async (req, res) => {
  const proposal = catalogCodeChanges.get(req.db, req.ctx.workspaceId, req.params.id);
  return res.page('manager/catalog-code-change', {
    title: proposal.status === 'COMPLETED' ? 'Catalogue codes changed' : 'Review catalogue code changes',
    nav: 'inventory', proposal,
  });
}));

router.post('/catalog-code-changes/:id/approve', requireOwner, asyncRoute(async (req, res) => {
  try {
    const proposal = catalogCodeChanges.approve(
      req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.integrityHash)
    );
    req.flash('success', `Changed ${proposal.result.productCount} product code${proposal.result.productCount === 1 ? '' : 's'} and ${proposal.result.skuCount} SKU${proposal.result.skuCount === 1 ? '' : 's'}.`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/catalog-code-changes/${req.params.id}`);
}));

router.post('/catalog-code-changes/:id/cancel', asyncRoute(async (req, res) => {
  catalogCodeChanges.cancel(req.db, req.ctx.workspaceId, req.params.id);
  req.flash('success', 'Cancelled. No catalogue codes were changed.');
  return res.redirect(303, '/');
}));

router.post('/operating-instructions/:id/approve', asyncRoute(async (req, res) => {
  try {
    const proposal = operatingInstructions.approve(req.db, req.ctx, req.user, req.params.id, req.body.integrityHash);
    const said = `Remembered. ${proposal.resolvedChanges.length === 1 ? 'This rule is' : 'These rules are'} now active and future events will use them.`;
    req.flash('success', said);
    // The conversation that asked for this rule now reads it as done, and
    // the person goes back to it — with the next part of their message, if
    // there was one, offered there. It used to stay "needs your approval"
    // in the chat after the rule was already in force.
    const goal = ledger.goalByResult(req.db, req.ctx, assistantTurns.conversationId(req), `/operating-instructions/${req.params.id}`);
    if (goal && goal.status !== 'done') {
      ledger.settle(req.db, req.ctx, goal.id, { status: 'done', said, resultHref: `/operating-instructions/${req.params.id}`, resultLabel: 'Open the rule' });
      const turn = ledger.getTurn(req.db, req.ctx.workspaceId, goal.turnId);
      return res.redirect(303, turn && turn.channel === 'ask' ? '/ask' : '/#tell-foundry');
    }
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, `/operating-instructions/${req.params.id}`);
}));

router.post('/operating-instructions/:id/cancel', asyncRoute(async (req, res) => {
  operatingInstructions.cancel(req.db, req.ctx, req.params.id);
  req.flash('success', 'Left unchanged. StockChief did not remember that instruction.');
  return res.redirect(303, '/');
}));

/*
 * An answered question makes a new proposal with a new id. The goal in the
 * chat that led here follows it, so approving the answered rule still
 * settles that goal and brings the person back to the conversation.
 */
function followRule(req, fromId, toId) {
  if (!toId || fromId === toId) return;
  try {
    const goal = ledger.goalByResult(req.db, req.ctx, assistantTurns.conversationId(req), `/operating-instructions/${fromId}`);
    if (goal && goal.status !== 'done') ledger.settle(req.db, req.ctx, goal.id, { resultHref: `/operating-instructions/${toId}` });
  } catch (err) { console.error('[foundry] could not follow the rule proposal', err); }
}

router.post('/operating-instructions/:id/answer', asyncRoute(async (req, res) => {
  try {
    const proposal = await operatingInstructions.answer(req.db, req.ctx, req.user, req.params.id, req.body.answer, {
      provider: req.app.locals.aiProvider || undefined,
    });
    followRule(req, req.params.id, proposal.id);
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
    return res.redirect(303, `/operating-instructions/${req.params.id}`);
  }
}));

router.post('/operating-instructions/:id/select-product', asyncRoute(async (req, res) => {
  try {
    const proposal = operatingInstructions.selectProduct(
      req.db, req.ctx, req.user, req.params.id, req.body.skuId
    );
    followRule(req, req.params.id, proposal.id);
    return res.redirect(303, `/operating-instructions/${proposal.id}`);
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
    return res.redirect(303, `/operating-instructions/${req.params.id}`);
  }
}));

router.post('/operating-instructions/:id/remove', asyncRoute(async (req, res) => {
  try {
    operatingInstructions.remove(req.db, req.ctx, req.user, req.params.id);
    req.flash('success', 'Rule removed. StockChief will no longer follow it.');
  } catch (err) {
    if (!err.status || err.status >= 500) throw err;
    req.flash('error', err.message);
  }
  return res.redirect(303, '/settings#learned-instructions');
}));

/**
 * Finishing one thing StockChief could not record.
 *
 * The card used to point at the general Tell StockChief box, where the only thing
 * a customer could do was retype the sentence that had already failed. This
 * takes the sentence they already gave, works it out again now, and lands them
 * on whatever actually resolves it:
 *
 *   it resolves      → the prepared change, ready to approve
 *   it needs an answer → that exact question, with a box to answer it, and the
 *                        original sentence carried along so nothing is retyped
 *   a rule refuses it → the refusal, with the ways out
 *
 * The event is closed the moment it stops being something waiting for a person,
 * rather than being left behind as a second copy of a job already done.
 */
router.get(
  '/needs-you/event/:id',
  asyncRoute(async (req, res) => {
    const event = physicalEvents.get(req.db, req.ctx.workspaceId, req.params.id);
    if (!event) {
      req.flash('error', 'That is no longer waiting for you.');
      return res.redirect(303, '/needs-you');
    }

    const result = await tools.use(req.db, req.ctx, req.user, 'action.prepare', { instruction: event.statedAs }, {
      provider: req.app.locals.aiProvider || undefined,
    });

    // It resolves now: the change is prepared and the event has been dealt with.
    const target = actionRedirect(result);
    if (target) {
      physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
      req.flash('info', 'StockChief worked this out. Nothing changes until you approve it.');
      return res.redirect(303, target);
    }

    // It needs an answer. The question is carried to the one screen that can
    // take it, along with the sentence, so answering continues the original
    // request instead of starting a new one.
    if (result.kind === 'question' && result.question) {
      req.session.pendingActionQuestion = {
        question: result.question,
        instruction: event.statedAs,
        choices: result.choices || null,
        physicalEventId: event.id,
      };
      return res.redirect(303, '/actions');
    }

    if (result.kind === 'unsupported' && result.message) {
      physicalEvents.complete(req.db, req.ctx.workspaceId, event.id);
      req.session.pendingActionQuestion = {
        unsupported: result.message,
        blocked: result.blocked || null,
        instruction: event.statedAs,
      };
      return res.redirect(303, '/actions');
    }

    // Nothing above fits. Say so plainly rather than bouncing them somewhere.
    req.session.pendingActionQuestion = {
      question: 'What should StockChief record for this? Say the product, the place and how many.',
      instruction: event.statedAs,
      physicalEventId: event.id,
    };
    return res.redirect(303, '/actions');
  })
);

// This is a durable owner decision, not the old "skip for now" cursor.  The
// central inbox applies it to every surface that reports Needs You, while the
// source record remains intact and auditable in its normal domain screen.
router.post('/needs-you/dismiss', asyncRoute(async (req, res) => {
  const entryId = trimOrNull(req.body.entryId);
  const visible = needsYouInbox.inbox(req.db, req.ctx.workspaceId, req.user, {
    productBrain: req.app.locals.productBrain,
  });
  if (!entryId || !visible.some((entry) => entry.id === entryId)) {
    req.flash('warn', 'That item is no longer waiting for you.');
    return res.redirect(303, '/needs-you');
  }
  needsYouDismissals.dismiss(req.db, req.ctx, entryId);
  require('../../attention/needs-you-count').invalidateNeedsYou(req.db,req.ctx.workspaceId);
  req.flash('success', 'Dismissed completely. StockChief will not surface it again; the underlying record was not changed.');
  return res.redirect(303, '/needs-you');
}));

router.get(['/needs-you', '/needs-you/all'], asyncRoute(async (req, res) => {
  // An opening-balance investigation is answered by recording the stock, and
  // the person who just recorded it should not be asked for it again.
  investigations.settleOpeningBalances(req.db, req.ctx.workspaceId);
  const unifiedInbox = needsYouInbox.inbox(req.db, req.ctx.workspaceId, req.user, {
    productBrain: req.app.locals.productBrain,
  });
  res.locals.attentionCount = Number.isInteger(unifiedInbox.totalCount)
    ? unifiedInbox.totalCount : unifiedInbox.length;
  res.page(req.path === '/needs-you/all' ? 'manager/needs-you-all' : 'manager/needs-you', {
    title: 'Needs you', nav: 'attention', room: true,
    // Which decision in the stack is on screen. A position rather than a
    // filter: the desk is cleared in order, and skipping moves the position
    // rather than hiding the entry.
    at: Number(req.query.at || 0) || 0,
    // One list, built by one contract. The per-mechanism collections below are
    // still passed for anything else reading this page, but the page itself
    // renders the inbox.
    inbox: unifiedInbox,
    // Which slice of the inbox is on screen. Filtering happens in the view over
    // the list it already has, so the filter is a link rather than something
    // that only works once JavaScript has loaded.
    show: ['urgent', 'important'].includes(String(req.query.show || '')) ? String(req.query.show) : 'all',
    // The unified inbox already contains investigations, work approvals,
    // physical events, findings and corrections. Rebuilding those legacy
    // collections here did all of the same large-workspace queries a second
    // time even though neither Needs You view reads them.
  });
}));

router.get('/investigations/:id', asyncRoute(async (req, res) => {
  investigations.settleOpeningBalances(req.db, req.ctx.workspaceId);
  const investigation = investigations.get(req.db, req.ctx.workspaceId, req.params.id);
  res.page('manager/investigation', { title: 'Investigation', nav: 'attention', investigation,
    events: investigations.events(req.db, req.ctx.workspaceId, req.params.id) });
}));

/**
 * Confirming a count and correcting the ledger are one job in two halves.
 *
 * Resolving an investigation deliberately does not touch stock, and it must
 * stay that way — a button that silently writes a balance is the thing this
 * whole layer exists to avoid. But closing the investigation and stopping there
 * left the opposite problem: StockChief had confirmed physical evidence that the
 * shelf held five, went on recording eight, and reported that nothing needed
 * anybody. Known-wrong inventory with an empty exceptions list is worse than an
 * open question.
 *
 * So confirming prepares the ordinary correction instead — the same adjust
 * proposal any person could raise, carrying the count and the words they
 * confirmed it with — and it waits for the same approval as every other
 * correction. Nothing here writes a balance.
 */
router.post('/investigations/:id/resolve', asyncRoute(async (req, res) => {
  const note = trimOrNull(req.body.note);
  const investigation = investigations.get(req.db, req.ctx.workspaceId, req.params.id);
  const entities = (investigation && investigation.affectedEntities) || {};
  const observed = Number((investigation && investigation.observedDifference || {}).observed);
  const wantsCorrection = req.body.correct === '1';

  investigations.resolve(req.db, req.ctx, req.params.id, note);
  reactions.publishAndReact(req.db, req.ctx.workspaceId, managerEvents.TYPES.COUNT_CONFIRMED, {
    investigationId: req.params.id,
    skuId: entities.skuId || null,
    locationId: entities.locationId || null,
    observed: Number.isFinite(observed) ? observed : null,
  }, { sourceRecordType: 'investigation', sourceRecordId: `${req.params.id}:resolved` });

  if (wantsCorrection && entities.skuId && entities.locationId && Number.isFinite(observed)) {
    const location = req.db
      .prepare('SELECT name FROM locations WHERE id = ? AND workspace_id = ?')
      .get(entities.locationId, req.ctx.workspaceId);
    const built = proposals.build(req.db, req.ctx, {
      actionType: 'adjust',
      resolvedSkuId: entities.skuId,
      lotCode: '',
      serials: [],
      sourceLocation: location ? location.name : '',
      destinationLocation: '',
      quantity: -1,
      adjustmentTarget: observed,
      reasonCode: 'physical_count',
      assumptions: [
        `Counted ${observed} against ${investigation.observedDifference.expected} on record.`,
        note ? `You confirmed it: “${note}”` : 'You confirmed the physical count.',
      ].filter(Boolean),
    });

    if (built.ok) {
      const stored = proposals.persist(req.db, req.ctx, built.proposal, {
        sourceType: 'FOUNDRY_RECOMMENDATION',
        instruction: `Confirmed physical count of ${observed} for ${entities.displayName || 'this product'}`,
      });
      req.flash(
        'success',
        'Count confirmed. StockChief prepared the correction to the ledger — it still needs your approval, '
          + 'and nothing has changed yet.'
      );
      return res.redirect(303, `/actions/${stored.proposalId}`);
    }

    // The ledger may already agree by the time this is confirmed. Say so rather
    // than pretending a correction is waiting.
    req.flash('info', built.unsupported || built.question
      || 'StockChief could not prepare that correction. The investigation is closed and stock is unchanged.');
    return res.redirect(303, '/needs-you');
  }

  req.flash('success', 'Investigation closed without changing stock. The evidence remains in Activity.');
  res.redirect(303, '/needs-you');
}));

module.exports = router;
