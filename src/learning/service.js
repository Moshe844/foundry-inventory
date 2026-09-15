'use strict';

/**
 * Governed outcome learning.
 *
 * This module may observe, score and propose. A production setting changes
 * only through one of the explicit adapters below, after human approval or a
 * narrow versioned grant. No language-model output is accepted as a policy
 * kind, target, value, authority grant or verification result.
 */

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const forecastOutcomes = require('../forecasting/outcomes');
const leadTime = require('../forecasting/lead-time');
const purchasingPolicy = require('../purchasing/policy-service');
const accountingReports = require('../accounting/reports');

const EVALUATOR_ID = 'foundry.outcome-learning';
const EVALUATOR_VERSION = '1.0.0';
const RULES = Object.freeze({
  SUPPLIER_LEAD_TIME: { id:'supplier-lead-time-bias', version:'1.0.0', minimumSamples:3 },
  SAFETY_STOCK: { id:'underforecast-safety-stock', version:'1.0.0', minimumSamples:5 },
});
const MATERIALITY = ['LOW', 'MEDIUM', 'HIGH'];
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const encode = (value, fallback = {}) => JSON.stringify(value === undefined ? fallback : value);
const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
};
const nonempty = (value) => value && typeof value === 'object' && Object.keys(value).length > 0;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function hydrateDecision(row) {
  if (!row) return null;
  return { id:row.id, workspaceId:row.workspace_id, sourceKind:row.source_kind, sourceId:row.source_id,
    decisionKind:row.decision_kind, subjectType:row.subject_type, subjectId:row.subject_id,
    decidedAt:row.decided_at, modelId:row.model_id, modelVersion:row.model_version,
    ruleId:row.rule_id, ruleVersion:row.rule_version, policyId:row.policy_id,
    policyVersion:row.policy_version, evidence:parse(row.evidence, {}), decision:parse(row.decision, {}),
    expectedOutcome:parse(row.expected_outcome, {}), actualOutcome:parse(row.actual_outcome, {}),
    outcomeStatus:row.outcome_status, measuredAt:row.measured_at, createdAt:row.created_at,
    updatedAt:row.updated_at };
}

function hydrateProposal(row) {
  if (!row) return null;
  return { id:row.id, workspaceId:row.workspace_id, improvementKind:row.improvement_kind,
    targetType:row.target_type, targetId:row.target_id, headline:row.headline,
    rationale:row.rationale, currentValue:parse(row.current_value, {}),
    proposedValue:parse(row.proposed_value, {}), evidence:parse(row.evidence, {}),
    expectedImpact:parse(row.expected_impact, {}), modelId:row.model_id,
    modelVersion:row.model_version, ruleId:row.rule_id, ruleVersion:row.rule_version,
    materiality:row.materiality, status:row.status, integrityHash:row.integrity_hash,
    idempotencyKey:row.idempotency_key, authoritySnapshot:parse(row.authority_snapshot, {}),
    approvedByUserId:row.approved_by_user_id, approvedAt:row.approved_at,
    rolledOutAt:row.rolled_out_at, createdAt:row.created_at, updatedAt:row.updated_at };
}

function proposal(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM learning_proposals WHERE workspace_id=? AND id=?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That learning proposal is not in this inventory.');
  return hydrateProposal(row);
}

function event(db, item, type, detail = {}, actorId = null, rolloutId = null) {
  db.prepare(`INSERT INTO learning_events
    (id,workspace_id,proposal_id,rollout_id,event_type,detail,actor_user_id,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(newId('lev'), item.workspaceId, item.id || null, rolloutId,
    type, encode(detail), actorId, nowIso());
}

function captureDecision(db, workspaceId, input) {
  if (!input.sourceKind || !input.sourceId || !input.decisionKind || !input.subjectType) {
    throw new ValidationError('A learning decision needs an exact source, decision kind and subject.');
  }
  if (!input.modelVersion && !input.ruleVersion && !input.policyVersion) {
    throw new ValidationError('A learning decision needs the exact model, rule or policy version used.');
  }
  const existing = db.prepare(`SELECT * FROM learning_decisions
    WHERE workspace_id=? AND source_kind=? AND source_id=?`)
    .get(workspaceId, input.sourceKind, input.sourceId);
  if (existing) {
    const prior = hydrateDecision(existing);
    const immutable = { decisionKind:prior.decisionKind, evidence:prior.evidence, decision:prior.decision,
      expectedOutcome:prior.expectedOutcome, modelVersion:prior.modelVersion,
      ruleVersion:prior.ruleVersion, policyVersion:prior.policyVersion };
    const incoming = { decisionKind:input.decisionKind, evidence:input.evidence || {},
      decision:input.decision || {}, expectedOutcome:input.expectedOutcome || {},
      modelVersion:input.modelVersion || null, ruleVersion:input.ruleVersion || null,
      policyVersion:input.policyVersion ?? null };
    if (hash(immutable) !== hash(incoming)) {
      throw new ValidationError('The recorded decision snapshot is immutable; record a new source version instead.');
    }
    if (input.outcomeStatus && input.outcomeStatus !== prior.outcomeStatus) {
      db.prepare(`UPDATE learning_decisions SET actual_outcome=?,outcome_status=?,measured_at=?,updated_at=?
        WHERE id=?`).run(encode(input.actualOutcome || {}), input.outcomeStatus,
        input.measuredAt || nowIso(), nowIso(), existing.id);
    }
    return hydrateDecision(db.prepare('SELECT * FROM learning_decisions WHERE id=?').get(existing.id));
  }
  const id = newId('ldec'); const now = nowIso();
  db.prepare(`INSERT INTO learning_decisions
    (id,workspace_id,source_kind,source_id,decision_kind,subject_type,subject_id,decided_at,
     model_id,model_version,rule_id,rule_version,policy_id,policy_version,evidence,decision,
     expected_outcome,actual_outcome,outcome_status,measured_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, workspaceId, input.sourceKind,
    input.sourceId, input.decisionKind, input.subjectType, input.subjectId || null,
    input.decidedAt || now, input.modelId || null, input.modelVersion || null,
    input.ruleId || null, input.ruleVersion || null, input.policyId || null,
    input.policyVersion ?? null, encode(input.evidence || {}), encode(input.decision || {}),
    encode(input.expectedOutcome || {}), encode(input.actualOutcome || {}),
    input.outcomeStatus || 'OPEN', input.measuredAt || null, now, now);
  return hydrateDecision(db.prepare('SELECT * FROM learning_decisions WHERE id=?').get(id));
}

function observe(db, decision, input) {
  const key = input.idempotencyKey || `${decision.id}:${input.metricName}:${input.observedAt || nowIso().slice(0,10)}`;
  db.prepare(`INSERT OR IGNORE INTO learning_outcome_observations
    (id,workspace_id,decision_id,metric_name,predicted_value,actual_value,unit,comparable,evidence,
     evaluator_id,evaluator_version,idempotency_key,observed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(newId('lobs'), decision.workspaceId, decision.id,
    input.metricName, input.predictedValue ?? null, input.actualValue ?? null, input.unit,
    input.comparable === false ? 0 : 1, encode(input.evidence || {}), EVALUATOR_ID,
    EVALUATOR_VERSION, key, input.observedAt || nowIso(), nowIso());
  return db.prepare(`SELECT * FROM learning_outcome_observations
    WHERE workspace_id=? AND idempotency_key=?`).get(decision.workspaceId, key);
}

function syncForecasts(db, workspaceId, options = {}) {
  forecastOutcomes.scoreDue(db, workspaceId, options);
  const rows = db.prepare(`SELECT f.*,o.id outcome_id,o.scored_at,o.predicted_units,o.actual_units,
      o.error_units,o.absolute_error,o.censored_days,o.comparable,o.notes
    FROM demand_forecasts f LEFT JOIN forecast_outcomes o ON o.forecast_id=f.id
    WHERE f.workspace_id=?`).all(workspaceId);
  for (const row of rows) {
    const measured = Boolean(row.outcome_id);
    const decision = captureDecision(db, workspaceId, { sourceKind:'FORECAST', sourceId:row.id,
      decisionKind:'DEMAND_FORECAST', subjectType:'SKU', subjectId:row.sku_id, decidedAt:row.created_at,
      modelId:row.model_id || 'deterministic-demand-forecast', modelVersion:row.model_version,
      evidence:parse(row.evidence, {}), decision:{ dailyRate:row.daily_rate, horizonUnits:row.horizon_units,
        horizonDays:row.horizon_days, confidence:row.confidence },
      expectedOutcome:{ demandUnits:row.horizon_units, horizonEnd:row.horizon_end },
      actualOutcome:measured ? { demandUnits:row.actual_units, censoredDays:row.censored_days,
        absoluteError:row.absolute_error } : {}, outcomeStatus:measured
        ? (row.comparable ? 'MEASURED' : 'INCONCLUSIVE') : 'OPEN', measuredAt:row.scored_at || null });
    if (measured) observe(db, decision, { metricName:'FORECAST_ERROR_UNITS',
      predictedValue:row.predicted_units, actualValue:row.actual_units, unit:'units',
      comparable:Boolean(row.comparable), evidence:{ forecastOutcomeId:row.outcome_id,
        censoredDays:row.censored_days, notes:row.notes }, observedAt:row.scored_at,
      idempotencyKey:`forecast:${row.outcome_id}` });
  }
}

function syncSupplierDeliveries(db, workspaceId, options = {}) {
  const suppliers = db.prepare('SELECT id,name,default_lead_time_days FROM suppliers WHERE workspace_id=? AND status=\'active\'')
    .all(workspaceId);
  for (const supplier of suppliers) {
    for (const delivery of leadTime.deliveries(db, workspaceId, supplier.id, options)) {
      const promised = delivery.promisedDays ?? supplier.default_lead_time_days;
      const decision = captureDecision(db, workspaceId, { sourceKind:'SUPPLIER_DELIVERY',
        sourceId:delivery.purchaseOrderId, decisionKind:'SUPPLIER_DELIVERY_EXPECTATION',
        subjectType:'SUPPLIER', subjectId:supplier.id, decidedAt:delivery.firstReceiptAt,
        ruleId:'supplier-promise-comparison', ruleVersion:EVALUATOR_VERSION,
        evidence:{ purchaseOrderId:delivery.purchaseOrderId, poNumber:delivery.poNumber,
          sentAt:delivery.sentAt, firstReceiptAt:delivery.firstReceiptAt,
          expectedDate:delivery.expectedDate, expectedDateSource:delivery.expectedDateSource },
        decision:{ planningLeadTimeDays:promised }, expectedOutcome:{ leadTimeDays:promised },
        actualOutcome:{ leadTimeDays:delivery.actualDays }, outcomeStatus:promised == null ? 'INCONCLUSIVE' : 'MEASURED',
        measuredAt:delivery.firstReceiptAt });
      observe(db, decision, { metricName:'SUPPLIER_LEAD_TIME_ERROR_DAYS', predictedValue:promised,
        actualValue:delivery.actualDays, unit:'days', comparable:promised != null,
        evidence:{ purchaseOrderId:delivery.purchaseOrderId, poNumber:delivery.poNumber },
        observedAt:delivery.firstReceiptAt, idempotencyKey:`supplier-delivery:${delivery.purchaseOrderId}` });
    }
  }
}

function syncAutonomousOperations(db, workspaceId) {
  const rows = db.prepare(`SELECT * FROM autonomous_operations WHERE workspace_id=?
    AND status IN ('COMPLETED','NEEDS_HUMAN','FAILED')`).all(workspaceId);
  for (const row of rows) {
    const expected = parse(row.expected_outcome, {}); const actual = parse(row.actual_outcome, {});
    const authority = parse(row.authority_snapshot, {});
    const decision = captureDecision(db, workspaceId, { sourceKind:'AUTONOMOUS_OPERATION', sourceId:row.id,
      decisionKind:row.operation_type, subjectType:row.source_kind || 'OPERATION', subjectId:row.source_id,
      decidedAt:row.authorized_at || row.created_at, ruleId:`autonomous-adapter:${row.operation_type}`,
      ruleVersion:String(parse(row.learning, {}).adapterVersion || '1'),
      policyId:authority.grantId || authority.policyId || null,
      policyVersion:authority.version ?? authority.policyVersion ?? null,
      evidence:parse(row.evidence, []), decision:parse(row.decision, {}), expectedOutcome:expected,
      actualOutcome:actual, outcomeStatus:row.status === 'COMPLETED' ? 'MEASURED' : 'INCONCLUSIVE',
      measuredAt:row.completed_at || row.updated_at });
    const mappings = [
      ['STOCKOUT_AVOIDED','stockoutAvoided','boolean'], ['EXCESS_INVENTORY_UNITS','excessInventoryUnits','units'],
      ['CASH_USE_MINOR','cashUseMinor','minor_currency_units'], ['MARGIN_IMPACT_MINOR','marginImpactMinor','minor_currency_units'],
    ];
    for (const [metricName,key,unit] of mappings) if (actual[key] !== undefined) observe(db, decision, {
      metricName, predictedValue:expected[key] ?? null, actualValue:actual[key] === true ? 1 : actual[key] === false ? 0 : actual[key],
      unit, comparable:true, evidence:{ operationId:row.id, verification:parse(row.verification, {}) },
      observedAt:row.completed_at || row.updated_at, idempotencyKey:`operation:${row.id}:${metricName}` });
    const intervention = db.prepare(`SELECT COUNT(*) n FROM autonomous_operation_interventions
      WHERE workspace_id=? AND operation_id=?`).get(workspaceId, row.id).n;
    observe(db, decision, { metricName:'OWNER_INTERVENTION', predictedValue:0,
      actualValue:intervention ? 1 : 0, unit:'boolean', comparable:true,
      evidence:{ operationId:row.id, interventionCount:intervention }, observedAt:row.updated_at,
      idempotencyKey:`operation:${row.id}:intervention` });
  }
}

function observeKnownOutcomeMetrics(db, decision, expected, actual, prefix, observedAt) {
  const mappings = [
    ['STOCKOUT_AVOIDED','stockoutAvoided','boolean'], ['EXCESS_INVENTORY_UNITS','excessInventoryUnits','units'],
    ['EXCESS_INVENTORY_VALUE_MINOR','excessInventoryValueMinor','minor_currency_units'],
    ['CASH_USE_MINOR','cashUseMinor','minor_currency_units'], ['MARGIN_IMPACT_MINOR','marginImpactMinor','minor_currency_units'],
  ];
  for (const [metricName,key,unit] of mappings) if (actual[key] !== undefined) observe(db, decision, {
    metricName, predictedValue:expected[key] ?? null,
    actualValue:actual[key] === true ? 1 : actual[key] === false ? 0 : actual[key], unit,
    comparable:true, evidence:{ sourceKind:decision.sourceKind, sourceId:decision.sourceId },
    observedAt, idempotencyKey:`${prefix}:${metricName}` });
}

function syncInventoryPlans(db, workspaceId) {
  for (const row of db.prepare('SELECT * FROM inventory_decision_plans WHERE workspace_id=?').all(workspaceId)) {
    const expected = parse(row.expected_result, {}); const actual = parse(row.actual_result, {});
    const measured = row.status === 'SCORED' && nonempty(actual);
    const decision = captureDecision(db, workspaceId, { sourceKind:'INVENTORY_PLAN', sourceId:row.id,
      decisionKind:'ADAPTIVE_INVENTORY_PLAN', subjectType:'SKU', subjectId:row.sku_id,
      decidedAt:row.created_at, ruleId:'adaptive-inventory-planner', ruleVersion:'1.0.0',
      evidence:{ objective:parse(row.objective, {}), constraints:parse(row.constraints, {}),
        alternatives:parse(row.alternatives, []), confidence:row.confidence,
        uncertainty:parse(row.uncertainty, []) }, decision:parse(row.chosen_plan, {}),
      expectedOutcome:expected, actualOutcome:actual,
      outcomeStatus:measured ? 'MEASURED' : row.status === 'INFEASIBLE' ? 'INCONCLUSIVE' : 'OPEN',
      measuredAt:row.scored_at });
    if (measured) observeKnownOutcomeMetrics(db, decision, expected, actual, `inventory-plan:${row.id}`, row.scored_at);
  }
}

function syncSupplierResponses(db, workspaceId) {
  for (const row of db.prepare('SELECT * FROM supplier_response_plans WHERE workspace_id=?').all(workspaceId)) {
    const expected = parse(row.expected_outcome, {}); const actual = parse(row.actual_outcome, {});
    const measured = nonempty(actual);
    const decision = captureDecision(db, workspaceId, { sourceKind:'SUPPLIER_RESPONSE', sourceId:row.id,
      decisionKind:'SUPPLIER_RESPONSE_PLAN', subjectType:'SKU', subjectId:row.sku_id,
      decidedAt:row.created_at, ruleId:'supplier-response-planner', ruleVersion:'1.0.0',
      evidence:{ sourceDocumentId:row.source_document_id, facts:parse(row.evidence, []),
        consequences:parse(row.consequences, {}), alternatives:parse(row.alternatives, []) },
      decision:parse(row.chosen_plan, {}), expectedOutcome:expected, actualOutcome:actual,
      outcomeStatus:measured ? 'MEASURED' : 'OPEN', measuredAt:measured ? row.updated_at : null });
    if (measured) observeKnownOutcomeMetrics(db, decision, expected, actual, `supplier-response:${row.id}`, row.updated_at);
  }
}

function syncPolicyRecommendations(db, workspaceId) {
  const rows = db.prepare(`SELECT r.*,f.model_id,f.model_version FROM planning_recommendations r
    LEFT JOIN demand_forecasts f ON f.id=r.forecast_id WHERE r.workspace_id=?`).all(workspaceId);
  for (const row of rows) {
    const detail = parse(row.authority_detail, {}); const result = parse(row.resulting_detail, {});
    const policyId = detail.policy?.id || null;
    const policyVersion = policyId ? db.prepare('SELECT version FROM automation_policies WHERE workspace_id=? AND id=?')
      .get(workspaceId, policyId)?.version ?? null : null;
    captureDecision(db, workspaceId, { sourceKind:'POLICY_CHANGE', sourceId:row.id,
      decisionKind:row.kind, subjectType:String(row.subject_type || 'policy').toUpperCase(),
      subjectId:row.subject_id, decidedAt:row.decided_at || row.created_at,
      modelId:row.model_id || null, modelVersion:row.model_version || null,
      ruleId:'planning-recommendation', ruleVersion:'1.0.0', policyId, policyVersion,
      evidence:parse(row.evidence, {}), decision:{ from:row.current_value, to:row.recommended_value,
        authorityVerdict:row.authority_verdict, status:row.status },
      expectedOutcome:{ resultingValue:row.recommended_value },
      actualOutcome:row.status === 'APPLIED' ? { resultingValue:result.to ?? row.recommended_value,
        resultingAction:row.resulting_action } : {},
      outcomeStatus:row.status === 'APPLIED' ? 'MEASURED'
        : ['DECLINED','SUPERSEDED','EXPIRED'].includes(row.status) ? 'INCONCLUSIVE' : 'OPEN',
      measuredAt:row.decided_at });
  }
}

function propose(db, workspaceId, input) {
  if (!RULES[input.improvementKind]) throw new ValidationError('That is not a governed learning improvement.');
  if (!MATERIALITY.includes(input.materiality)) throw new ValidationError('Learning materiality is invalid.');
  const snapshot = { improvementKind:input.improvementKind, targetType:input.targetType,
    targetId:input.targetId, currentValue:input.currentValue, proposedValue:input.proposedValue,
    evidence:input.evidence, expectedImpact:input.expectedImpact, ruleId:input.ruleId,
    ruleVersion:input.ruleVersion, materiality:input.materiality };
  const integrity = hash(snapshot); const key = input.idempotencyKey || `${input.improvementKind}:${input.targetId}:${integrity.slice(0,20)}`;
  const existing = db.prepare('SELECT * FROM learning_proposals WHERE workspace_id=? AND idempotency_key=?')
    .get(workspaceId, key);
  if (existing) return hydrateProposal(existing);
  const id = newId('lprop'); const now = nowIso();
  db.prepare(`INSERT INTO learning_proposals
    (id,workspace_id,improvement_kind,target_type,target_id,headline,rationale,current_value,
     proposed_value,evidence,expected_impact,model_id,model_version,rule_id,rule_version,
     materiality,status,integrity_hash,idempotency_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PROPOSED',?,?,?,?)`).run(id, workspaceId,
    input.improvementKind, input.targetType, input.targetId, input.headline, input.rationale,
    encode(input.currentValue), encode(input.proposedValue), encode(input.evidence),
    encode(input.expectedImpact), input.modelId || null, input.modelVersion || null,
    input.ruleId, input.ruleVersion, input.materiality, integrity, key, now, now);
  const created = proposal(db, workspaceId, id);
  event(db, created, 'PROPOSED', { evidence:created.evidence, expectedImpact:created.expectedImpact });
  return created;
}

function detectBias(db, workspaceId, options = {}) {
  syncForecasts(db, workspaceId, options);
  syncSupplierDeliveries(db, workspaceId, options);
  const proposals = [];
  for (const supplier of db.prepare(`SELECT id,name,default_lead_time_days FROM suppliers
    WHERE workspace_id=? AND status='active'`).all(workspaceId)) {
    const timing = leadTime.forSupplier(db, workspaceId, supplier.id, options);
    if (!timing.measured || timing.measured.samples < RULES.SUPPLIER_LEAD_TIME.minimumSamples
        || timing.configuredDays === null || !timing.material) continue;
    const proposedDays = Math.max(0, Math.ceil(timing.measured.meanDays));
    const deliveryIds = timing.deliveries.map((row) => row.purchaseOrderId);
    proposals.push(propose(db, workspaceId, { improvementKind:'SUPPLIER_LEAD_TIME', targetType:'SUPPLIER',
      targetId:supplier.id, headline:`Plan ${supplier.name} at ${proposedDays} days`,
      rationale:`${supplier.name} is configured at ${timing.configuredDays} days but the last ${timing.measured.samples} deliveries averaged ${timing.measured.meanDays} days.`,
      currentValue:{ days:timing.configuredDays }, proposedValue:{ days:proposedDays },
      evidence:{ deliveryIds, samples:timing.measured.samples, meanDays:timing.measured.meanDays,
        medianDays:timing.measured.medianDays, variabilityDays:timing.measured.variabilityDays,
        lateOrders:timing.measured.lateOrders },
      expectedImpact:{ leadTimeErrorDays:round(Math.abs(timing.differenceDays) - Math.abs(timing.measured.meanDays - proposedDays)),
        description:'Use measured supplier timing in future replenishment decisions.' },
      ruleId:RULES.SUPPLIER_LEAD_TIME.id, ruleVersion:RULES.SUPPLIER_LEAD_TIME.version,
      materiality:Math.abs(timing.differenceDays) >= 3 ? 'HIGH' : 'MEDIUM',
      idempotencyKey:`supplier-lead:${supplier.id}:${timing.configuredDays}:${proposedDays}:${hash(deliveryIds).slice(0,12)}` }));
  }
  const bySku = db.prepare(`SELECT d.subject_id sku_id,COUNT(*) samples,
      AVG(o.predicted_value-o.actual_value) bias,AVG(ABS(o.predicted_value-o.actual_value)) mae
    FROM learning_outcome_observations o JOIN learning_decisions d ON d.id=o.decision_id
    WHERE o.workspace_id=? AND o.metric_name='FORECAST_ERROR_UNITS' AND o.comparable=1
    GROUP BY d.subject_id HAVING COUNT(*)>=?`).all(workspaceId, RULES.SAFETY_STOCK.minimumSamples);
  for (const row of bySku) {
    if (Number(row.bias) > -1.5) continue;
    const sku = db.prepare(`SELECT s.id,s.code,s.variant_label,i.name FROM skus s JOIN items i ON i.id=s.item_id
      WHERE s.workspace_id=? AND s.id=?`).get(workspaceId, row.sku_id);
    if (!sku) continue;
    const current = purchasingPolicy.effectivePolicy(db, workspaceId, sku.id).safetyStock || 0;
    const next = current + Math.ceil(Math.abs(Number(row.bias)));
    proposals.push(propose(db, workspaceId, { improvementKind:'SAFETY_STOCK', targetType:'SKU',
      targetId:sku.id, headline:`Keep ${next} safety units for ${sku.variant_label ? `${sku.name} / ${sku.variant_label}` : sku.name}`,
      rationale:`Across ${row.samples} comparable forecasts, demand averaged ${round(Math.abs(row.bias))} units above Foundry's prediction.`,
      currentValue:{ units:current }, proposedValue:{ units:next },
      evidence:{ samples:Number(row.samples), meanBiasUnits:round(Number(row.bias)), meanAbsoluteError:round(Number(row.mae)),
        observationIds:db.prepare(`SELECT o.id FROM learning_outcome_observations o JOIN learning_decisions d ON d.id=o.decision_id
          WHERE o.workspace_id=? AND d.subject_id=? AND o.metric_name='FORECAST_ERROR_UNITS' AND o.comparable=1`)
          .all(workspaceId, sku.id).map((item) => item.id) },
      expectedImpact:{ additionalBufferUnits:next-current, description:'Reduce repeated forecast-driven stockout exposure.' },
      ruleId:RULES.SAFETY_STOCK.id, ruleVersion:RULES.SAFETY_STOCK.version,
      materiality:next-current >= 5 ? 'HIGH' : 'MEDIUM',
      idempotencyKey:`safety-stock:${sku.id}:${current}:${next}:${row.samples}` }));
  }
  return proposals;
}

const adapters = {
  SUPPLIER_LEAD_TIME: {
    id:'supplier.default-lead-time', version:'1.0.0', permission:permissions.MANAGE_SUPPLIERS,
    read(db, item) {
      const row = db.prepare('SELECT default_lead_time_days FROM suppliers WHERE workspace_id=? AND id=?')
        .get(item.workspaceId, item.targetId);
      if (!row) throw new NotFoundError('That supplier is no longer available.');
      return { days:row.default_lead_time_days === null ? null : Number(row.default_lead_time_days) };
    },
    apply(db, item, value) {
      db.prepare('UPDATE suppliers SET default_lead_time_days=?,updated_at=? WHERE workspace_id=? AND id=?')
        .run(value.days, nowIso(), item.workspaceId, item.targetId);
    },
  },
  SAFETY_STOCK: {
    id:'purchasing.reorder-policy.safety-stock', version:'1.0.0', permission:permissions.MANAGE_REPLENISHMENT,
    read(db, item) { return { units:purchasingPolicy.effectivePolicy(db, item.workspaceId, item.targetId).safetyStock || 0 }; },
    apply(db, item, value, ctx, membership) {
      purchasingPolicy.setPolicy(db, ctx, membership, item.targetId, { safetyStock:value.units, source:'foundry' });
    },
  },
};

function activeAuthority(db, workspaceId, improvementKind) {
  const row = db.prepare(`SELECT * FROM learning_authority WHERE workspace_id=? AND improvement_kind=?
    AND enabled=1 AND revoked_at IS NULL ORDER BY version DESC LIMIT 1`).get(workspaceId, improvementKind);
  if (!row) return null;
  return { id:row.id, version:row.version, improvementKind:row.improvement_kind,
    targetIds:parse(row.target_ids, []), maximumAbsoluteChange:row.maximum_absolute_change,
    maximumPercentChange:row.maximum_percent_change, maximumMateriality:row.maximum_materiality,
    grantedByUserId:row.granted_by_user_id };
}

function grantAuthority(db, ctx, membership, improvementKind, bounds = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'grant learning authority');
  if (!RULES[improvementKind]) throw new ValidationError('That learning authority is not available.');
  const previous = activeAuthority(db, ctx.workspaceId, improvementKind); const now = nowIso();
  if (previous) db.prepare(`UPDATE learning_authority SET enabled=0,revoked_by_user_id=?,revoked_at=? WHERE id=?`)
    .run(ctx.actorId, now, previous.id);
  db.prepare(`INSERT INTO learning_authority
    (id,workspace_id,improvement_kind,enabled,target_ids,maximum_absolute_change,
     maximum_percent_change,maximum_materiality,version,supersedes_id,granted_by_user_id,granted_at,created_at)
    VALUES (?,?,?,1,?,?,?,?,?,?,?,?,?)`).run(newId('lauth'), ctx.workspaceId, improvementKind,
    encode(bounds.targetIds || [], []), bounds.maximumAbsoluteChange ?? null,
    bounds.maximumPercentChange ?? null, bounds.maximumMateriality || 'LOW',
    (previous?.version || 0)+1, previous?.id || null, ctx.actorId, now, now);
  return activeAuthority(db, ctx.workspaceId, improvementKind);
}

function revokeAuthority(db, ctx, membership, improvementKind) {
  permissions.assertCan(membership, permissions.OPERATE, 'revoke learning authority');
  db.prepare(`UPDATE learning_authority SET enabled=0,revoked_by_user_id=?,revoked_at=?
    WHERE workspace_id=? AND improvement_kind=? AND enabled=1 AND revoked_at IS NULL`)
    .run(ctx.actorId, nowIso(), ctx.workspaceId, improvementKind);
}

function authorityFor(db, item) {
  const grant = activeAuthority(db, item.workspaceId, item.improvementKind);
  if (!grant) return { allowed:false, reason:'No narrow learning authority is enabled.' };
  const current = Number(Object.values(item.currentValue)[0]);
  const proposed = Number(Object.values(item.proposedValue)[0]);
  const absolute = Math.abs(proposed-current);
  const percent = current === 0 ? (absolute === 0 ? 0 : Infinity) : absolute/Math.abs(current)*100;
  const checks = [
    { name:'target', passed:!grant.targetIds.length || grant.targetIds.includes(item.targetId) },
    { name:'absolute', passed:grant.maximumAbsoluteChange == null || absolute<=grant.maximumAbsoluteChange },
    { name:'percent', passed:grant.maximumPercentChange == null || percent<=grant.maximumPercentChange },
    { name:'materiality', passed:MATERIALITY.indexOf(item.materiality)<=MATERIALITY.indexOf(grant.maximumMateriality) },
  ];
  return { allowed:checks.every((check)=>check.passed), grant, checks, absoluteChange:absolute,
    percentChange:Number.isFinite(percent) ? round(percent) : null,
    reason:checks.every((check)=>check.passed) ? 'Inside the explicit narrow learning grant.' : 'Outside the explicit learning grant.' };
}

function approve(db, ctx, membership, proposalId, expectedHash = null) {
  permissions.assertCan(membership, permissions.ADMIN, 'approve a learning change');
  const item = proposal(db, ctx.workspaceId, proposalId);
  if (expectedHash && expectedHash !== item.integrityHash) throw new ValidationError('This learning proposal changed. Review it again.');
  if (['ROLLED_OUT','REVERTED'].includes(item.status)) return item;
  if (item.status !== 'PROPOSED') throw new ValidationError('Only a proposed learning change can be approved.');
  const now = nowIso();
  db.prepare(`UPDATE learning_proposals SET status='APPROVED',approved_by_user_id=?,approved_at=?,updated_at=?
    WHERE workspace_id=? AND id=?`).run(ctx.actorId, now, now, ctx.workspaceId, item.id);
  const fresh = proposal(db, ctx.workspaceId, item.id); event(db, fresh, 'APPROVED', {}, ctx.actorId);
  return fresh;
}

function rollout(db, ctx, membership, proposalId, options = {}) {
  let item = proposal(db, ctx.workspaceId, proposalId);
  if (item.status === 'ROLLED_OUT') return { proposal:item, rollout:db.prepare(`SELECT * FROM learning_rollouts
    WHERE workspace_id=? AND proposal_id=? ORDER BY applied_at DESC LIMIT 1`).get(ctx.workspaceId, item.id), replayed:true };
  const adapter = adapters[item.improvementKind];
  if (!adapter) throw new ValidationError('No deterministic adapter owns that learning change.');
  let authoritySnapshot;
  if (options.automatic) {
    const judged = authorityFor(db, item);
    if (!judged.allowed) return { proposal:item, applied:false, needsApproval:true, because:judged.reason };
    permissions.assertCan(membership, adapter.permission, 'apply this learned policy change');
    authoritySnapshot = { kind:'learning_grant', grantId:judged.grant.id, version:judged.grant.version,
      checks:judged.checks };
  } else {
    permissions.assertCan(membership, adapter.permission, 'apply this learned policy change');
    if (item.status !== 'APPROVED') item = approve(db, ctx, membership, item.id, options.expectedHash);
    authoritySnapshot = { kind:'human', approvedByUserId:ctx.actorId, permission:adapter.permission };
  }
  const before = adapter.read(db, item);
  if (hash(before) !== hash(item.currentValue)) {
    db.prepare(`UPDATE learning_proposals SET status='SUPERSEDED',updated_at=? WHERE id=?`).run(nowIso(), item.id);
    event(db, item, 'SUPERSEDED', { expected:item.currentValue, found:before }, ctx.actorId);
    throw new ValidationError('The underlying policy changed since Foundry measured it. A fresh proposal is required.');
  }
  const transaction = db.transaction(() => {
    adapter.apply(db, item, item.proposedValue, ctx, membership);
    const after = adapter.read(db, item);
    if (hash(after) !== hash(item.proposedValue)) throw new Error('The policy adapter could not verify the applied value.');
    const id = newId('lroll'); const now = nowIso();
    db.prepare(`INSERT INTO learning_rollouts
      (id,workspace_id,proposal_id,adapter_id,adapter_version,previous_value,applied_value,
       authority_snapshot,automatic,status,verification,applied_by_user_id,applied_at)
      VALUES (?,?,?,?,?,?,?,?,?,'ACTIVE',?,?,?)`).run(id, item.workspaceId, item.id, adapter.id,
      adapter.version, encode(before), encode(item.proposedValue), encode(authoritySnapshot),
      options.automatic ? 1 : 0, encode({ verified:true, readBack:after, verifiedAt:now }),
      options.automatic ? null : ctx.actorId, now);
    db.prepare(`UPDATE learning_proposals SET status='ROLLED_OUT',authority_snapshot=?,rolled_out_at=?,updated_at=?
      WHERE id=?`).run(encode(authoritySnapshot), now, now, item.id);
    event(db, item, 'ROLLED_OUT', { before, after, adapterId:adapter.id, adapterVersion:adapter.version,
      automatic:Boolean(options.automatic) }, ctx.actorId, id);
    return id;
  }).immediate();
  return { proposal:proposal(db, ctx.workspaceId, item.id),
    rollout:db.prepare('SELECT * FROM learning_rollouts WHERE id=?').get(transaction), applied:true };
}

function decline(db, ctx, membership, proposalId, reason = null) {
  permissions.assertCan(membership, permissions.ADMIN, 'decline a learning change');
  const item = proposal(db, ctx.workspaceId, proposalId);
  if (item.status === 'DECLINED') return item;
  if (item.status !== 'PROPOSED') throw new ValidationError('Only an open proposal can be declined.');
  const now = nowIso();
  db.prepare(`UPDATE learning_proposals SET status='DECLINED',declined_at=?,updated_at=? WHERE id=?`)
    .run(now, now, item.id); event(db, item, 'DECLINED', { reason }, ctx.actorId);
  return proposal(db, ctx.workspaceId, item.id);
}

function monitor(db, workspaceId, proposalId, observation) {
  const item = proposal(db, workspaceId, proposalId);
  const rolloutRow = db.prepare(`SELECT * FROM learning_rollouts WHERE workspace_id=? AND proposal_id=?
    AND status IN ('ACTIVE','ROLLBACK_RECOMMENDED') ORDER BY applied_at DESC LIMIT 1`).get(workspaceId, item.id);
  if (!rolloutRow) throw new ValidationError('That change has no active rollout to monitor.');
  const expectedDirection = observation.expectedDirection || 'positive';
  const impact = Number(observation.impact);
  if (!Number.isFinite(impact)) throw new ValidationError('A measured rollout impact is required.');
  const bad = expectedDirection === 'negative' ? impact > 0 : impact < 0;
  event(db, item, 'OUTCOME_MEASURED', { impact, unit:observation.unit || null,
    expectedDirection, evidence:observation.evidence || {}, bad }, null, rolloutRow.id);
  if (bad) {
    db.prepare(`UPDATE learning_rollouts SET status='ROLLBACK_RECOMMENDED',verification=? WHERE id=?`)
      .run(encode({ verified:false, adverseImpact:impact, unit:observation.unit || null,
        evidence:observation.evidence || {}, checkedAt:nowIso() }), rolloutRow.id);
    db.prepare(`UPDATE learning_proposals SET status='ROLLBACK_RECOMMENDED',updated_at=? WHERE id=?`)
      .run(nowIso(), item.id);
  }
  return { bad, proposal:proposal(db, workspaceId, item.id), rolloutId:rolloutRow.id };
}

function rollback(db, ctx, membership, proposalId) {
  permissions.assertCan(membership, permissions.ADMIN, 'roll back a learned policy change');
  const item = proposal(db, ctx.workspaceId, proposalId);
  if (item.status === 'REVERTED') return { proposal:item, replayed:true };
  const rolloutRow = db.prepare(`SELECT * FROM learning_rollouts WHERE workspace_id=? AND proposal_id=?
    AND status IN ('ACTIVE','ROLLBACK_RECOMMENDED') ORDER BY applied_at DESC LIMIT 1`).get(ctx.workspaceId, item.id);
  if (!rolloutRow) throw new ValidationError('There is no active rollout to reverse.');
  const adapter = adapters[item.improvementKind];
  const previous = parse(rolloutRow.previous_value, {});
  db.transaction(() => {
    adapter.apply(db, item, previous, ctx, membership);
    const restored = adapter.read(db, item);
    if (hash(restored) !== hash(previous)) throw new Error('Rollback verification failed.');
    const now = nowIso();
    db.prepare(`UPDATE learning_rollouts SET status='REVERTED',verification=?,reverted_by_user_id=?,reverted_at=?
      WHERE id=?`).run(encode({ verified:true, restored, verifiedAt:now }), ctx.actorId, now, rolloutRow.id);
    db.prepare(`UPDATE learning_proposals SET status='REVERTED',updated_at=? WHERE id=?`).run(now, item.id);
    event(db, item, 'REVERTED', { restored, adapterId:adapter.id }, ctx.actorId, rolloutRow.id);
  }).immediate();
  return { proposal:proposal(db, ctx.workspaceId, item.id), restored:previous };
}

function listProposals(db, workspaceId, options = {}) {
  const statuses = options.statuses || ['PROPOSED','APPROVED','ROLLED_OUT','ROLLBACK_RECOMMENDED'];
  const marks = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM learning_proposals WHERE workspace_id=? AND status IN (${marks})
    ORDER BY CASE materiality WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,created_at DESC`)
    .all(workspaceId, ...statuses).map(hydrateProposal);
}

function measurements(db, workspaceId, options = {}) {
  syncForecasts(db, workspaceId, options); syncSupplierDeliveries(db, workspaceId, options);
  syncAutonomousOperations(db, workspaceId);
  syncInventoryPlans(db, workspaceId);
  syncSupplierResponses(db, workspaceId);
  syncPolicyRecommendations(db, workspaceId);
  const forecast = forecastOutcomes.accuracy(db, workspaceId, options);
  const supplierRows = db.prepare(`SELECT d.subject_id supplier_id,COUNT(*) samples,
      AVG(o.actual_value-o.predicted_value) mean_error_days,AVG(ABS(o.actual_value-o.predicted_value)) mae
    FROM learning_outcome_observations o JOIN learning_decisions d ON d.id=o.decision_id
    WHERE o.workspace_id=? AND o.metric_name='SUPPLIER_LEAD_TIME_ERROR_DAYS' AND o.comparable=1
    GROUP BY d.subject_id`).all(workspaceId).map((row) => ({ supplierId:row.supplier_id,
      samples:Number(row.samples), meanErrorDays:round(row.mean_error_days), meanAbsoluteErrorDays:round(row.mae) }));
  const operation = db.prepare(`SELECT COUNT(*) operations,
      SUM(CASE WHEN actual_value>0 THEN 1 ELSE 0 END) interventions
    FROM learning_outcome_observations WHERE workspace_id=? AND metric_name='OWNER_INTERVENTION'`)
    .get(workspaceId);
  const measuredOperations = Number(operation.operations || 0);
  const interventionRate = measuredOperations
    ? round(Number(operation.interventions || 0)/measuredOperations*100,1) : null;
  const automationRate = interventionRate === null ? null : round(100 - interventionRate,1);
  const sums = (metric) => Number(db.prepare(`SELECT COALESCE(SUM(actual_value),0) n
    FROM learning_outcome_observations WHERE workspace_id=? AND metric_name=? AND comparable=1`)
    .get(workspaceId, metric).n || 0);
  let slow = { rows:[], totalCostMinor:0 };
  try { slow = accountingReports.slowInventoryValue(db, workspaceId); } catch { /* missing cost evidence */ }
  return { forecast, supplierLeadTime:supplierRows,
    stockoutsAvoided:sums('STOCKOUT_AVOIDED'), excessInventoryUnits:sums('EXCESS_INVENTORY_UNITS'),
    currentSlowInventoryValueMinor:Number(slow.totalCostMinor || 0), currentSlowInventoryPositions:slow.rows.length,
    cashUseMinor:sums('CASH_USE_MINOR'), marginImpactMinor:sums('MARGIN_IMPACT_MINOR'),
    interventionRate, automationRate, automationTarget:{ minimumPercent:90, aspirationPercent:95,
      status:automationRate === null ? 'NOT_MEASURED' : automationRate >= 90 ? 'ON_TARGET' : 'BELOW_TARGET' },
    measuredOperations, observations:Number(db.prepare(`SELECT COUNT(*) n
      FROM learning_outcome_observations WHERE workspace_id=?`).get(workspaceId).n) };
}

function applyAuthorized(db, workspaceId) {
  const results = [];
  for (const item of listProposals(db, workspaceId, { statuses:['PROPOSED'] })) {
    const judged = authorityFor(db, item);
    if (!judged.allowed || !judged.grant?.grantedByUserId) continue;
    const membership = db.prepare(`SELECT u.* FROM users u JOIN accounts a ON a.id=u.account_id
      WHERE u.workspace_id=? AND u.id=? AND a.password_hash<>''`).get(workspaceId, judged.grant.grantedByUserId);
    if (!membership) continue;
    const ctx = { workspaceId, actorId:membership.id, accountId:membership.account_id };
    try { results.push(rollout(db, ctx, membership, item.id, { automatic:true })); }
    catch (error) { results.push({ proposal:item, applied:false, error:error.message }); }
  }
  return results;
}

function run(db, workspaceId, options = {}) {
  const metrics = measurements(db, workspaceId, options);
  const proposals = detectBias(db, workspaceId, options);
  const promoted = options.applyAuthorized ? applyAuthorized(db, workspaceId) : [];
  return { metrics, proposals, promoted };
}

module.exports = { EVALUATOR_ID, EVALUATOR_VERSION, RULES, captureDecision, observe,
  syncForecasts, syncSupplierDeliveries, syncAutonomousOperations, syncInventoryPlans,
  syncSupplierResponses, syncPolicyRecommendations, measurements, detectBias,
  run, proposal, listProposals, propose, approve, decline, rollout, monitor, rollback,
  grantAuthority, revokeAuthority, activeAuthority, authorityFor, applyAuthorized };
