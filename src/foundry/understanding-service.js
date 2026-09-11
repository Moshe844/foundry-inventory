'use strict';

/**
 * Turns a business description into a validated InventoryUnderstanding.
 *
 * The model interprets; this module decides what is allowed through. After
 * schema validation the result is additionally normalised against what the
 * engine can actually do — a model that invents a tracking mode or promises an
 * unsupported feature has its answer corrected and the correction recorded,
 * never silently honoured.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const {
  UNDERSTANDING_SCHEMA,
  CORE_SCHEMA,
  ADVICE_SCHEMA,
  RECORDS_SCHEMA,
} = require('./understanding-schema');
const { validate } = require('./validator');
const { toWireSchema, clampToSchema, slugify } = require('./schema-tools');
const prompts = require('./prompts');
const { ValidationError } = require('../domain/errors');
const { TRACKING_MODE_IDS, LOCATION_KIND_IDS } = require('../domain/constants');
const { newId, nowIso, requireText } = require('../lib/util');
const dataMode = require('../synthetic/data-mode');
const realBusinessGrounding = require('./real-business-grounding');

const MIN_DESCRIPTION = 12;
const MAX_DESCRIPTION = 4000;

/** Always async: every failure is a rejection, never a synchronous throw. */
async function describeBusiness(db, ctx, description, options = {}) {
  // Lets a caller show which pass is actually running, rather than a spinner.
  const onStage = typeof options.onStage === 'function' ? options.onStage : () => {};
  const clean = requireText(description, 'Description', { max: MAX_DESCRIPTION });
  if (clean.length < MIN_DESCRIPTION) {
    throw new ValidationError(
      'Tell Foundry a little more about what you keep track of — a sentence or two is enough.'
    );
  }

  const provider = options.provider || createProviderForTier('deep');
  const executionContext = { workspaceMode: dataMode.workspaceMode(db, ctx.workspaceId) };

  // Two passes: read the operation, then advise on it. See understanding-schema
  // for why the wire schema is split; the contract validated below is whole.
  onStage('reading');
  const core = await provider.complete({
    system: prompts.understandingSystemPrompt(executionContext),
    prompt: prompts.understandingPrompt(clean),
    schema: CORE_SCHEMA,
    schemaName: 'inventory_understanding_core',
    signal: options.signal,
  });

  // Validated against the wire form: the model is judged on the contract it was
  // actually given, not on constraints that were stripped before it saw them.
  const coreResult = validate(toWireSchema(CORE_SCHEMA), core.data, { key: 'understanding-core-wire' });
  if (!coreResult.ok) {
    throw new ValidationError(
      'Foundry could not make sense of that description. Try describing your inventory again.',
      { errors: coreResult.errors.slice(0, 10) }
    );
  }

  /*
   * Records the owner typed into the description, read on their own.
   *
   * A separate call because the schema for them is an array of objects, and
   * asking for those alongside the structural contract produced a grammar the
   * provider refuses to compile — the whole understanding then failed, and the
   * owner was told "Foundry could not finish reading that."
   *
   * Defensive on purpose: somebody describing the shape of their business and
   * listing no products at all is the normal case, so a failure to extract
   * records must not lose the structural understanding that already succeeded.
   */
  onStage('records');
  let records = { hasRecords: false, lines: [], ambiguities: [] };
  try {
    const typed = await provider.complete({
      system: prompts.understandingSystemPrompt(executionContext),
      prompt: prompts.recordsPrompt(clean),
      schema: RECORDS_SCHEMA,
      schemaName: 'inventory_understanding_records',
      signal: options.signal,
    });
    const typedResult = validate(toWireSchema(RECORDS_SCHEMA), typed.data, { key: 'understanding-records-wire' });
    if (typedResult.ok && typedResult.data.ownerProvidedInventory) {
      records = typedResult.data.ownerProvidedInventory;
    }
  } catch {
    // No records read is not the same as no understanding. The structural pass
    // stands, and the owner is asked for quantities in the ordinary way.
  }

  onStage('advising');
  const advice = await provider.complete({
    system: prompts.understandingSystemPrompt(executionContext),
    prompt: prompts.advicePrompt(clean, coreResult.data),
    schema: ADVICE_SCHEMA,
    schemaName: 'inventory_understanding_advice',
    signal: options.signal,
  });

  const adviceResult = validate(toWireSchema(ADVICE_SCHEMA), advice.data, { key: 'understanding-advice-wire' });
  if (!adviceResult.ok) {
    throw new ValidationError(
      'Foundry could not put together reliable advice for that description. Try again.',
      { errors: adviceResult.errors.slice(0, 10) }
    );
  }

  // Repair what is safely repairable (identifier shapes, over-long lists), then
  // enforce Foundry's own stricter contract on the result.
  const merged = normalise(
    { ...coreResult.data, ownerProvidedInventory: records, ...adviceResult.data },
    clean,
    executionContext
  );
  const whole = validate(UNDERSTANDING_SCHEMA, merged, { key: 'understanding' });
  if (!whole.ok) {
    throw new ValidationError(
      'Foundry could not make sense of that description. Try describing your inventory again.',
      { errors: whole.errors.slice(0, 10) }
    );
  }

  const usage = {
    provider: core.usage.provider,
    model: core.usage.model,
    inputTokens: (core.usage.inputTokens || 0) + (advice.usage.inputTokens || 0),
    outputTokens: (core.usage.outputTokens || 0) + (advice.usage.outputTokens || 0),
    latencyMs: (core.usage.latencyMs || 0) + (advice.usage.latencyMs || 0),
  };

  const understanding = whole.data;
  const id = save(db, ctx, { understanding, usage, description: clean });
  return { id, understanding, usage };
}

/**
 * Clamp a validated understanding to what the engine supports. Schema
 * validation proves the shape; this proves the meaning.
 */
function normalise(raw, description, executionContext = {}) {
  const understanding = clampToSchema(JSON.parse(JSON.stringify(raw)), UNDERSTANDING_SCHEMA);
  understanding.businessDescription = description;

  const recommended = understanding.recommendedConfiguration;
  if (!TRACKING_MODE_IDS.includes(recommended.trackingMode)) {
    recommended.trackingMode = 'quantity';
    understanding.assumptions = [
      ...(understanding.assumptions || []),
      'Foundry defaulted to quantity tracking because the suggested tracking type was not one it supports.',
    ];
  }

  // The three flags and the chosen mode must tell the same story.
  if (recommended.trackingMode === 'serial') {
    understanding.serializedTracking.applies = true;
  }
  if (recommended.trackingMode === 'lot') {
    understanding.lotTracking.applies = true;
  }
  if (understanding.expirationTracking.applies && recommended.trackingMode !== 'lot') {
    // Expiration only exists on lots in this engine.
    understanding.expirationTracking.applies = false;
    understanding.expirationTracking.certainty = 'unsupported_today';
  }

  const archetypes = new Set([recommended.trackingMode]);
  if (recommended.usesVariants) archetypes.add('variant');
  understanding.inventoryArchetypes = [...archetypes];

  if (!recommended.usesVariants) understanding.variantDimensions = [];
  understanding.variantDimensions = (understanding.variantDimensions || []).slice(0, 3);

  understanding.likelyLocations = (understanding.likelyLocations || [])
    .filter((loc) => loc && loc.name && LOCATION_KIND_IDS.includes(loc.kind))
    .slice(0, 12);

  // Deduplicate location names case-insensitively; the engine requires unique names.
  const seenLocations = new Set();
  understanding.likelyLocations = understanding.likelyLocations.filter((loc) => {
    const key = loc.name.trim().toLowerCase();
    if (seenLocations.has(key)) return false;
    seenLocations.add(key);
    return true;
  });

  // Identifiers are internal plumbing. Normalise their shape rather than
  // discarding an otherwise good answer over an underscore.
  understanding.unresolvedDecisions = (understanding.unresolvedDecisions || [])
    .slice(0, 3)
    .map((decision, index) => {
      const options = (decision.options || []).slice(0, 4).map((option, optionIndex) => ({
        ...option,
        id: slugify(option.id, `option_${optionIndex + 1}`),
      }));
      const recommendedOptionId = slugify(decision.recommendedOptionId, '');
      return {
        ...decision,
        id: slugify(decision.id, `decision_${index + 1}`),
        options,
        recommendedOptionId: options.some((o) => o.id === recommendedOptionId)
          ? recommendedOptionId
          : (options[0] ? options[0].id : ''),
      };
    })
    .filter((decision) => decision.options.length >= 2);


  if (executionContext.workspaceMode === 'production') {
    realBusinessGrounding.ground(understanding, description);
  }

  return understanding;
}

function save(db, ctx, { understanding, usage, description }) {
  const id = newId('und');
  db.prepare(
    `INSERT INTO foundry_understandings (
       id, workspace_id, source_description, provider, model, payload, confidence,
       input_tokens, output_tokens, latency_ms, actor_user_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    ctx.workspaceId,
    description,
    usage.provider,
    usage.model,
    JSON.stringify(understanding),
    understanding.confidence,
    usage.inputTokens,
    usage.outputTokens,
    usage.latencyMs,
    ctx.actorId,
    nowIso()
  );

  const insertRecommendation = db.prepare(
    `INSERT INTO foundry_recommendations (
       id, workspace_id, understanding_id, title, noticed, recommendation,
       why_it_matters, scope, confidence, status, position, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'offered', ?, ?)`
  );
  understanding.recommendations.forEach((rec, index) => {
    insertRecommendation.run(
      newId('rec'),
      ctx.workspaceId,
      id,
      rec.title,
      rec.noticed,
      rec.recommendation,
      rec.whyItMatters,
      rec.scope,
      rec.confidence,
      index,
      nowIso()
    );
  });

  return id;
}

function getUnderstanding(db, workspaceId, id) {
  const row = db
    .prepare('SELECT * FROM foundry_understandings WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId);
  if (!row) return null;
  return { ...row, understanding: JSON.parse(row.payload) };
}

function latestUnderstanding(db, workspaceId) {
  const row = db
    .prepare('SELECT * FROM foundry_understandings WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceId);
  if (!row) return null;
  return { ...row, understanding: JSON.parse(row.payload) };
}

function listRecommendations(db, workspaceId, understandingId) {
  return db
    .prepare(
      `SELECT * FROM foundry_recommendations
        WHERE workspace_id = ? AND understanding_id = ?
        ORDER BY position`
    )
    .all(workspaceId, understandingId);
}

/**
 * The recommendations somebody ticked when they approved a configuration.
 *
 * Accepting one used to be a status column nothing ever read again, so the
 * customer ticked "yes, I want this" and never saw it mentioned anywhere. They
 * are listed back on the ready page instead, with what to actually do about it.
 */
function listAcceptedRecommendations(db, workspaceId, planId) {
  return db
    .prepare(
      `SELECT * FROM foundry_recommendations
        WHERE workspace_id = ? AND plan_id = ? AND status = 'accepted'
        ORDER BY position`
    )
    .all(workspaceId, planId);
}

module.exports = {
  describeBusiness,
  save,
  normalise,
  getUnderstanding,
  latestUnderstanding,
  listRecommendations,
  listAcceptedRecommendations,
  MIN_DESCRIPTION,
};
