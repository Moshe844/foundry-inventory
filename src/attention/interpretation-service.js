'use strict';

/**
 * The interpretation layer.
 *
 * The model never decides what needs attention — the detectors did that from
 * the ledger. It is handed finished findings and asked to phrase them well, and
 * every sentence it returns is checked before it is stored:
 *
 *   - every number in the wording must already appear in that finding's own
 *     evidence, so a figure can never be invented, rounded or re-scaled;
 *   - it may not claim an action was taken, or attribute a cause;
 *   - it may nudge the order, but never past a more severe finding.
 *
 * Anything that fails verification is discarded and the deterministic wording
 * stands. A failed model call is therefore a cosmetic loss, not an outage — the
 * briefing is fully usable with no model at all.
 */

const { createProviderForTier } = require('../ai/provider');
const config = require('../config');
const { validate } = require('../foundry/validator');
const { toWireSchema, clampToSchema } = require('../foundry/schema-tools');
const { SEVERITY_WEIGHT } = require('./policy');
const prompts = require('./prompts');
const { nowIso } = require('../lib/util');

const MAX_ITEMS = 12;

const NARRATIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: MAX_ITEMS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'summary', 'recommendation', 'rank'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string', maxLength: 120 },
          summary: { type: 'string', maxLength: 200 },
          recommendation: { type: 'string', maxLength: 300 },
          // Where the writer would put this finding, 1 = first.
          rank: { type: 'integer' },
        },
      },
    },
  },
};

/** Words that would turn a description into a claim Foundry cannot make. */
const FORBIDDEN = [
  /\b(?:i|we|foundry)\s+(?:have\s+)?(?:transferred|moved|adjusted|ordered|reordered|issued|received|written off|corrected)\b/i,
  /\b(?:fraud|theft|stole|stolen|stealing|dishonest|deliberately|negligent|incompeten)/i,
  /\bautomatically\s+(?:ordered|transferred|adjusted|resolved)\b/i,
];

/** Every number a finding is allowed to mention. */
function permittedNumbers(item) {
  const source = [
    item.deterministicTitle,
    item.deterministicSummary,
    item.deterministicRecommendation,
    item.explanation,
    ...item.evidence.map((e) => `${e.label} ${e.value}`),
    ...Object.values(item.metrics || {}).map((v) => String(v)),
  ].join(' ');
  return new Set(numbersIn(source));
}

function numbersIn(text) {
  return (String(text).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(/,/g, ''));
}

/**
 * A number is acceptable if it appears in the evidence, or is the same value
 * written with different precision (12 for 12.0). Anything else is invented.
 */
function numbersAreGrounded(text, permitted) {
  for (const raw of numbersIn(text)) {
    if (permitted.has(raw)) continue;
    const asNumber = Number(raw);
    const matches = [...permitted].some((p) => Number(p) === asNumber);
    if (!matches) return false;
  }
  return true;
}

function verifyNarrative(narrative, item) {
  const problems = [];
  const permitted = permittedNumbers(item);

  for (const [field, text] of Object.entries({
    title: narrative.title,
    summary: narrative.summary,
    recommendation: narrative.recommendation,
  })) {
    if (!text || !String(text).trim()) {
      problems.push(`${field} is empty`);
      continue;
    }
    if (!numbersAreGrounded(text, permitted)) {
      problems.push(`${field} states a figure that is not in the evidence`);
    }
    for (const pattern of FORBIDDEN) {
      if (pattern.test(text)) {
        problems.push(`${field} makes a claim Foundry cannot support`);
        break;
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Applies the model's ordering preference without letting it hide anything.
 * A finding can move within its severity band; it can never overtake a more
 * severe one.
 */
function applyRankHints(items, ranks) {
  const hinted = items.map((item, index) => ({
    item,
    index,
    rank: Number.isInteger(ranks.get(item.attentionId)) ? ranks.get(item.attentionId) : index + 1,
  }));

  hinted.sort((a, b) => {
    const severity = (SEVERITY_WEIGHT[b.item.severity] || 0) - (SEVERITY_WEIGHT[a.item.severity] || 0);
    if (severity !== 0) return severity;
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.index - b.index;
  });

  return hinted.map((h) => h.item);
}

function storeNarrative(db, workspaceId, attentionId, narrative) {
  db.prepare(
    `UPDATE attention_items
        SET narrative_title = ?, narrative_summary = ?, narrative_recommendation = ?,
            narrative_source = 'model'
      WHERE id = ? AND workspace_id = ?`
  ).run(narrative.title, narrative.summary, narrative.recommendation, attentionId, workspaceId);
}

function clearNarrative(db, workspaceId, attentionId) {
  db.prepare(
    `UPDATE attention_items
        SET narrative_title = NULL, narrative_summary = NULL,
            narrative_recommendation = NULL, narrative_source = NULL
      WHERE id = ? AND workspace_id = ?`
  ).run(attentionId, workspaceId);
}

/**
 * Rewords a set of already-detected findings.
 *
 * @returns {{ applied: number, rejected: Array, order: string[], reason?: string }}
 */
async function interpret(db, workspaceId, items, options = {}) {
  const subject = items.slice(0, MAX_ITEMS);
  if (subject.length === 0) return { applied: 0, rejected: [], order: [] };
  if (!options.provider && !config.ai.configured) {
    return { applied: 0, rejected: [], order: subject.map((i) => i.attentionId), reason: 'ai_not_configured' };
  }

  const provider = options.provider || createProviderForTier('fast');
  const context = options.context || {};

  let response;
  try {
    response = await provider.complete({
      system: prompts.INTERPRETATION_SYSTEM,
      prompt: prompts.interpretationPrompt(subject, context),
      schema: NARRATIVE_SCHEMA,
      schemaName: 'attention_narrative',
    });
  } catch (error) {
    // The briefing is already complete and correct without this.
    return {
      applied: 0,
      rejected: [],
      order: subject.map((i) => i.attentionId),
      reason: `provider_unavailable: ${error.message}`,
    };
  }

  const result = validate(toWireSchema(NARRATIVE_SCHEMA), response.data, { key: 'attention-narrative-wire' });
  if (!result.ok) {
    return { applied: 0, rejected: [], order: subject.map((i) => i.attentionId), reason: 'invalid_output' };
  }

  const clamped = clampToSchema(result.data, NARRATIVE_SCHEMA);
  const byId = new Map(subject.map((item) => [item.attentionId, item]));
  const ranks = new Map();
  const rejected = [];
  let applied = 0;

  for (const narrative of clamped.items || []) {
    const item = byId.get(narrative.id);
    if (!item) {
      // An id Foundry did not supply — the model does not get to add findings.
      rejected.push({ id: narrative.id, problems: ['unknown finding id'] });
      continue;
    }
    const verdict = verifyNarrative(narrative, item);
    if (!verdict.ok) {
      rejected.push({ id: narrative.id, problems: verdict.problems });
      clearNarrative(db, workspaceId, item.attentionId);
      continue;
    }
    storeNarrative(db, workspaceId, item.attentionId, narrative);
    ranks.set(item.attentionId, narrative.rank);
    applied += 1;
  }

  const order = applyRankHints(subject, ranks).map((i) => i.attentionId);
  return { applied, rejected, order, interpretedAt: nowIso() };
}

module.exports = {
  NARRATIVE_SCHEMA,
  MAX_ITEMS,
  interpret,
  verifyNarrative,
  permittedNumbers,
  numbersAreGrounded,
  applyRankHints,
  FORBIDDEN,
};
