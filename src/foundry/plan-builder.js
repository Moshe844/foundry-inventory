'use strict';

/**
 * Builds an InventoryConfigurationPlan from a validated understanding plus the
 * customer's decisions.
 *
 * The model does not author the plan. This module does, deterministically, from
 * a vocabulary the engine already implements — which is what stops a persuasive
 * model answer from becoming a configuration Foundry cannot honour.
 */

const { PLAN_SCHEMA, sealPlan } = require('./plan-schema');
const { clampToSchema } = require('./schema-tools');
const { validateOrThrow } = require('./validator');
const { NotFoundError, ValidationError } = require('../domain/errors');
const { TRACKING_MODE_IDS, LOCATION_KIND_IDS } = require('../domain/constants');
const { newId, nowIso, trimOrNull } = require('../lib/util');

const TERMINOLOGY_KEYS = ['item', 'location', 'serialUnit', 'lot', 'variant'];
const DEFAULT_TERMS = {
  item: 'Item',
  location: 'Location',
  serialUnit: 'Unit',
  lot: 'Lot',
  variant: 'Variant',
};

/**
 * @param {object} answers  { [questionId]: answerOptionId | '__foundry__' }
 */
function buildPlan(db, ctx, { understandingId, answers = {}, acceptedRecommendationIds = [] }) {
  const stored = db
    .prepare('SELECT * FROM foundry_understandings WHERE id = ? AND workspace_id = ?')
    .get(understandingId, ctx.workspaceId);
  if (!stored) throw new NotFoundError('That understanding could not be found.');

  const understanding = JSON.parse(stored.payload);
  const decisions = resolveDecisions(understanding, answers);

  const recommendations = db
    .prepare('SELECT * FROM foundry_recommendations WHERE workspace_id = ? AND understanding_id = ?')
    .all(ctx.workspaceId, understandingId);
  const acceptedIds = new Set(acceptedRecommendationIds);
  const accepted = recommendations.filter((rec) => acceptedIds.has(rec.id));

  const trackingMode = TRACKING_MODE_IDS.includes(understanding.recommendedConfiguration.trackingMode)
    ? understanding.recommendedConfiguration.trackingMode
    : 'quantity';
  const usesVariants = Boolean(understanding.recommendedConfiguration.usesVariants);

  const effects = new Set(decisions.all.map((decision) => decision.effect).filter(Boolean));
  const allowNegativeStock = effects.has('allow_negative_stock')
    ? true
    : effects.has('disallow_negative_stock')
      ? false
      : Boolean(understanding.recommendedConfiguration.allowNegativeStock);

  const expirationEnabled = trackingMode !== 'lot'
    ? false
    : effects.has('skip_expiration')
      ? false
      : effects.has('capture_expiration')
        ? true
        : Boolean(understanding.expirationTracking.applies);

  const locations = (understanding.likelyLocations || [])
    .filter((loc) => LOCATION_KIND_IDS.includes(loc.kind))
    .map((loc) => ({ name: loc.name.trim().slice(0, 120), kind: loc.kind }));

  const archetypes = [trackingMode];
  if (usesVariants) archetypes.push('variant');

  const version = nextVersion(db, ctx.workspaceId);

  // Clamp before sealing: the integrity hash must cover the final bytes.
  const plan = sealPlan(clampToSchema({
    workspaceId: ctx.workspaceId,
    sourceDescription: understanding.businessDescription,

    inventoryModel: {
      primaryArchetype: trackingMode,
      archetypes,
      usesVariants,
      summary: trimOrNull(understanding.recommendedConfiguration.summary) || summarise(trackingMode, usesVariants),
    },

    trackingModes: [trackingMode],

    variantDimensions: usesVariants
      ? (understanding.variantDimensions || []).slice(0, 3).map((dim) => ({
          name: String(dim.name).slice(0, 60),
          exampleValues: (dim.exampleValues || []).slice(0, 12).map((v) => String(v).slice(0, 60)),
        }))
      : [],

    serialRules: {
      enabled: trackingMode === 'serial',
      uniquePerItem: true,
      singleLocationPerUnit: true,
      trackCondition: trackingMode === 'serial',
    },

    lotRules: {
      enabled: trackingMode === 'lot',
      requireLotOnReceive: trackingMode === 'lot',
      trackPerLocation: trackingMode === 'lot',
    },

    expirationRules: {
      enabled: expirationEnabled,
      captureOnReceive: expirationEnabled,
    },

    locations,

    terminology: normaliseTerminology(understanding.terminology),

    operationalDefaults: {
      // Non-negotiable in Mission 1: an adjustment without a reason is not a
      // thing the engine can record, so this is never a customer choice.
      adjustmentsRequireReason: true,
      allowNegativeStock,
      transfersEnabled: true,
    },

    acceptedRecommendations: accepted.map((rec) => ({ title: rec.title, scope: rec.scope })),
    customerDecisions: decisions.customer.map(toPlanDecision),
    foundryDecisions: decisions.foundry.map((decision) => ({
      ...toPlanDecision(decision),
      because: decision.because,
    })),

    assumptions: (understanding.assumptions || []).slice(0, 24).map((a) => String(a).slice(0, 300)),
    configurationVersion: version,
    integrityHash: '',
  }, PLAN_SCHEMA));

  validateOrThrow(PLAN_SCHEMA, plan, { key: 'plan', label: 'a configuration plan' });

  const planId = newId('plan');
  db.prepare(
    `INSERT INTO foundry_plans (
       id, workspace_id, understanding_id, kind, status, configuration_version,
       payload, integrity_hash, actor_user_id, created_at
     ) VALUES (?, ?, ?, 'initial', 'proposed', ?, ?, ?, ?, ?)`
  ).run(
    planId,
    ctx.workspaceId,
    understandingId,
    version,
    JSON.stringify(plan),
    plan.integrityHash,
    ctx.actorId,
    nowIso()
  );

  const insertDecision = db.prepare(
    `INSERT INTO foundry_decisions (
       id, workspace_id, plan_id, question_id, question, answer_id, answer_label, decided_by, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const decision of decisions.all) {
    insertDecision.run(
      newId('dec'),
      ctx.workspaceId,
      planId,
      decision.questionId,
      decision.question,
      decision.answerId,
      decision.answerLabel,
      decision.decidedBy,
      nowIso()
    );
  }

  if (accepted.length) {
    const markAccepted = db.prepare(
      "UPDATE foundry_recommendations SET status = 'accepted', plan_id = ? WHERE id = ? AND workspace_id = ?"
    );
    for (const rec of accepted) markAccepted.run(planId, rec.id, ctx.workspaceId);
  }

  return { planId, plan };
}

/**
 * Unanswered questions are not a blocker: the customer may always delegate, and
 * Foundry's own recommendation is used with the delegation recorded.
 */
function resolveDecisions(understanding, answers) {
  const customer = [];
  const foundry = [];

  for (const question of understanding.unresolvedDecisions || []) {
    const chosenId = answers[question.id];
    const recommended = question.options.find((opt) => opt.id === question.recommendedOptionId)
      || question.options[0];
    const chosen = question.options.find((opt) => opt.id === chosenId);

    if (chosen) {
      customer.push({
        questionId: question.id,
        question: question.question,
        answerId: chosen.id,
        answerLabel: chosen.label,
        effect: chosen.effect,
        decidedBy: 'customer',
      });
    } else {
      foundry.push({
        questionId: question.id,
        question: question.question,
        answerId: recommended.id,
        answerLabel: recommended.label,
        effect: recommended.effect,
        decidedBy: 'foundry',
        because: `Foundry chose this because ${question.whyItMatters}`.slice(0, 400),
      });
    }
  }

  return { customer, foundry, all: [...customer, ...foundry] };
}

function toPlanDecision(decision) {
  return {
    questionId: decision.questionId,
    question: decision.question,
    answerId: decision.answerId,
    answerLabel: decision.answerLabel,
  };
}

function normaliseTerminology(terminology) {
  const result = {};
  for (const key of TERMINOLOGY_KEYS) {
    const value = trimOrNull(terminology && terminology[key]);
    // A term identical to Foundry's own default is not a rename.
    result[key] = value && value.toLowerCase() !== DEFAULT_TERMS[key].toLowerCase()
      ? value.slice(0, 40)
      : null;
  }
  return result;
}

function summarise(trackingMode, usesVariants) {
  const base = {
    quantity: 'Stock is counted as quantities per location.',
    serial: 'Every unit is tracked individually by serial number.',
    lot: 'Stock is tracked in identifiable lots or batches.',
  }[trackingMode];
  return usesVariants ? `${base} Each option combination is counted separately.` : base;
}

function nextVersion(db, workspaceId) {
  const row = db
    .prepare('SELECT COALESCE(MAX(configuration_version), 0) AS version FROM foundry_plans WHERE workspace_id = ?')
    .get(workspaceId);
  return row.version + 1;
}

function getPlan(db, workspaceId, planId) {
  const row = db.prepare('SELECT * FROM foundry_plans WHERE id = ? AND workspace_id = ?').get(planId, workspaceId);
  if (!row) return null;
  return { ...row, plan: JSON.parse(row.payload) };
}

function latestPlan(db, workspaceId) {
  const row = db
    .prepare('SELECT * FROM foundry_plans WHERE workspace_id = ? ORDER BY configuration_version DESC LIMIT 1')
    .get(workspaceId);
  if (!row) return null;
  return { ...row, plan: JSON.parse(row.payload) };
}

function listDecisions(db, workspaceId, planId) {
  return db
    .prepare('SELECT * FROM foundry_decisions WHERE workspace_id = ? AND plan_id = ? ORDER BY created_at')
    .all(workspaceId, planId);
}

module.exports = {
  buildPlan,
  resolveDecisions,
  getPlan,
  latestPlan,
  listDecisions,
  normaliseTerminology,
  DEFAULT_TERMS,
  TERMINOLOGY_KEYS,
  ValidationError,
};
