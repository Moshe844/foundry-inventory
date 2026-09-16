'use strict';

const { newId, nowIso } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const permissions = require('../actions/permissions');
const modes = require('../autopilot/modes');
const catalog = require('./catalog');

const adapters = new Map();
const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch { return fallback; } };
const encode = (value, fallback) => JSON.stringify(value === undefined ? fallback : value);
const rank = (value, values) => Math.max(0, values.indexOf(String(value || '').toLowerCase()));

function hydrate(row) {
  if (!row) return null;
  const result = { id: row.id, workspaceId: row.workspace_id, operationType: row.operation_type,
    domain: row.domain, sourceKind: row.source_kind, sourceId: row.source_id,
    idempotencyKey: row.idempotency_key, phase: row.phase, status: row.status,
    automatic: Boolean(row.automatic), title: row.title, summary: row.summary, link: row.link,
    errorMessage: row.error_message, attemptCount: row.attempt_count,
    createdAt: row.created_at, updatedAt: row.updated_at, authorizedAt: row.authorized_at,
    startedAt: row.started_at, completedAt: row.completed_at };
  for (const [key, column, fallback] of [['evidence','evidence',[]], ['understanding','understanding',{}],
    ['reasoning','reasoning',{}], ['alternatives','alternatives',[]], ['decision','decision',{}],
    ['affectedEntities','affected_entities',{}], ['authorityDimensions','authority_dimensions',{}],
    ['authoritySnapshot','authority_snapshot',{}], ['expectedOutcome','expected_outcome',{}],
    ['actualOutcome','actual_outcome',{}], ['verification','verification',{}],
    ['recovery','recovery',{}], ['learning','learning',{}]]) result[key] = parse(row[column], fallback);
  return result;
}

function find(db, workspaceId, id) {
  return hydrate(db.prepare('SELECT * FROM autonomous_operations WHERE workspace_id = ? AND id = ?').get(workspaceId, id));
}

function event(db, operation, type, detail = {}, actorId = null) {
  db.prepare(`INSERT INTO autonomous_operation_events
    (id, workspace_id, operation_id, phase, event_type, detail, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(newId('aoe'), operation.workspaceId, operation.id,
    operation.phase, type, encode(detail, {}), actorId, nowIso());
}

function create(db, ctx, input) {
  const definition = catalog.requireType(input.operationType);
  const now = nowIso();
  const key = String(input.idempotencyKey || '').trim();
  if (!key) throw new ValidationError('An idempotency key is required for autonomous work.');
  const id = newId('aop');
  db.prepare(`INSERT INTO autonomous_operations
    (id, workspace_id, operation_type, domain, source_kind, source_id, idempotency_key,
     phase, status, automatic, title, summary, link, evidence, understanding, reasoning,
     alternatives, decision, affected_entities, authority_dimensions, expected_outcome,
     created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'OBSERVE', 'PLANNED', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, operation_type, idempotency_key) DO NOTHING`).run(
    id, ctx.workspaceId, definition.type, definition.domain, input.sourceKind || null,
    input.sourceId || null, key, input.title || definition.title, input.summary || null,
    input.link || null, encode(input.evidence, []), encode(input.understanding, {}),
    encode(input.reasoning, {}), encode(input.alternatives, []), encode(input.decision, {}),
    encode(input.affectedEntities, {}), encode(input.authorityDimensions, {}),
    encode(input.expectedOutcome, {}), ctx.actorId || null, now, now);
  const operation = hydrate(db.prepare(`SELECT * FROM autonomous_operations
    WHERE workspace_id = ? AND operation_type = ? AND idempotency_key = ?`).get(ctx.workspaceId, definition.type, key));
  if (operation.id === id) event(db, operation, 'OPERATION_CREATED', { automatic: false }, ctx.actorId);
  return operation;
}

function record(db, operation, changes, eventType, detail = {}, actorId = null) {
  const allowed = { phase:'phase', status:'status', automatic:'automatic', authoritySnapshot:'authority_snapshot',
    actualOutcome:'actual_outcome', verification:'verification', recovery:'recovery', learning:'learning',
    errorMessage:'error_message', approvedByUserId:'approved_by_user_id', authorizedAt:'authorized_at',
    startedAt:'started_at', completedAt:'completed_at' };
  const sets = []; const values = [];
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed[key]) continue;
    sets.push(`${allowed[key]} = ?`);
    values.push(['authoritySnapshot','actualOutcome','verification','recovery','learning'].includes(key)
      ? encode(value, {}) : key === 'automatic' ? (value ? 1 : 0) : value);
  }
  sets.push('updated_at = ?'); values.push(nowIso(), operation.workspaceId, operation.id);
  db.prepare(`UPDATE autonomous_operations SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`).run(...values);
  const fresh = find(db, operation.workspaceId, operation.id);
  event(db, fresh, eventType, detail, actorId);
  return fresh;
}

function activeGrant(db, workspaceId, operationType) {
  const row = db.prepare(`SELECT * FROM autonomous_operation_authority
    WHERE workspace_id = ? AND operation_type = ? AND enabled = 1 AND revoked_at IS NULL
    ORDER BY version DESC LIMIT 1`).get(workspaceId, operationType);
  if (!row) return null;
  return { id: row.id, version: row.version, maximumQuantity: row.maximum_quantity,
    maximumValueMinor: row.maximum_value_minor, maximumDailyCount: row.maximum_daily_count,
    maximumDailyValueMinor: row.maximum_daily_value_minor, supplierIds: parse(row.supplier_ids, []),
    customerIds: parse(row.customer_ids, []), locationIds: parse(row.location_ids, []),
    allowedRoles: parse(row.allowed_roles, []), minimumConfidence: row.minimum_confidence,
    maximumRisk: row.maximum_risk, allowedTimeWindows: parse(row.allowed_time_windows, []) };
}

function grant(db, ctx, membership, operationType, bounds = {}) {
  permissions.assertCan(membership, permissions.ADMIN, 'grant StockChief autonomous authority');
  catalog.requireType(operationType);
  for (const key of ['maximumQuantity','maximumValueMinor','maximumDailyCount','maximumDailyValueMinor']) {
    if (bounds[key] !== undefined && bounds[key] !== null
        && (!Number.isFinite(Number(bounds[key])) || Number(bounds[key]) < 0)) {
      throw new ValidationError(`${key} must be a positive number or left blank.`);
    }
  }
  const previous = activeGrant(db, ctx.workspaceId, operationType);
  const now = nowIso();
  if (previous) db.prepare(`UPDATE autonomous_operation_authority SET enabled = 0,
    revoked_by_user_id = ?, revoked_at = ? WHERE id = ?`).run(ctx.actorId, now, previous.id);
  db.prepare(`INSERT INTO autonomous_operation_authority
    (id, workspace_id, operation_type, enabled, maximum_quantity, maximum_value_minor,
     maximum_daily_count, maximum_daily_value_minor, supplier_ids, customer_ids, location_ids,
     allowed_roles, minimum_confidence, maximum_risk, allowed_time_windows, version,
     supersedes_id, granted_by_user_id, granted_at, created_at)
    VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    newId('aog'), ctx.workspaceId, operationType, bounds.maximumQuantity ?? null,
    bounds.maximumValueMinor ?? null, bounds.maximumDailyCount ?? null,
    bounds.maximumDailyValueMinor ?? null, encode(bounds.supplierIds, []),
    encode(bounds.customerIds, []), encode(bounds.locationIds, []), encode(bounds.allowedRoles, []),
    bounds.minimumConfidence || null, bounds.maximumRisk || null, encode(bounds.allowedTimeWindows, []),
    (previous?.version || 0) + 1, previous?.id || null, ctx.actorId, now, now);
  return activeGrant(db, ctx.workspaceId, operationType);
}

function revoke(db, ctx, membership, operationType) {
  permissions.assertCan(membership, permissions.OPERATE, 'take autonomous authority away');
  catalog.requireType(operationType);
  db.prepare(`UPDATE autonomous_operation_authority SET enabled = 0, revoked_by_user_id = ?, revoked_at = ?
    WHERE workspace_id = ? AND operation_type = ? AND enabled = 1 AND revoked_at IS NULL`)
    .run(ctx.actorId, nowIso(), ctx.workspaceId, operationType);
  return null;
}

function approve(db, ctx, membership, operationId) {
  let operation = find(db, ctx.workspaceId, operationId);
  if (!operation) throw new ValidationError('That autonomous operation does not exist.');
  const definition = catalog.requireType(operation.operationType);
  permissions.assertCan(membership, definition.permission, `approve ${definition.title.toLowerCase()}`);
  operation = record(db, operation, { phase:'AUTHORIZE', status:'AUTHORIZED', automatic:false,
    approvedByUserId:ctx.actorId, authorizedAt:nowIso(), authoritySnapshot:{ kind:'human',
      permission:definition.permission, approvedByUserId:ctx.actorId } }, 'OWNER_AUTHORIZED', {}, ctx.actorId);
  return operation;
}

function evaluateAuthority(db, workspaceId, operation, { membership = null, now = new Date() } = {}) {
  const definition = catalog.requireType(operation.operationType);
  const state = modes.executionState(db, workspaceId, { scope: definition.domain });
  const grantRow = activeGrant(db, workspaceId, operation.operationType);
  const d = operation.authorityDimensions || {};
  const checks = [];
  const check = (name, passed, reason) => checks.push({ name, passed: Boolean(passed), reason });
  check('autopilot', state.allowed && state.automatic, state.because || 'Automatic mode is active.');
  check('explicitGrant', Boolean(grantRow), grantRow ? 'This operation has an explicit grant.' : 'This operation is off until an owner grants it.');
  if (membership) check('permission', permissions.can(membership, definition.permission), `Requires ${definition.permission}.`);
  if (grantRow) {
    const limited = (value, maximum) => maximum == null || (Number.isFinite(Number(value)) && Number(value) <= maximum);
    check('quantity', limited(d.quantity, grantRow.maximumQuantity), 'Quantity must be within the grant.');
    check('value', limited(d.valueMinor, grantRow.maximumValueMinor), 'Value must be within the grant.');
    for (const [name, value, allowed] of [['supplier', d.supplierId, grantRow.supplierIds],
      ['customer', d.customerId, grantRow.customerIds], ['location', d.locationId, grantRow.locationIds]])
      check(name, !allowed.length || (value && allowed.includes(value)), `${name} must be inside the grant.`);
    check('confidence', !grantRow.minimumConfidence || rank(d.confidence, ['low','medium','high']) >= rank(grantRow.minimumConfidence, ['low','medium','high']), 'Confidence is below the grant.');
    check('risk', !grantRow.maximumRisk || rank(d.risk || definition.risk, ['low','medium','high','critical']) <= rank(grantRow.maximumRisk, ['low','medium','high','critical']), 'Risk exceeds the grant.');
    check('role', !grantRow.allowedRoles.length || (membership && grantRow.allowedRoles.includes(membership.role)), 'Role is outside the grant.');
    const day = now.toISOString().slice(0, 10);
    const used = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(CAST(json_extract(authority_dimensions, '$.valueMinor') AS INTEGER)),0) value
      FROM autonomous_operations WHERE workspace_id = ? AND operation_type = ? AND automatic = 1
      AND status = 'COMPLETED' AND completed_at >= ?`).get(workspaceId, operation.operationType, `${day}T00:00:00.000Z`);
    check('dailyCount', grantRow.maximumDailyCount == null || used.n < grantRow.maximumDailyCount, 'Daily operation limit reached.');
    check('dailyValue', grantRow.maximumDailyValueMinor == null || used.value + Number(d.valueMinor || 0) <= grantRow.maximumDailyValueMinor, 'Daily value limit reached.');
    if (grantRow.allowedTimeWindows.length) {
      const hhmm = now.toISOString().slice(11, 16); const weekday = now.getUTCDay();
      check('time', grantRow.allowedTimeWindows.some((w) => (!w.days || w.days.includes(weekday)) && hhmm >= w.start && hhmm <= w.end), 'Current UTC time is outside the grant.');
    }
  }
  return { allowed: checks.every((item) => item.passed), definition, grant: grantRow, checks };
}

function registerAdapter(operationType, adapter) {
  catalog.requireType(operationType);
  if (!adapter || typeof adapter.execute !== 'function' || typeof adapter.verify !== 'function')
    throw new Error('An operation adapter must own execute and verify.');
  adapters.set(operationType, Object.freeze({ ...adapter }));
}

function registeredTypes() {
  return [...adapters.keys()].sort();
}

function normalizeAuthority(answer, definition) {
  if (!answer || typeof answer.allowed !== 'boolean') {
    throw new Error(`The ${definition.type} adapter did not return a deterministic authority decision.`);
  }
  const checks = Array.isArray(answer.checks) && answer.checks.length
    ? answer.checks
    : [{ name:'domainAuthority', passed:answer.allowed,
        reason:answer.because || (answer.allowed ? 'The domain authority allows this operation.' : 'Domain authority was not granted.') }];
  return { ...answer, definition, checks };
}

function authorityFor(db, ctx, membership, operation, adapter) {
  const definition = catalog.requireType(operation.operationType);
  const execution = modes.executionState(db, ctx.workspaceId, { scope: definition.domain });
  const manuallyAuthorized = operation.status === 'AUTHORIZED' && !operation.automatic && operation.authorizedAt;
  if (manuallyAuthorized) {
    return { manuallyAuthorized, authority:{ allowed:execution.allowed && permissions.can(membership, definition.permission),
      definition, grant:null, checks:[
        { name:'ownerApproval', passed:permissions.can(membership, definition.permission),
          reason:`A permitted person approved this operation (${definition.permission}).` },
        { name:'executionState', passed:execution.allowed,
          reason:execution.because || 'StockChief may execute approved work.' },
      ] } };
  }
  if (typeof adapter.authorize === 'function') {
    const answer = adapter.authorize({ db, ctx, membership, operation, definition, execution });
    if (answer && typeof answer.then === 'function') return answer.then((value) => ({
      manuallyAuthorized:false, authority:normalizeAuthority(value, definition),
    }));
    return { manuallyAuthorized:false, authority:normalizeAuthority(answer, definition) };
  }
  return { manuallyAuthorized:false,
    authority:evaluateAuthority(db, ctx.workspaceId, operation, { membership }) };
}

function intervene(db, operation, kind, reason) {
  const prior = db.prepare(`SELECT id FROM autonomous_operation_interventions
    WHERE operation_id = ? AND kind = ? AND resolved_at IS NULL`).get(operation.id, kind);
  if (!prior) db.prepare(`INSERT INTO autonomous_operation_interventions
    (id, workspace_id, operation_id, kind, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(newId('aoi'), operation.workspaceId, operation.id, kind, reason, nowIso());
}

function resolveInterventions(db, operation, resolution, actorId = null) {
  db.prepare(`UPDATE autonomous_operation_interventions SET resolution = ?, resolved_by_user_id = ?, resolved_at = ?
    WHERE operation_id = ? AND resolved_at IS NULL`).run(resolution, actorId, nowIso(), operation.id);
}

async function run(db, ctx, membership, operationId, runtime = {}) {
  let operation = find(db, ctx.workspaceId, operationId);
  if (!operation) throw new ValidationError('That autonomous operation does not exist.');
  if (operation.status === 'COMPLETED') return { operation, replayed: true };
  const adapter = adapters.get(operation.operationType);
  if (!adapter) throw new Error(`No deterministic adapter owns ${operation.operationType}.`);
  const resolvedAuthority = await authorityFor(db, ctx, membership, operation, {
    ...adapter,
    authorize:typeof adapter.authorize === 'function'
      ? (args) => adapter.authorize({ ...args, runtime }) : undefined,
  });
  const { manuallyAuthorized, authority } = resolvedAuthority;
  if (!authority.allowed) {
    const reason = authority.checks.filter((c) => !c.passed).map((c) => c.reason).join(' ');
    intervene(db, operation, 'AUTHORITY_REQUIRED', reason);
    operation = record(db, operation, { phase:'ESCALATE', status:'NEEDS_HUMAN', authoritySnapshot:authority }, 'AUTHORITY_DENIED', { reason }, ctx.actorId);
    return { operation, authority };
  }
  db.prepare('UPDATE autonomous_operations SET attempt_count = attempt_count + 1 WHERE id = ? AND workspace_id = ?')
    .run(operation.id, operation.workspaceId);
  operation = find(db, operation.workspaceId, operation.id);
  operation = record(db, operation, { phase:'EXECUTE', status:'RUNNING', automatic:!manuallyAuthorized,
    authoritySnapshot:authority, authorizedAt:nowIso(), startedAt:operation.startedAt || nowIso() }, 'EXECUTION_STARTED', {}, ctx.actorId);
  try {
    let actual = operation.actualOutcome;
    // Recovery first re-verifies the persisted effect. It never blindly repeats it.
    if (!actual || !Object.keys(actual).length) actual = await adapter.execute({ db, ctx, membership,
      operation, runtime, idempotencyKey: operation.idempotencyKey });
    operation = record(db, operation, { phase:'VERIFY', status:'VERIFYING', actualOutcome:actual }, 'EXECUTION_RECORDED');
    const verification = await adapter.verify({ db, ctx, membership, operation, actualOutcome:actual, runtime });
    if (!verification || verification.passed !== true) throw Object.assign(new Error(verification?.reason || 'The expected outcome could not be verified.'), { verification });
    resolveInterventions(db, operation, verification.reason || 'The operation reached its verified outcome.', ctx.actorId);
    operation = record(db, operation, { phase:'DONE', status:'COMPLETED', verification,
      learning:{ verifiedAt:nowIso() }, completedAt:nowIso() }, 'VERIFIED');
    return { operation, authority };
  } catch (error) {
    let verification = error.verification || { passed:false, reason:error.message };
    let recovery = {};
    if (typeof adapter.recover === 'function') {
      operation = record(db, operation, { phase:'RECOVER', status:'RECOVERING', verification }, 'RECOVERY_STARTED', verification);
      try {
        recovery = await adapter.recover({ db, ctx, membership, operation, actualOutcome:operation.actualOutcome, runtime,
          idempotencyKey:operation.idempotencyKey });
        operation = record(db, operation, { phase:'VERIFY', status:'VERIFYING', recovery }, 'RECOVERY_RECORDED');
        verification = await adapter.verify({ db, ctx, membership, operation, actualOutcome:operation.actualOutcome, recovery, runtime });
        if (verification?.passed === true) {
          resolveInterventions(db, operation, verification.reason || 'Recovery reached the expected outcome.', ctx.actorId);
          operation = record(db, operation, { phase:'DONE', status:'COMPLETED', verification,
            recovery, learning:{ recoveredAt:nowIso() }, completedAt:nowIso() }, 'RECOVERY_VERIFIED');
          return { operation, authority, recovered:true };
        }
      } catch (recoveryError) {
        recovery = { ...recovery, error:recoveryError.message };
        verification = { passed:false, reason:recoveryError.message };
      }
    }
    if (typeof adapter.compensate === 'function') {
      operation = record(db, operation, { phase:'COMPENSATE', status:'COMPENSATING', recovery }, 'COMPENSATION_STARTED');
      try {
        recovery = { ...recovery, compensation:await adapter.compensate({ db, ctx, membership, operation, runtime,
          actualOutcome:operation.actualOutcome, idempotencyKey:`${operation.idempotencyKey}:compensate` }) };
      } catch (compensationError) {
        recovery = { ...recovery, compensationError:compensationError.message };
      }
    }
    if (adapter.suspendOnFailure !== false && !modes.get(db, ctx.workspaceId).suspended) {
      modes.suspend(db, ctx.workspaceId, { scope: operation.domain, reason: verification.reason });
    }
    intervene(db, operation, 'VERIFICATION_FAILED', verification.reason);
    operation = record(db, operation, { phase:'ESCALATE', status:'NEEDS_HUMAN',
      verification, recovery, errorMessage:error.message }, 'VERIFICATION_FAILED', verification);
    return { operation, authority };
  }
}

/**
 * Synchronous form used by the established inventory planner. It has the same
 * contract and persistence as `run`; it merely rejects Promise-returning
 * adapters so the inventory event loop cannot accidentally become half-async.
 */
function runSync(db, ctx, membership, operationId, runtime = {}) {
  let operation = find(db, ctx.workspaceId, operationId);
  if (!operation) throw new ValidationError('That autonomous operation does not exist.');
  if (operation.status === 'COMPLETED') return { operation, replayed:true,
    result:operation.actualOutcome };
  const adapter = adapters.get(operation.operationType);
  if (!adapter) throw new Error(`No deterministic adapter owns ${operation.operationType}.`);
  const resolved = authorityFor(db, ctx, membership, operation, {
    ...adapter,
    authorize:typeof adapter.authorize === 'function'
      ? (args) => adapter.authorize({ ...args, runtime }) : undefined,
  });
  if (resolved && typeof resolved.then === 'function') {
    throw new Error(`${operation.operationType} has an asynchronous authority adapter and cannot run synchronously.`);
  }
  const { manuallyAuthorized, authority } = resolved;
  if (!authority.allowed) {
    const reason = authority.checks.filter((check) => !check.passed).map((check) => check.reason).join(' ');
    intervene(db, operation, 'AUTHORITY_REQUIRED', reason);
    operation = record(db, operation, { phase:'ESCALATE', status:'NEEDS_HUMAN',
      authoritySnapshot:authority }, 'AUTHORITY_DENIED', { reason }, ctx.actorId);
    return { operation, authority, result:null };
  }
  db.prepare('UPDATE autonomous_operations SET attempt_count = attempt_count + 1 WHERE id = ? AND workspace_id = ?')
    .run(operation.id, operation.workspaceId);
  operation = find(db, operation.workspaceId, operation.id);
  operation = record(db, operation, { phase:'EXECUTE', status:'RUNNING', automatic:!manuallyAuthorized,
    authoritySnapshot:authority, authorizedAt:nowIso(), startedAt:operation.startedAt || nowIso() },
  'EXECUTION_STARTED', {}, ctx.actorId);
  try {
    let actual = operation.actualOutcome;
    if (!actual || !Object.keys(actual).length) {
      actual = adapter.execute({ db, ctx, membership, operation, runtime,
        idempotencyKey:operation.idempotencyKey });
      if (actual && typeof actual.then === 'function') {
        throw new Error(`${operation.operationType} returned asynchronous work to runSync.`);
      }
    }
    operation = record(db, operation, { phase:'VERIFY', status:'VERIFYING', actualOutcome:actual },
      'EXECUTION_RECORDED');
    const verification = adapter.verify({ db, ctx, membership, operation, actualOutcome:actual, runtime });
    if (verification && typeof verification.then === 'function') {
      throw new Error(`${operation.operationType} returned asynchronous verification to runSync.`);
    }
    if (!verification || verification.passed !== true) {
      throw Object.assign(new Error(verification?.reason || 'The expected outcome could not be verified.'),
        { verification });
    }
    resolveInterventions(db, operation, verification.reason || 'The operation reached its verified outcome.', ctx.actorId);
    operation = record(db, operation, { phase:'DONE', status:'COMPLETED', verification,
      learning:{ verifiedAt:nowIso() }, completedAt:nowIso() }, 'VERIFIED');
    return { operation, authority, result:actual };
  } catch (error) {
    const verification = error.verification || { passed:false, reason:error.message };
    if (adapter.suspendOnFailure !== false && !modes.get(db, ctx.workspaceId).suspended) {
      modes.suspend(db, ctx.workspaceId, { scope:operation.domain, reason:verification.reason });
    }
    intervene(db, operation, 'VERIFICATION_FAILED', verification.reason);
    operation = record(db, operation, { phase:'ESCALATE', status:'NEEDS_HUMAN', verification,
      errorMessage:error.message }, 'VERIFICATION_FAILED', verification);
    return { operation, authority, result:operation.actualOutcome };
  }
}

function list(db, workspaceId, { statuses = null, limit = 50 } = {}) {
  const clauses = ['workspace_id = ?']; const args = [workspaceId];
  if (statuses?.length) { clauses.push(`status IN (${statuses.map(() => '?').join(',')})`); args.push(...statuses); }
  args.push(limit);
  return db.prepare(`SELECT * FROM autonomous_operations WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...args).map(hydrate);
}

const WORK_ITEM_TYPES = Object.freeze({
  balance_transfer:'transfer.request', replenishment_plan:'purchasing.prepare_order',
  replenishment:'purchasing.prepare_order', purchase_preparation:'purchasing.prepare_order',
  purchase_approval:'purchasing.place_order', receiving_followup:'purchasing.receive',
  discrepancy_review:'repair.execute',
});

/** Migration bridge: existing mature autopilot work participates in the same
 * trace immediately, while its deterministic runner remains the mutation owner. */
function mirrorWorkItem(db, item) {
  const operationType = WORK_ITEM_TYPES[item.category];
  if (!operationType) return null;
  let operation = create(db, { workspaceId:item.workspaceId, actorId:item.approvedByUserId || null }, {
    operationType, idempotencyKey:`work-item:${item.id}`, sourceKind:'work_item', sourceId:item.id,
    title:item.categoryLabel, summary:item.policyEvaluation?.reason || null,
    link:`/autopilot/work/${item.id}`, evidence:item.sourceEvidence,
    affectedEntities:item.affectedEntities, authorityDimensions:{
      quantity:Number(item.recommendedAction?.quantity || 0) || undefined,
      supplierId:item.recommendedAction?.supplierId || item.affectedEntities?.supplierId,
      locationId:item.recommendedAction?.locationId || item.recommendedAction?.toLocationId,
      confidence:item.confidence, risk:item.approvalRequirement === 'REQUIRED_WITH_WARNING' ? 'high' : 'medium',
    }, expectedOutcome:item.recommendedAction,
  });
  const mapped = {
    DETECTED:['OBSERVE','PLANNED'], PLANNED:['DECIDE','PLANNED'],
    WAITING_FOR_APPROVAL:['AUTHORIZE','WAITING_FOR_AUTHORITY'], AUTHORIZED:['AUTHORIZE','AUTHORIZED'],
    EXECUTING:['EXECUTE','RUNNING'], VERIFYING:['VERIFY','VERIFYING'],
    COMPLETED:['DONE','COMPLETED'], FAILED:['ESCALATE','FAILED'], BLOCKED:['ESCALATE','NEEDS_HUMAN'],
    CANCELLED:['DONE','CANCELLED'], SUPERSEDED:['DONE','CANCELLED'],
  }[item.executionStatus];
  const approvalMissing = Boolean(item.approvedAt && !operation.authorizedAt);
  if (!mapped || (operation.phase === mapped[0] && operation.status === mapped[1] && !approvalMissing)) return operation;
  const changes = { phase:mapped[0], status:mapped[1], automatic:item.isAutomatic,
    actualOutcome:item.outcome, verification:{ status:item.verificationStatus,
      passed:item.verificationStatus === 'VERIFIED' }, errorMessage:item.errorMessage };
  if (item.approvedAt) {
    changes.authorizedAt = item.approvedAt;
    changes.approvedByUserId = item.approvedByUserId || null;
  }
  if (mapped[1] === 'COMPLETED') changes.completedAt = item.completedAt || nowIso();
  operation = record(db, operation, changes, 'DOMAIN_STATE_CHANGED', {
    sourceKind:'work_item', sourceStatus:item.executionStatus,
  }, item.approvedByUserId || null);
  return operation;
}

module.exports = { create, find, list, grant, revoke, approve, activeGrant, evaluateAuthority,
  registerAdapter, registeredTypes, run, runSync, mirrorWorkItem, WORK_ITEM_TYPES };
