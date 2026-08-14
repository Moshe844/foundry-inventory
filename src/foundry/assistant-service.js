'use strict';

/**
 * Foundry after onboarding: explaining the configuration, and proposing safe
 * changes to it.
 *
 * Two rules hold everywhere in this file. Answers are grounded in the
 * workspace's real configuration, read fresh from the database — never in
 * what a typical setup looks like. And a change is only ever *proposed*: the
 * model classifies the request, Foundry decides whether the engine can honour
 * it, and the customer confirms before anything is applied.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const repo = require('../domain/repository');
const inventoryQuery = require('../domain/inventory-query');
const planApplier = require('./plan-applier');
const planBuilder = require('./plan-builder');
const { sealPlan, PLAN_SCHEMA, verifyPlanIntegrity } = require('./plan-schema');
const { validate, validateOrThrow } = require('./validator');
const { clampToSchema, toWireSchema } = require('./schema-tools');
const prompts = require('./prompts');
const { LOCATION_KIND_IDS } = require('../domain/constants');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const { newId, nowIso, requireText, trimOrNull } = require('../lib/util');

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'grounding', 'supportedToday', 'wantsChange'],
  properties: {
    answer: { type: 'string', minLength: 1, maxLength: 1500 },
    grounding: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 200 } },
    supportedToday: { type: 'boolean' },
    wantsChange: { type: 'boolean' },
  },
};

const CHANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'summary',
    'whatWillChange',
    'existingInventoryAffected',
    'migrationRequired',
    'reversible',
    'recommendation',
    'locations',
    'terminology',
    'allowNegativeStock',
    'whyNotSupported',
  ],
  properties: {
    kind: {
      type: 'string',
      enum: ['add_locations', 'terminology', 'operational_defaults', 'not_supported'],
    },
    summary: { type: 'string', minLength: 1, maxLength: 600 },
    whatWillChange: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 300 } },
    existingInventoryAffected: { type: 'string', maxLength: 400 },
    migrationRequired: { type: 'boolean' },
    reversible: { type: 'boolean' },
    recommendation: { type: 'string', maxLength: 600 },
    locations: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'kind'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          kind: { type: 'string', enum: LOCATION_KIND_IDS },
        },
      },
    },
    terminology: {
      type: 'object',
      additionalProperties: false,
      required: ['item', 'location', 'serialUnit', 'lot', 'variant'],
      properties: {
        item: { type: ['string', 'null'], maxLength: 40 },
        location: { type: ['string', 'null'], maxLength: 40 },
        serialUnit: { type: ['string', 'null'], maxLength: 40 },
        lot: { type: ['string', 'null'], maxLength: 40 },
        variant: { type: ['string', 'null'], maxLength: 40 },
      },
    },
    allowNegativeStock: { type: ['boolean', 'null'] },
    whyNotSupported: { type: ['string', 'null'], maxLength: 600 },
  },
};

/** A read-only snapshot of what is really configured, for grounding answers. */
function configurationSnapshot(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const locations = repo.listLocations(db, workspaceId, { includeInactive: true });
  const items = inventoryQuery.listItems(db, workspaceId, { limit: 50, includeArchived: true }).items;

  return {
    configured: Boolean(configuration && configuration.configuredAt),
    configurationVersion: configuration ? configuration.configurationVersion : 0,
    inventoryModel: configuration ? configuration.inventoryModel : {},
    terminology: configuration ? configuration.terminology : {},
    operationalDefaults: configuration ? configuration.operationalDefaults : {},
    locations: locations.map((loc) => ({ name: loc.name, kind: loc.kind, active: Boolean(loc.is_active) })),
    items: items.map((item) => ({
      name: item.name,
      code: item.base_code,
      trackingMode: item.tracking_mode,
      hasVariants: Boolean(item.has_variants),
      onHand: item.on_hand,
    })),
    engineCapabilities: {
      trackingModes: ['quantity', 'serial', 'lot'],
      variantsCombineWithAnyMode: true,
      operations: ['receive', 'issue', 'transfer', 'adjust'],
      adjustmentsRequireReason: true,
    },
  };
}

async function ask(db, ctx, question, options = {}) {
  const clean = requireText(question, 'Question', { max: 1000 });
  const provider = options.provider || createProviderForTier('standard');
  const snapshot = configurationSnapshot(db, ctx.workspaceId);

  recordMessage(db, ctx, { role: 'user', body: clean });

  const { data } = await provider.complete({
    system: prompts.explainSystemPrompt(),
    prompt: prompts.explainPrompt(clean, snapshot),
    schema: ANSWER_SCHEMA,
    schemaName: 'foundry_answer',
  });

  // Validated against the wire form — size limits are stripped before the model
  // sees them, so enforcing them here would reject a perfectly good answer.
  const result = validate(toWireSchema(ANSWER_SCHEMA), data, { key: 'answer-wire' });
  if (!result.ok) {
    throw new ValidationError('Foundry could not put together a reliable answer. Try asking again.', {
      errors: result.errors.slice(0, 10),
    });
  }

  const answer = clampToSchema(result.data, ANSWER_SCHEMA);
  recordMessage(db, ctx, {
    role: 'foundry',
    body: answer.answer,
    grounding: answer.grounding,
    actionKind: answer.supportedToday ? 'explain' : 'unsupported',
  });

  return answer;
}

/**
 * Classifies a change request and turns the supported kinds into a proposed
 * plan. Nothing is applied here.
 */
async function proposeChange(db, ctx, request, options = {}) {
  const clean = requireText(request, 'Request', { max: 1000 });
  const provider = options.provider || createProviderForTier('standard');
  const snapshot = configurationSnapshot(db, ctx.workspaceId);

  const current = planApplier.getConfiguration(db, ctx.workspaceId);
  if (!current || !current.configuredAt) {
    throw new InvariantError('Foundry has not configured this workspace yet.', 'not_configured');
  }

  const { data } = await provider.complete({
    system: prompts.changeSystemPrompt(),
    prompt: prompts.changePrompt(clean, snapshot),
    schema: CHANGE_SCHEMA,
    schemaName: 'configuration_change',
  });

  const result = validate(toWireSchema(CHANGE_SCHEMA), data, { key: 'change-wire' });
  if (!result.ok) {
    throw new ValidationError('Foundry could not work out what that change would involve.', {
      errors: result.errors.slice(0, 10),
    });
  }
  const change = clampToSchema(result.data, CHANGE_SCHEMA);

  recordMessage(db, ctx, { role: 'user', body: clean });

  if (change.kind === 'not_supported') {
    recordMessage(db, ctx, {
      role: 'foundry',
      body: change.summary,
      actionKind: 'unsupported',
    });
    return { supported: false, change, planId: null };
  }

  const basePlanRow = db
    .prepare('SELECT * FROM foundry_plans WHERE id = ? AND workspace_id = ?')
    .get(current.appliedPlanId, ctx.workspaceId);
  if (!basePlanRow) throw new NotFoundError('The current configuration plan could not be found.');
  const basePlan = JSON.parse(basePlanRow.payload);

  const next = buildChangedPlan(db, ctx, basePlan, change);
  validateOrThrow(PLAN_SCHEMA, next, { key: 'plan', label: 'a configuration change' });

  const planId = newId('plan');
  db.prepare(
    `INSERT INTO foundry_plans (
       id, workspace_id, understanding_id, kind, status, configuration_version,
       payload, integrity_hash, actor_user_id, created_at
     ) VALUES (?, ?, ?, 'change', 'proposed', ?, ?, ?, ?, ?)`
  ).run(
    planId,
    ctx.workspaceId,
    basePlanRow.understanding_id,
    next.configurationVersion,
    JSON.stringify(next),
    next.integrityHash,
    ctx.actorId,
    nowIso()
  );

  recordMessage(db, ctx, {
    role: 'foundry',
    body: change.summary,
    actionKind: 'change_proposed',
    planId,
  });

  return { supported: true, change, planId, plan: next, impact: assessImpact(db, ctx, change) };
}

function buildChangedPlan(db, ctx, basePlan, change) {
  const version = db
    .prepare('SELECT COALESCE(MAX(configuration_version), 0) AS v FROM foundry_plans WHERE workspace_id = ?')
    .get(ctx.workspaceId).v + 1;

  const next = JSON.parse(JSON.stringify(basePlan));
  next.configurationVersion = version;

  if (change.kind === 'add_locations') {
    const existing = new Set(next.locations.map((loc) => loc.name.toLowerCase()));
    for (const loc of change.locations) {
      if (existing.has(loc.name.trim().toLowerCase())) continue;
      next.locations.push({ name: loc.name.trim().slice(0, 120), kind: loc.kind });
      existing.add(loc.name.trim().toLowerCase());
    }
    next.locations = next.locations.slice(0, 12);
  }

  if (change.kind === 'terminology') {
    next.terminology = planBuilder.normaliseTerminology(change.terminology);
  }

  if (change.kind === 'operational_defaults') {
    next.operationalDefaults = {
      ...next.operationalDefaults,
      // Reasons on adjustments are not negotiable, whatever was asked for.
      adjustmentsRequireReason: true,
      allowNegativeStock:
        typeof change.allowNegativeStock === 'boolean'
          ? change.allowNegativeStock
          : next.operationalDefaults.allowNegativeStock,
    };
  }

  return sealPlan(clampToSchema({ ...next, integrityHash: '' }, PLAN_SCHEMA));
}

/** What the change would touch, computed from real data rather than claimed. */
function assessImpact(db, ctx, change) {
  const totals = db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS units FROM balances WHERE workspace_id = ?')
    .get(ctx.workspaceId);
  const itemCount = db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1')
    .get(ctx.workspaceId).n;

  const touchesStock = false; // none of the supported change kinds move stock
  return {
    unitsOnHand: totals.units,
    itemCount,
    touchesExistingStock: touchesStock,
    migrationRequired: false,
    reversible: change.kind !== 'add_locations' ? true : true,
    note:
      change.kind === 'add_locations'
        ? 'New locations start empty. Existing stock stays exactly where it is.'
        : 'This changes configuration only. No inventory record is touched.',
  };
}

function applyChange(db, ctx, planId) {
  const row = db.prepare('SELECT * FROM foundry_plans WHERE id = ? AND workspace_id = ?').get(planId, ctx.workspaceId);
  if (!row) throw new NotFoundError('That change could not be found.');
  const plan = JSON.parse(row.payload);
  if (!verifyPlanIntegrity(plan)) {
    throw new InvariantError('That change has been altered since it was proposed.', 'plan_integrity_failed');
  }
  return planApplier.applyPlan(db, ctx, planId);
}

function recordMessage(db, ctx, { role, body, grounding, actionKind, planId }) {
  db.prepare(
    `INSERT INTO foundry_messages (id, workspace_id, role, body, grounding, action_kind, plan_id, actor_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    newId('msg'),
    ctx.workspaceId,
    role,
    body,
    grounding ? JSON.stringify(grounding) : null,
    actionKind || null,
    planId || null,
    ctx.actorId,
    nowIso()
  );
}

function listMessages(db, workspaceId, limit = 40) {
  return db
    .prepare('SELECT * FROM foundry_messages WHERE workspace_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(workspaceId, limit)
    .reverse()
    .map((row) => ({ ...row, grounding: row.grounding ? JSON.parse(row.grounding) : [] }));
}

module.exports = {
  ask,
  proposeChange,
  applyChange,
  configurationSnapshot,
  listMessages,
  ANSWER_SCHEMA,
  CHANGE_SCHEMA,
};
