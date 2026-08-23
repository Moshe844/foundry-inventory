'use strict';

/**
 * The Attention Engine.
 *
 * Runs the deterministic detectors, groups signals that describe one situation,
 * scores them into a priority order, and reconciles the result with what is
 * already on record — so a condition keeps its identity, its acknowledgement
 * and its first-seen date across evaluations, and disappears only by being
 * RESOLVED with a reason rather than deleted.
 *
 * Nothing here consults a model, and nothing here writes to the inventory
 * engine. It reads Mission 1 truth and writes only its own interpretation.
 */

const { inTransaction } = require('../db');
const signalEngine = require('../signals/signal-engine');
const purchasingSignals = require('../purchasing/purchasing-signals');
const engine = require('../domain/inventory-engine');
const planApplier = require('../foundry/plan-applier');
const { DETECTORS } = require('./detectors');
const {
  DETECTION_RULE_VERSION,
  GROUPABLE,
  GROUP_PRECEDENCE,
  SEVERITY_WEIGHT,
  CONFIDENCE_WEIGHT,
  relevantCategories,
} = require('./policy');
const replenishmentPlan = require('../purchasing/replenishment-plan');
const { newId, nowIso } = require('../lib/util');

/** Gathers every deterministic fact the detectors need. */
function collectSignals(db, workspaceId, { skuIds = null, now = Date.now(), includeIntegrity = true } = {}) {
  return {
    skus: signalEngine.skuSignals(db, workspaceId, { skuIds, now }),
    adjustments: signalEngine.adjustmentSignals(db, workspaceId, { skuIds, now }),
    lots: signalEngine.lotSignals(db, workspaceId, { skuIds, now }),
    serialUnits: signalEngine.serialSignals(db, workspaceId, { skuIds, now }),
    workspace: signalEngine.workspaceSignals(db, workspaceId, { now }),
    // What is on its way, which orders are overdue, and how prices have moved.
    // Wrapped because a workspace that has never bought anything must not have
    // its whole attention sweep fail on a purchasing query.
    purchasing: safePurchasingSignals(db, workspaceId, { skuIds, now }),
    integrity: includeIntegrity ? engine.verifyIntegrity(db, workspaceId) : null,
  };
}

/**
 * Replenishment plans, or none at all.
 *
 * Wrapped for the same reason the purchasing signals are: a workspace with no
 * suppliers, no policies or no purchasing tables must not have its whole
 * attention sweep fail because the planner had nothing to read.
 */
function safeReplenishmentPlans(db, workspaceId, signals, options) {
  try {
    return replenishmentPlan.planWorkspace(db, workspaceId, signals, options);
  } catch {
    return { plans: [], governed: [], governedSkuIds: new Set(), actionable: [] };
  }
}

function safePurchasingSignals(db, workspaceId, options) {
  try {
    return purchasingSignals.collect(db, workspaceId, options);
  } catch {
    return { incoming: new Map(), lateOrders: [], priceChanges: [], arrivingSoon: [] };
  }
}

function workspaceContext(db, workspaceId) {
  const configuration = planApplier.getConfiguration(db, workspaceId);
  const locationCount = db
    .prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const trackingModes = db
    .prepare('SELECT DISTINCT tracking_mode AS mode FROM items WHERE workspace_id = ? AND is_active = 1')
    .all(workspaceId)
    .map((row) => row.mode);
  const hasPurchasing =
    db.prepare('SELECT 1 FROM suppliers WHERE workspace_id = ? LIMIT 1').get(workspaceId) !== undefined;
  return { configuration, locationCount, trackingModes, hasPurchasing };
}

/**
 * Several categories can describe one SKU's situation at once. Telling that as
 * three alarms is worse than telling it once: the lead signal keeps the story
 * and the others are folded in as related context.
 */
function group(candidates) {
  const bySku = new Map();
  const standalone = [];

  for (const item of candidates) {
    if (!GROUPABLE.includes(item.category) || !item.skuId) {
      standalone.push(item);
      continue;
    }
    if (!bySku.has(item.skuId)) bySku.set(item.skuId, []);
    bySku.get(item.skuId).push(item);
  }

  const grouped = [];
  for (const [, group_] of bySku) {
    if (group_.length === 1) {
      grouped.push(group_[0]);
      continue;
    }
    const lead = [...group_].sort(
      (a, b) => GROUP_PRECEDENCE.indexOf(a.category) - GROUP_PRECEDENCE.indexOf(b.category)
    )[0];
    const others = group_.filter((c) => c !== lead);

    grouped.push({
      ...lead,
      relatedCategories: others.map((o) => o.category),
      // The folded-in signals keep their evidence; nothing is discarded.
      evidence: [...lead.evidence, ...others.flatMap((o) => o.evidence)],
      metrics: others.reduce((acc, o) => ({ ...acc, ...o.metrics }), { ...lead.metrics }),
      affectedLocationIds: [
        ...new Set([...lead.affectedLocationIds, ...others.flatMap((o) => o.affectedLocationIds)]),
      ],
      explanation:
        lead.explanation +
        others.map((o) => ` ${o.explanation}`).join(''),
      recommendation: lead.recommendation,
    });
  }

  return [...grouped, ...standalone];
}

/**
 * An explainable priority score. Severity dominates, then time sensitivity and
 * exposure, scaled by how much the evidence is trusted.
 */
function score(candidate) {
  let value = SEVERITY_WEIGHT[candidate.severity] || 0;
  const m = candidate.metrics || {};

  // Sooner is more urgent.
  if (typeof m.daysOfStockRemaining === 'number') {
    value += Math.max(0, 30 - m.daysOfStockRemaining);
  }
  if (typeof m.daysToExpiry === 'number') {
    value += Math.max(0, 45 - m.daysToExpiry) * 0.8;
  }

  // Bigger exposure matters more, with diminishing returns.
  const exposure = m.quantity || m.onHand || m.magnitude || 0;
  value += Math.min(20, Math.log10(Math.max(exposure, 1)) * 10);

  // A grouped item is explaining more of the picture at once.
  value += (candidate.relatedCategories || []).length * 5;

  return Math.round(value * (CONFIDENCE_WEIGHT[candidate.confidence] || 1) * 100) / 100;
}

/**
 * Runs detection and reconciles with what is stored.
 *
 * @param {object} options
 *   scope.skuIds  — narrow evaluation to these SKUs (after a movement)
 *   trigger       — what caused this run, for the audit trail
 */
function evaluate(db, workspaceId, options = {}) {
  const startedAt = Date.now();
  const now = options.now || Date.now();
  const skuIds = (options.scope && options.scope.skuIds) || null;
  const trigger = options.trigger || 'manual';

  const context = workspaceContext(db, workspaceId);
  const relevant = relevantCategories(context);
  const signals = collectSignals(db, workspaceId, { skuIds, now, includeIntegrity: !skuIds });
  const replenishment = safeReplenishmentPlans(db, workspaceId, signals, { now });

  let candidates = [];
  for (const [category, detector] of Object.entries(DETECTORS)) {
    if (!relevant.has(category)) continue; // never raise what this business cannot have
    // Detectors that reason about replenishment need the records behind the
    // signals — policies, suppliers, open orders — not just the measurements.
    candidates.push(...detector(signals, {
      integrity: signals.integrity,
      // Worked out once and shared, so the planner and the older heuristics
      // cannot reach different conclusions about the same product.
      replenishment,
      db, workspaceId, now,
    }));
  }

  candidates = group(candidates).map((c) => ({ ...c, priorityScore: score(c) }));

  return inTransaction(db, () => {
    const seen = new Set();
    let opened = 0;
    let updated = 0;

    for (const candidate of candidates) {
      seen.add(candidate.fingerprint);
      const existing = db
        .prepare('SELECT * FROM attention_items WHERE workspace_id = ? AND fingerprint = ?')
        .get(workspaceId, candidate.fingerprint);

      if (!existing) {
        insert(db, workspaceId, candidate, now);
        opened += 1;
        continue;
      }

      // A dismissal holds until it expires; a resolved condition that returns
      // is genuinely new information and reopens.
      let status = existing.status;
      if (status === 'DISMISSED') {
        const until = existing.dismissed_until;
        if (until && new Date(until).getTime() <= now) status = 'OPEN';
      } else if (status === 'RESOLVED') {
        status = 'OPEN';
      }

      db.prepare(
        `UPDATE attention_items SET
           severity = @severity, priority_score = @priorityScore, title = @title,
           concise_summary = @conciseSummary, explanation = @explanation,
           recommendation = @recommendation, evidence = @evidence, metrics = @metrics,
           evidence_references = @evidenceReferences, affected_location_ids = @affectedLocationIds,
           related_categories = @relatedCategories, confidence = @confidence,
           status = @status, resolution_reason = NULL, resolved_at = NULL,
           detection_rule_version = @detectionRuleVersion, last_evaluated_at = @now,
           item_id = @itemId, sku_id = @skuId
         WHERE id = @id`
      ).run({
        id: existing.id,
        itemId: candidate.itemId || null,
        skuId: candidate.skuId || null,
        severity: candidate.severity,
        priorityScore: candidate.priorityScore,
        title: candidate.title,
        conciseSummary: candidate.conciseSummary,
        explanation: candidate.explanation,
        recommendation: candidate.recommendation,
        evidence: JSON.stringify(candidate.evidence || []),
        metrics: JSON.stringify(candidate.metrics || {}),
        evidenceReferences: JSON.stringify(candidate.evidenceReferences || []),
        affectedLocationIds: JSON.stringify(candidate.affectedLocationIds || []),
        relatedCategories: JSON.stringify(candidate.relatedCategories || []),
        confidence: candidate.confidence,
        status,
        detectionRuleVersion: candidate.detectionRuleVersion,
        now: new Date(now).toISOString(),
      });
      updated += 1;
    }

    // Anything previously open that the detectors no longer raise has resolved.
    // Only within the evaluated scope, so a narrow run cannot close the world.
    const resolved = resolveDisappeared(db, workspaceId, seen, { skuIds, relevant, now });

    const runId = newId('run');
    db.prepare(
      `INSERT INTO attention_runs (id, workspace_id, trigger, scope, opened, updated, resolved, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      workspaceId,
      trigger,
      JSON.stringify(options.scope || {}),
      opened,
      updated,
      resolved,
      Date.now() - startedAt,
      nowIso()
    );

    return { runId, opened, updated, resolved, evaluated: candidates.length };
  });
}

/**
 * Closes conditions that no longer hold. A narrow run only considers items it
 * could have re-detected, so re-evaluating one SKU never resolves another's.
 */
function resolveDisappeared(db, workspaceId, seen, { skuIds, relevant, now }) {
  const open = db
    .prepare("SELECT * FROM attention_items WHERE workspace_id = ? AND status IN ('OPEN', 'ACKNOWLEDGED')")
    .all(workspaceId);

  let resolved = 0;
  for (const item of open) {
    if (seen.has(item.fingerprint)) continue;
    if (!relevant.has(item.category)) {
      // The workspace's configuration no longer produces this category.
      close(db, item, 'The configuration no longer tracks this kind of condition.', now);
      resolved += 1;
      continue;
    }
    if (skuIds) {
      const entityIds = JSON.parse(item.affected_entity_ids || '[]');
      const inScope = entityIds.some((id) => skuIds.includes(id));
      if (!inScope) continue; // out of this run's scope — leave it alone
    }
    close(db, item, 'The measured condition no longer holds.', now);
    resolved += 1;
  }
  return resolved;
}

function close(db, item, reason, now) {
  db.prepare(
    `UPDATE attention_items
        SET status = 'RESOLVED', resolution_reason = ?, resolved_at = ?, last_evaluated_at = ?
      WHERE id = ?`
  ).run(reason, new Date(now).toISOString(), new Date(now).toISOString(), item.id);
}

function insert(db, workspaceId, candidate, now) {
  const timestamp = new Date(now).toISOString();
  db.prepare(
    `INSERT INTO attention_items (
       id, workspace_id, fingerprint, category, severity, priority_score, title, concise_summary,
       explanation, recommendation, affected_entity_type, affected_entity_ids,
       affected_location_ids, evidence_references, evidence, metrics, related_categories,
       confidence, status, detection_rule_version, first_detected_at, last_evaluated_at,
       item_id, sku_id
     ) VALUES (
       @id, @workspaceId, @fingerprint, @category, @severity, @priorityScore, @title, @conciseSummary,
       @explanation, @recommendation, @affectedEntityType, @affectedEntityIds,
       @affectedLocationIds, @evidenceReferences, @evidence, @metrics, @relatedCategories,
       @confidence, 'OPEN', @detectionRuleVersion, @now, @now,
       @itemId, @skuId
     )`
  ).run({
    id: newId('att'),
    workspaceId,
    itemId: candidate.itemId || null,
    skuId: candidate.skuId || null,
    fingerprint: candidate.fingerprint,
    category: candidate.category,
    severity: candidate.severity,
    priorityScore: candidate.priorityScore,
    title: candidate.title,
    conciseSummary: candidate.conciseSummary,
    explanation: candidate.explanation,
    recommendation: candidate.recommendation,
    affectedEntityType: candidate.affectedEntityType,
    affectedEntityIds: JSON.stringify(candidate.affectedEntityIds || []),
    affectedLocationIds: JSON.stringify(candidate.affectedLocationIds || []),
    evidenceReferences: JSON.stringify(candidate.evidenceReferences || []),
    evidence: JSON.stringify(candidate.evidence || []),
    metrics: JSON.stringify(candidate.metrics || {}),
    relatedCategories: JSON.stringify(candidate.relatedCategories || []),
    confidence: candidate.confidence,
    detectionRuleVersion: candidate.detectionRuleVersion || DETECTION_RULE_VERSION,
    now: timestamp,
  });
}

// --- reading -----------------------------------------------------------------

function hydrate(row) {
  return {
    attentionId: row.id,
    workspaceId: row.workspace_id,
    fingerprint: row.fingerprint,
    category: row.category,
    severity: row.severity,
    priorityScore: row.priority_score,
    title: row.narrative_title || row.title,
    deterministicTitle: row.title,
    conciseSummary: row.narrative_summary || row.concise_summary,
    deterministicSummary: row.concise_summary,
    explanation: row.explanation,
    recommendation: row.narrative_recommendation || row.recommendation,
    deterministicRecommendation: row.recommendation,
    narrativeSource: row.narrative_source,
    affectedEntityType: row.affected_entity_type,
    // Denormalised on the row so an action can be built from a finding without
    // unpacking the affected-entity list and guessing which id is the SKU.
    itemId: row.item_id || null,
    skuId: row.sku_id || null,
    affectedEntityIds: JSON.parse(row.affected_entity_ids || '[]'),
    affectedLocationIds: JSON.parse(row.affected_location_ids || '[]'),
    evidenceReferences: JSON.parse(row.evidence_references || '[]'),
    evidence: JSON.parse(row.evidence || '[]'),
    metrics: JSON.parse(row.metrics || '{}'),
    relatedCategories: JSON.parse(row.related_categories || '[]'),
    confidence: row.confidence,
    status: row.status,
    resolutionReason: row.resolution_reason,
    detectionRuleVersion: row.detection_rule_version,
    firstDetectedAt: row.first_detected_at,
    lastEvaluatedAt: row.last_evaluated_at,
    acknowledgedAt: row.acknowledged_at,
    dismissedAt: row.dismissed_at,
    dismissedUntil: row.dismissed_until,
    resolvedAt: row.resolved_at,
  };
}

function listAttention(
  db,
  workspaceId,
  { statuses = ['OPEN', 'ACKNOWLEDGED'], limit = 50, offset = 0, category = null } = {}
) {
  const placeholders = statuses.map(() => '?').join(',');
  const extra = category ? ' AND category = ?' : '';
  const filters = category ? [workspaceId, ...statuses, category] : [workspaceId, ...statuses];
  return db
    .prepare(
      `SELECT * FROM attention_items
        WHERE workspace_id = ? AND status IN (${placeholders})${extra}
        ORDER BY priority_score DESC, first_detected_at
        LIMIT ? OFFSET ?`
    )
    .all(...filters, limit, offset)
    .map(hydrate);
}

/** How many match, so a page can say what it is a page of. */
function countAttention(db, workspaceId, { statuses = ['OPEN', 'ACKNOWLEDGED'], category = null } = {}) {
  const placeholders = statuses.map(() => '?').join(',');
  const extra = category ? ' AND category = ?' : '';
  const params = category ? [workspaceId, ...statuses, category] : [workspaceId, ...statuses];
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM attention_items
        WHERE workspace_id = ? AND status IN (${placeholders})${extra}`
    )
    .get(...params).n;
}

/**
 * Open findings about one item, so the record itself can say what Foundry has
 * noticed. Matches on the denormalised item_id, and falls back to the affected
 * entity list for the workspace-wide findings that have no single item.
 */
function listAttentionForItem(db, workspaceId, itemId, { statuses = ['OPEN', 'ACKNOWLEDGED'] } = {}) {
  const placeholders = statuses.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT * FROM attention_items
        WHERE workspace_id = ? AND item_id = ? AND status IN (${placeholders})
        ORDER BY priority_score DESC`
    )
    .all(workspaceId, itemId, ...statuses)
    .map(hydrate);
}

function getAttention(db, workspaceId, attentionId) {
  const row = db.prepare('SELECT * FROM attention_items WHERE id = ? AND workspace_id = ?').get(attentionId, workspaceId);
  return row ? hydrate(row) : null;
}

function summarise(items) {
  const counts = { critical: 0, important: 0, watch: 0 };
  for (const item of items) counts[item.severity] = (counts[item.severity] || 0) + 1;
  return { total: items.length, ...counts, healthy: items.length === 0 };
}

module.exports = {
  evaluate,
  collectSignals,
  workspaceContext,
  listAttention,
  countAttention,
  listAttentionForItem,
  getAttention,
  summarise,
  group,
  score,
  hydrate,
  DETECTION_RULE_VERSION,
};
