'use strict';

/**
 * The daily brief.
 *
 * Composed from the attention items that actually exist. When there is nothing
 * to report the brief says so plainly and no model is called — a quiet day must
 * never be dressed up into content. When a model does write the opening, it is
 * checked against the same grounding rule as everything else: no figure may
 * appear that is not in the findings themselves.
 */

const crypto = require('node:crypto');

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const attention = require('./attention-engine');
const interpretation = require('./interpretation-service');
const prompts = require('./prompts');
const { newId, nowIso } = require('../lib/util');

const SEVERITY_LABEL = { critical: 'urgent', important: 'worth doing today', watch: 'worth knowing' };

/** A stable identity for "the brief for this exact set of findings". */
/**
 * What the brief is a summary *of*.
 *
 * A stored brief is only reused while this is unchanged. Since Mission 6 the
 * brief also reports purchasing, so purchasing state belongs in the signature —
 * otherwise a delivery arriving would leave yesterday's "one order is late"
 * sitting on the overview.
 */
function signatureOf(items, extra = '') {
  const basis = items
    .map((i) => `${i.attentionId}:${i.severity}:${i.priorityScore}:${i.lastEvaluatedAt}`)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(`${basis}#${extra}`).digest('hex').slice(0, 32);
}

/** The purchasing part of the signature: counts, not prose. */
function purchasingSignature(purchasing) {
  if (!purchasing || !purchasing.counts) return '';
  const { recommended = 0, late = 0, dueToday = 0 } = purchasing.counts;
  return `po:${recommended}:${late}:${dueToday}`;
}

/** The brief that is always available, with or without a provider. */
function deterministicBrief(items, context = {}) {
  const noun = context.stockNoun || 'stock';
  // Purchasing lines are always written here rather than by a model. They are
  // counts of real work — items to reorder, orders overdue, deliveries due —
  // and a summary of what to do today is not the place for embellishment.
  const purchasing = Array.isArray(context.purchasingLines) ? context.purchasingLines : [];

  if (items.length === 0) {
    const clear =
      `Nothing in your ${noun} needs attention right now. Foundry checked it against ` +
      'its movement history and found no shortages, imbalances, unusual corrections or idle inventory.';
    return purchasing.length ? `${clear} ${purchasing.join(' ')}` : clear;
  }

  const counts = attention.summarise(items);
  const parts = [];
  const headline = [
    counts.critical ? `${counts.critical} urgent` : null,
    counts.important ? `${counts.important} worth doing today` : null,
    counts.watch ? `${counts.watch} worth knowing about` : null,
  ].filter(Boolean);

  parts.push(
    `${items.length === 1 ? 'One thing needs' : `${items.length} things need`} your attention: ` +
      `${headline.join(', ')}.`
  );

  // Titles carry lot codes, serials and product names — never case-folded.
  const lead = items[0];
  parts.push(`Start with: ${lead.title} — ${lead.conciseSummary}.`);

  const rest = items.slice(1, 4);
  if (rest.length) {
    parts.push(`Then: ${rest.map((i) => `${i.title} (${SEVERITY_LABEL[i.severity]})`).join('; ')}.`);
  }
  if (items.length > 4) {
    parts.push(`${items.length - 4} more are listed below.`);
  }
  parts.push(...purchasing);

  return parts.join(' ');
}

/** Verifies a model-written opening against every finding it is describing. */
function openingIsGrounded(text, items) {
  const permitted = new Set();
  for (const item of items) {
    for (const value of interpretation.permittedNumbers(item)) permitted.add(value);
  }
  // The count of findings is a fact about the brief itself.
  permitted.add(String(items.length));
  for (const severity of ['critical', 'important', 'watch']) {
    permitted.add(String(items.filter((i) => i.severity === severity).length));
  }

  if (!interpretation.numbersAreGrounded(text, permitted)) return false;
  return !interpretation.FORBIDDEN.some((pattern) => pattern.test(text));
}

const OPENING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['opening'],
  properties: { opening: { type: 'string', maxLength: 600 } },
};

/**
 * Builds today's brief. Returns the deterministic text unless a model opening
 * passes verification, in which case the opening precedes the same detail.
 */
async function buildBrief(db, workspaceId, options = {}) {
  const items = options.items || attention.listAttention(db, workspaceId);
  const context = options.context || {};
  const extra = purchasingSignature(options.purchasing);
  const deterministic = deterministicBrief(items, context);

  // A healthy inventory is reported deterministically. No call, no embellishment.
  if (items.length === 0 || options.deterministicOnly || (!options.provider && !config.ai.configured)) {
    return persist(db, workspaceId, deterministic, 'deterministic', items, extra);
  }

  const provider = options.provider || createProviderForTier('fast');
  let response;
  try {
    response = await provider.complete({
      system: prompts.BRIEF_SYSTEM,
      prompt: prompts.briefPrompt(items, context),
      schema: OPENING_SCHEMA,
      schemaName: 'attention_brief_opening',
    });
  } catch {
    return persist(db, workspaceId, deterministic, 'deterministic', items, extra);
  }

  const opening = response.data && typeof response.data.opening === 'string' ? response.data.opening.trim() : '';
  if (!opening || !openingIsGrounded(opening, items)) {
    return persist(db, workspaceId, deterministic, 'deterministic', items, extra);
  }

  return persist(db, workspaceId, `${opening}\n\n${deterministic}`, 'model', items, extra);
}

function persist(db, workspaceId, body, source, items, extra = '') {
  const record = {
    briefId: newId('brf'),
    workspaceId: workspaceId,
    body,
    source,
    itemIds: items.map((i) => i.attentionId),
    signature: signatureOf(items, extra),
    createdAt: nowIso(),
  };
  db.prepare(
    `INSERT INTO attention_briefs (id, workspace_id, body, source, item_ids, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(record.briefId, workspaceId, body, source, JSON.stringify(record.itemIds), record.signature, record.createdAt);
  return record;
}

/** The most recent brief, if it still describes the current findings. */
function currentBrief(db, workspaceId, items, extra = '') {
  const row = db
    .prepare('SELECT * FROM attention_briefs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(workspaceId);
  if (!row) return null;
  if (row.signature !== signatureOf(items, extra)) return null;
  return {
    briefId: row.id,
    workspaceId: row.workspace_id,
    body: row.body,
    source: row.source,
    itemIds: JSON.parse(row.item_ids || '[]'),
    signature: row.signature,
    createdAt: row.created_at,
  };
}

module.exports = {
  buildBrief,
  currentBrief,
  deterministicBrief,
  openingIsGrounded,
  signatureOf,
  purchasingSignature,
  OPENING_SCHEMA,
};
