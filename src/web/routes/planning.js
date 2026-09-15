'use strict';

/**
 * The planning surface.
 *
 * Two buttons and a page. The buttons are the point — everything Foundry
 * predicts appears where the work already is (Home, Needs you, the product,
 * purchasing), and each of those places needs somewhere to send a decision.
 *
 * The page exists for the times somebody wants the whole picture at once: what
 * is heading for zero, which rules have drifted, where stock is in the wrong
 * shop, what money is asleep on a shelf, and how Foundry's past predictions
 * actually turned out. It is deliberately not the front door. An owner who has
 * to open a forecasting tab every morning is an owner the forecasting is
 * failing.
 */

const express = require('express');
const permissions = require('../../actions/permissions');
const planning = require('../../forecasting/planning-service');
const recommendations = require('../../forecasting/recommendations');
const applyService = require('../../forecasting/apply');
const outcomes = require('../../forecasting/outcomes');
const goalsService = require('../../forecasting/goals');
const preferences = require('../../autopilot/preferences');
const learningService = require('../../learning/service');
const { requireAuth, asyncRoute } = require('../middleware');
const { trimOrNull } = require('../../lib/util');

const router = express.Router();
router.use('/planning', requireAuth);

/** Where to send somebody back to, without trusting a URL they handed us. */
function backTo(req, fallback = '/planning') {
  const target = String(req.body.returnTo || '');
  return /^\/[a-z0-9\-/_#?=.]*$/i.test(target) ? target : fallback;
}

router.get('/planning', asyncRoute(async (req, res) => {
  const goals = goalsService.forWorkspace(req.db, req.ctx.workspaceId);

  /*
   * Every panel is fetched defensively and separately. This page is the one
   * place that shows all of the forecasting at once, so it is also the one
   * place where a single unreadable product could take the whole screen down.
   */
  const safely = (work, fallback) => { try { return work(); } catch { return fallback; } };

  const sweep = safely(() => planning.sweep(req.db, req.ctx.workspaceId, { limit: 25 }),
    { shortages: [], purchases: [], policyChanges: [], transfers: [], decisions: [], informational: [], scanned: 0 });
  const excess = safely(() => planning.excessReview(req.db, req.ctx.workspaceId, { goals }),
    { rows: [], totals: {}, headline: 'Foundry could not read the stock position just now.' });
  const accuracy = safely(() => outcomes.accuracy(req.db, req.ctx.workspaceId),
    { scored: 0, summary: 'No forecast has been scored yet.' });
  const inventoryPosition = safely(() => goalsService.inventoryPosition(req.db, req.ctx.workspaceId, goals),
    { heldMinor: 0, capMinor: null, within: true });
  const learning = safely(() => learningService.run(req.db, req.ctx.workspaceId),
    { metrics: { observations:0, supplierLeadTime:[], interventionRate:null }, proposals:[] });

  res.page('planning/index', {
    backTo: { href: '/inventory', label: 'Inventory' },
    title: 'What happens next',
    nav: 'inventory',
    sweep,
    excess,
    accuracy,
    goals,
    statedGoals: safely(() => goalsService.describe(req.db, req.ctx.workspaceId), []),
    inventoryPosition,
    learning,
    learningProposals: safely(() => learningService.listProposals(req.db, req.ctx.workspaceId), []),
    open: safely(() => recommendations.open(req.db, req.ctx.workspaceId, { limit: 50 }), []),
    canOperate: permissions.can(req.user, permissions.OPERATE),
    canAdmin: permissions.can(req.user, permissions.ADMIN),
  });
}));

router.post('/planning/learning/:id/approve', asyncRoute(async (req, res) => {
  try {
    learningService.rollout(req.db, req.ctx, req.user, req.params.id,
      { expectedHash:trimOrNull(req.body.integrityHash) });
    req.flash('success', 'Applied and verified. Foundry will measure what happens next, and this can be rolled back.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
  }
  return res.redirect(303, '/planning#learning');
}));

router.post('/planning/learning/:id/decline', asyncRoute(async (req, res) => {
  try {
    learningService.decline(req.db, req.ctx, req.user, req.params.id, trimOrNull(req.body.reason));
    req.flash('success', 'Kept the current policy. Foundry recorded your decision.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
  }
  return res.redirect(303, '/planning#learning');
}));

router.post('/planning/learning/:id/rollback', asyncRoute(async (req, res) => {
  try {
    learningService.rollback(req.db, req.ctx, req.user, req.params.id);
    req.flash('success', 'Rolled back and verified against the previous policy value.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
  }
  return res.redirect(303, '/planning#learning');
}));

/*
 * "Use 84."
 *
 * No capability is required and that is deliberate: authority is about what
 * Foundry may do unattended, and this is the owner changing their own setting.
 * The permission checked is the ordinary one for editing replenishment.
 */
router.post('/planning/recommendations/:id/accept', asyncRoute(async (req, res) => {
  try {
    const outcome = applyService.accept(req.db, req.ctx, req.user, req.params.id);
    const named = { reorderPoint: 'reorder point', targetStock: 'stock target', safetyStock: 'safety stock' };
    req.flash('success', outcome.replayed
      ? 'That was already applied.'
      : `Done — ${named[outcome.field]} is now ${outcome.value}.`);
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
  }
  return res.redirect(303, backTo(req));
}));

/* "Keep 60." Recorded rather than dismissed, so Foundry stops re-raising it. */
router.post('/planning/recommendations/:id/decline', asyncRoute(async (req, res) => {
  try {
    applyService.decline(req.db, req.ctx, req.params.id, trimOrNull(req.body.reason));
    req.flash('success', 'Kept as it is. Foundry will leave that setting alone.');
  } catch (error) {
    if (!error.status || error.status >= 500) throw error;
    req.flash('error', error.message);
  }
  return res.redirect(303, backTo(req));
}));

/**
 * Telling Foundry what matters.
 *
 * A goal chooses between answers Foundry was already allowed to give. It cannot
 * widen authority, and the preference store refuses any key that is not one of
 * the handful that mean something.
 */
router.post('/planning/goals', asyncRoute(async (req, res) => {
  const wanted = [
    ['service_level', req.body.serviceLevel],
    ['max_days_of_supply', req.body.maxDaysOfSupply],
    ['inventory_cap_minor', req.body.inventoryCap],
    ['cash_reserve_minor', req.body.cashReserve],
    ['prioritise_core_products', req.body.prioritiseCoreProducts === 'on'],
    ['conservative_seasonal', req.body.conservativeSeasonal === 'on'],
  ];
  const problems = [];
  for (const [key, value] of wanted) {
    const empty = value === undefined || value === null || String(value).trim() === '';
    try {
      if (empty || value === false) preferences.clear(req.db, req.ctx, req.user, key);
      else preferences.set(req.db, req.ctx, req.user, { key, value, source: 'configuration' });
    } catch (error) {
      if (!error.status || error.status >= 500) throw error;
      problems.push(error.message);
    }
  }
  if (problems.length) req.flash('error', problems.join(' '));
  else req.flash('success', 'Foundry will plan around that.');
  return res.redirect(303, '/planning#goals');
}));

module.exports = router;
