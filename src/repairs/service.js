'use strict';

const crypto = require('node:crypto');
const { newId, nowIso } = require('../lib/util');
const { NotFoundError, ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const adapters = require('./adapters');

const ACTIVE = ['OPEN', 'DIAGNOSED', 'SIMULATED', 'NEEDS_AUTHORITY', 'AUTHORIZED',
  'EXECUTING', 'VERIFYING', 'FAILED', 'INCONCLUSIVE'];
const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};
const encode = (value) => JSON.stringify(value ?? {});

function mergeEvidence(existing = [], discovered = []) {
  const rows = [];
  const seen = new Set();
  for (const row of [...(existing || []), ...(discovered || [])]) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, kind: row.kind, symptom: row.symptom,
    failedInvariant: row.failed_invariant, status: row.status, confidence: row.confidence,
    materiality: row.materiality, affectedRecords: json(row.affected_records, {}),
    timeline: json(row.timeline, []), evidence: json(row.evidence, []),
    proposedRepair: json(row.proposed_repair, {}), simulation: json(row.simulation, {}),
    beforeEvidence: json(row.before_evidence, {}), executionResult: json(row.execution_result, {}),
    afterEvidence: json(row.after_evidence, {}), verification: json(row.verification, {}),
    adapterId: row.adapter_id, adapterVersion: row.adapter_version,
    requiredPermissions: json(row.required_permissions, []),
    requiresApproval: Boolean(row.requires_approval), approvedByUserId: row.approved_by_user_id,
    approvedAt: row.approved_at, attempts: Number(row.attempts), checkpoint: row.checkpoint,
    errorMessage: row.error_message, idempotencyKey: row.idempotency_key,
    createdByUserId: row.created_by_user_id, createdAt: row.created_at,
    updatedAt: row.updated_at, resolvedAt: row.resolved_at,
  };
}

function keyFor(kind, invariant, affected) {
  const digest = crypto.createHash('sha256').update(JSON.stringify({ invariant, affected }))
    .digest('hex').slice(0, 24);
  return `${kind}:${digest}`;
}

function appendEvent(db, repairCase, event, detail = {}, actorUserId = null) {
  db.prepare(`INSERT INTO repair_case_events
    (id, workspace_id, repair_case_id, event, detail, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(newId('rce'), repairCase.workspaceId, repairCase.id, event, encode(detail),
      actorUserId, nowIso());
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM repair_cases WHERE id = ? AND workspace_id = ?')
    .get(id, workspaceId);
  if (!row) throw new NotFoundError('That repair case is not in this inventory.');
  return hydrate(row);
}

function list(db, workspaceId, options = {}) {
  const statuses = options.statuses
    ? (Array.isArray(options.statuses) ? options.statuses : [options.statuses]) : null;
  const where = statuses ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.prepare(`SELECT * FROM repair_cases WHERE workspace_id = ?${where}
    ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
    .all(workspaceId, ...(statuses || []), Number(options.limit || 100)).map(hydrate);
}

function events(db, workspaceId, id) {
  get(db, workspaceId, id);
  return db.prepare(`SELECT e.*, u.name AS actor_name FROM repair_case_events e
    LEFT JOIN users u ON u.id = e.actor_user_id
    WHERE e.workspace_id = ? AND e.repair_case_id = ? ORDER BY e.created_at, e.rowid`)
    .all(workspaceId, id).map((row) => ({ event: row.event, detail: json(row.detail, {}),
      actorName: row.actor_name, createdAt: row.created_at }));
}

function open(db, ctx, input) {
  const kind = String(input.kind || '');
  const adapter = adapters.get(kind);
  if (!adapter) throw new ValidationError(`No governed repair adapter is registered for ${kind || 'that problem'}.`);
  const affected = input.affectedRecords || {};
  const key = input.idempotencyKey || keyFor(kind, input.failedInvariant, affected);
  const prior = db.prepare('SELECT * FROM repair_cases WHERE workspace_id = ? AND idempotency_key = ?')
    .get(ctx.workspaceId, key);
  if (prior) return { repairCase: hydrate(prior), created: false };
  const id = newId('repair'); const now = nowIso();
  db.prepare(`INSERT INTO repair_cases
    (id, workspace_id, kind, symptom, failed_invariant, confidence, affected_records,
     timeline, evidence, proposed_repair, adapter_id, adapter_version,
     required_permissions, idempotency_key, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, kind, String(input.symptom || 'StockChief found inconsistent records.'),
      String(input.failedInvariant || 'Related business records must agree.'),
      input.confidence || 'low', encode(affected), encode(input.timeline || []),
      encode(input.evidence || []), encode(input.proposedRepair || {}), adapter.id,
      adapter.version, encode(adapter.requiredPermissions || []), key, ctx.actorId || null, now, now);
  const repairCase = get(db, ctx.workspaceId, id);
  appendEvent(db, repairCase, 'opened', { symptom: repairCase.symptom,
    failedInvariant: repairCase.failedInvariant, affectedRecords: affected }, ctx.actorId || null);
  return { repairCase, created: true };
}

function updateDiagnosis(db, repairCase, diagnosis) {
  const now = nowIso();
  const timeline = mergeEvidence(repairCase.timeline, diagnosis.timeline);
  const evidence = mergeEvidence(repairCase.evidence, diagnosis.evidence);
  db.prepare(`UPDATE repair_cases SET status = 'DIAGNOSED', confidence = ?, materiality = ?,
    timeline = ?, evidence = ?, proposed_repair = ?, before_evidence = ?,
    required_permissions = ?, requires_approval = ?, error_message = NULL,
    checkpoint = 'diagnosed', updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(diagnosis.confidence || repairCase.confidence, diagnosis.materiality || 'unknown',
      encode(timeline), encode(evidence),
      encode({ ...repairCase.proposedRepair, ...(diagnosis.proposedRepair || {}) }),
      encode(diagnosis.beforeEvidence || { evidence }),
      encode(diagnosis.requiredPermissions || repairCase.requiredPermissions),
      diagnosis.requiresApproval ? 1 : 0, now, repairCase.id, repairCase.workspaceId);
}

function diagnose(db, workspaceId, id) {
  let repairCase = get(db, workspaceId, id);
  if (repairCase.status === 'RESOLVED') return repairCase;
  const adapter = adapters.get(repairCase.kind);
  const diagnosis = adapter.diagnose({ db, repairCase });
  updateDiagnosis(db, repairCase, diagnosis);
  repairCase = get(db, workspaceId, id);
  appendEvent(db, repairCase, 'diagnosed', { confidence: repairCase.confidence,
    materiality: repairCase.materiality, evidence: repairCase.evidence });
  return repairCase;
}

function simulate(db, workspaceId, id) {
  let repairCase = get(db, workspaceId, id);
  if (repairCase.status === 'OPEN' || repairCase.status === 'FAILED'
      || repairCase.status === 'INCONCLUSIVE') repairCase = diagnose(db, workspaceId, id);
  if (repairCase.status === 'RESOLVED') return repairCase;
  const simulation = adapters.get(repairCase.kind).simulate({ db, repairCase });
  const executable = simulation.executable !== false;
  const status = !executable ? 'INCONCLUSIVE'
    : repairCase.requiresApproval ? 'NEEDS_AUTHORITY' : 'SIMULATED';
  db.prepare(`UPDATE repair_cases SET simulation = ?, status = ?, checkpoint = 'simulated',
    error_message = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(encode(simulation), status, executable ? null : simulation.summary, nowIso(), id, workspaceId);
  repairCase = get(db, workspaceId, id);
  appendEvent(db, repairCase, 'simulated', simulation);
  return repairCase;
}

function assertPermissions(membership, required) {
  for (const permission of required || []) permissions.assertCan(membership, permission,
    'approve and execute this repair');
}

function approve(db, ctx, membership, id) {
  let repairCase = get(db, ctx.workspaceId, id);
  assertPermissions(membership, repairCase.requiredPermissions);
  // Approval POSTs are routinely retried by browsers and proxies. Once an
  // approval has been recorded—or the case is already resolved—the replay is
  // a read of the durable state, never a transition that reopens the case.
  if (repairCase.status === 'RESOLVED' || repairCase.approvedAt) return repairCase;
  if (repairCase.status === 'OPEN' || repairCase.status === 'DIAGNOSED') {
    repairCase = simulate(db, ctx.workspaceId, id);
  }
  if (repairCase.status === 'INCONCLUSIVE') {
    throw new ValidationError(repairCase.errorMessage || 'This case has no safe executable repair yet.');
  }
  if (!['NEEDS_AUTHORITY', 'SIMULATED'].includes(repairCase.status)) {
    throw new ValidationError('This repair is not waiting for approval.');
  }
  const now = nowIso();
  db.prepare(`UPDATE repair_cases SET status = 'AUTHORIZED', approved_by_user_id = ?,
    approved_at = ?, checkpoint = 'authorized', error_message = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(ctx.actorId, now, now, id, ctx.workspaceId);
  repairCase = get(db, ctx.workspaceId, id);
  appendEvent(db, repairCase, 'authorized', { simulation: repairCase.simulation }, ctx.actorId);
  return repairCase;
}

function finalizeVerification(db, repairCase, verification, actorUserId = null) {
  const passed = verification && verification.passed === true;
  const status = passed ? 'RESOLVED' : verification && verification.needsHuman
    ? 'NEEDS_AUTHORITY' : 'FAILED';
  const now = nowIso();
  db.prepare(`UPDATE repair_cases SET status = ?, verification = ?, after_evidence = ?,
    approved_by_user_id = CASE WHEN ? = 'NEEDS_AUTHORITY' THEN NULL ELSE approved_by_user_id END,
    approved_at = CASE WHEN ? = 'NEEDS_AUTHORITY' THEN NULL ELSE approved_at END,
    checkpoint = ?, error_message = ?, resolved_at = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`)
    .run(status, encode(verification || {}), encode({ checks: (verification && verification.checks) || [] }),
      status, status,
      passed ? 'verified' : 'verification_failed', passed ? null : 'Post-repair verification did not pass.',
      passed ? now : null, now, repairCase.id, repairCase.workspaceId);
  const updated = get(db, repairCase.workspaceId, repairCase.id);
  appendEvent(db, updated, passed ? 'verified_and_resolved' : 'verification_failed',
    verification || {}, actorUserId);
  return updated;
}

function verify(db, workspaceId, id, actorUserId = null) {
  const repairCase = get(db, workspaceId, id);
  const verification = adapters.get(repairCase.kind).verify({ db, repairCase });
  return finalizeVerification(db, repairCase, verification, actorUserId);
}

function execute(db, ctx, membership, id) {
  let repairCase = get(db, ctx.workspaceId, id);
  if (repairCase.status === 'RESOLVED') return { repairCase, replayed: true };
  if (['OPEN', 'DIAGNOSED'].includes(repairCase.status)) repairCase = simulate(db, ctx.workspaceId, id);
  assertPermissions(membership, repairCase.requiredPermissions);
  if (repairCase.status === 'INCONCLUSIVE') throw new ValidationError(repairCase.errorMessage);
  if (repairCase.requiresApproval && !repairCase.approvedAt) {
    throw new ValidationError('Review the simulated consequences and approve this repair first.');
  }
  // A crash may occur after the domain action and before the case checkpoint.
  // Verify first on every resumed attempt. If the invariant already passes,
  // the action is not repeated.
  if (['EXECUTING', 'VERIFYING', 'FAILED'].includes(repairCase.status)) {
    const checked = adapters.get(repairCase.kind).verify({ db, repairCase });
    if (checked.passed) return { repairCase: finalizeVerification(db, repairCase, checked, ctx.actorId), replayed: true };
  }
  db.prepare(`UPDATE repair_cases SET status = 'EXECUTING', attempts = attempts + 1,
    checkpoint = 'executing', error_message = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .run(nowIso(), id, ctx.workspaceId);
  repairCase = get(db, ctx.workspaceId, id);
  appendEvent(db, repairCase, 'execution_started', { attempt: repairCase.attempts }, ctx.actorId);
  try {
    const result = adapters.get(repairCase.kind).execute({ db, ctx, membership, repairCase });
    db.prepare(`UPDATE repair_cases SET status = 'VERIFYING', execution_result = ?,
      checkpoint = 'domain_action_complete', updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(encode(result || {}), nowIso(), id, ctx.workspaceId);
    repairCase = get(db, ctx.workspaceId, id);
    appendEvent(db, repairCase, 'domain_action_completed', result || {}, ctx.actorId);
    return { repairCase: verify(db, ctx.workspaceId, id, ctx.actorId), replayed: false };
  } catch (error) {
    db.prepare(`UPDATE repair_cases SET status = 'FAILED', error_message = ?,
      checkpoint = 'execution_failed', updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(String(error.message || error), nowIso(), id, ctx.workspaceId);
    repairCase = get(db, ctx.workspaceId, id);
    appendEvent(db, repairCase, 'execution_failed', { error: repairCase.errorMessage }, ctx.actorId);
    throw error;
  }
}

function openAndAssess(db, ctx, input) {
  const opened = open(db, ctx, input);
  let repairCase = opened.repairCase;
  if (repairCase.status === 'OPEN') repairCase = diagnose(db, ctx.workspaceId, repairCase.id);
  if (repairCase.status === 'DIAGNOSED') repairCase = simulate(db, ctx.workspaceId, repairCase.id);
  return { repairCase, created: opened.created };
}

function recover(db, ctx, membership) {
  const recovered = [];
  for (const repairCase of list(db, ctx.workspaceId, { statuses: ['EXECUTING', 'VERIFYING'], limit: 100 })) {
    try { recovered.push(execute(db, ctx, membership, repairCase.id).repairCase); }
    catch { recovered.push(get(db, ctx.workspaceId, repairCase.id)); }
  }
  return recovered;
}

function executeAutonomously(db, ctx, membership, id) {
  const repairCase = get(db, ctx.workspaceId, id);
  const autonomous = require('../autonomous/service');
  const operation = autonomous.create(db, ctx, {
    operationType:'repair.execute', idempotencyKey:`repair-case:${id}`,
    sourceKind:'repair_case', sourceId:id,
    title:`Repair ${repairCase.symptom}`,
    summary:repairCase.failedInvariant,
    link:`/repairs/${id}`,
    evidence:repairCase.evidence,
    decision:{ repairCaseId:id, adapterId:repairCase.adapterId,
      requiresApproval:repairCase.requiresApproval },
    affectedEntities:repairCase.affectedRecords,
    authorityDimensions:{ confidence:repairCase.confidence,
      risk:repairCase.materiality === 'material' ? 'critical' : 'high' },
    expectedOutcome:{ repairStatus:'RESOLVED', invariant:repairCase.failedInvariant },
  });
  return autonomous.runSync(db, ctx, membership, operation.id);
}

require('../autonomous/service').registerAdapter('repair.execute', {
  owner:'repairs.service',
  authorize:({ db, ctx, membership, operation, execution }) => {
    const repairCase = get(db, ctx.workspaceId, operation.decision.repairCaseId);
    const permitted = (repairCase.requiredPermissions || []).every((permission) =>
      permissions.can(membership, permission));
    const requiresOwner = repairCase.requiresApproval && !repairCase.approvedAt;
    const checks = [
      { name:'executionState', passed:execution.allowed,
        reason:execution.because || 'Repair automation is active.' },
      { name:'domainPermission', passed:permitted,
        reason:'The responsible actor must retain every permission required by the repair adapter.' },
      { name:'materialJudgment', passed:!requiresOwner,
        reason:requiresOwner ? 'This repair contains material judgment and requires owner approval.'
          : 'This repair is deterministic or already has the required approval.' },
    ];
    return { allowed:checks.every((check) => check.passed), checks };
  },
  execute:({ db, ctx, membership, operation }) => execute(db, ctx, membership,
    operation.decision.repairCaseId),
  verify:({ db, ctx, operation }) => {
    const repairCase = get(db, ctx.workspaceId, operation.decision.repairCaseId);
    const passed = repairCase.status === 'RESOLVED'
      && repairCase.verification?.passed === true;
    return { passed, reason:passed
      ? 'The repair adapter reread every affected domain and its invariant now passes.'
      : (repairCase.errorMessage || 'The repair case is not independently verified.'),
    repairCaseId:repairCase.id, repairStatus:repairCase.status };
  },
});

module.exports = { ACTIVE, hydrate, keyFor, open, openAndAssess, get, list, events,
  diagnose, simulate, approve, execute, executeAutonomously, verify, recover };
