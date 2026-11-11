'use strict';

const source = require('./daily-cycle-count-source');
const policy = require('../commercial/agent-plan');
const time = require('../lib/business-time');
const audit = require('./postgres-security-audit');
const { ValidationError, AuthorizationError, NotFoundError } = require('../domain/errors');
const { newId } = require('../lib/util');
const { hash } = require('../pricing/postgres-promotions');
const jobKind = 'agent.daily-cycle-count.v1';
const action = 'inventory.plan_daily_cycle_count';

async function owner(db, ctx, lock = false) {
  const row = (await db.query(`SELECT w.owner_account_id FROM users u JOIN workspaces w
    ON w.id=u.workspace_id AND w.owner_account_id=u.account_id JOIN accounts a ON a.id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
    ${lock ? 'FOR SHARE OF a,u,w' : ''}`, [ctx.workspaceId, ctx.actorId])).rows[0];
  if (!row) throw new AuthorizationError('Only the current inventory owner can manage daily cycle-count plans.');
  return row.owner_account_id;
}

async function lockAuthority(db, ctx) {
  const accountId = await owner(db, ctx, true);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE', [accountId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE', [ctx.workspaceId]);
  await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=4 FOR SHARE', [ctx.workspaceId]);
}

async function authority(db, ctx, automatic) {
  await lockAuthority(db, ctx);
  const state = await policy.requireWorkspaceJob(db, ctx.workspaceId, 4, automatic ? 'automatic' : 'draft');
  const stopped = await policy.stopped(db, ctx.workspaceId, state, action, automatic);
  if (stopped) throw new ValidationError(stopped);
  if (automatic && !(await require('../autopilot/postgres-service').getState(db, ctx.workspaceId)).canAutomate)
    throw new ValidationError('Enable routine inventory work before scheduling daily count plans.');
}

function limit(raw) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) throw new ValidationError('Choose between one and 100 shelves for this daily plan.');
  return value;
}

function checkRevision(raw, actual) {
  if (!Number.isSafeInteger(Number(raw)) || Number(raw) !== actual) throw new ValidationError('This plan or rule changed. Reload the current version.');
}

async function rule(db, workspaceId, warehouseId, lock = false) {
  return (await db.query(`SELECT * FROM stockchief_runtime.daily_cycle_count_rules WHERE workspace_id=$1 AND warehouse_id=$2
    ${lock ? 'FOR UPDATE' : ''}`, [workspaceId, warehouseId])).rows[0] || null;
}

async function planForDay(db, workspaceId, warehouseId, day, lock = false) {
  return (await db.query(`SELECT *,business_day::text FROM stockchief_runtime.daily_cycle_count_plans
    WHERE workspace_id=$1 AND warehouse_id=$2 AND business_day=$3::date ${lock ? 'FOR UPDATE' : ''}`,
  [workspaceId, warehouseId, day])).rows[0] || null;
}

async function lockDay(db, workspaceId, warehouseId, day) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['cycle-count', workspaceId, warehouseId, day])]);
}

async function configure(db, ctx, input) {
  return db.transaction(async c => {
    await lockAuthority(c, ctx);
    const saved = await rule(c, ctx.workspaceId, input.warehouseId, true);
    checkRevision(input.revision, saved?.revision || 0);
    if (input.remove === 'yes') {
      if (saved) {
        await c.query('DELETE FROM stockchief_runtime.daily_cycle_count_rules WHERE workspace_id=$1 AND warehouse_id=$2',
          [ctx.workspaceId, input.warehouseId]);
        await audit.record(c, ctx, { action: 'Stopped daily cycle-count planning', reference: input.warehouseId });
      }
      return { removed: true };
    }
    await policy.requireWorkspaceJob(c, ctx.workspaceId, 4, 'automatic');
    if (input.confirmed !== 'yes') throw new ValidationError('Confirm the chosen warehouse and its maximum number of shelves.');
    const warehouse = await source.warehouse(c, ctx.workspaceId, input.warehouseId, true);
    const maximum = limit(input.maximumShelves);
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c, ctx, [], saved ? 0 : 1);
    await require('../commercial/storage-capacity').reserve(c, ctx.workspaceId, 'cycle-count-rule:' + warehouse.id, 8192, { finished: true });
    await c.query(`INSERT INTO stockchief_runtime.daily_cycle_count_rules(workspace_id,warehouse_id,maximum_shelves,authorized_by)
      VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,warehouse_id) DO UPDATE SET maximum_shelves=EXCLUDED.maximum_shelves,
      authorized_by=EXCLUDED.authorized_by,revision=daily_cycle_count_rules.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId, warehouse.id, maximum, ctx.actorId]);
    await audit.record(c, ctx, { action: 'Authorized daily cycle-count planning', reference: warehouse.id, after: { warehouse: warehouse.name, maximum } });
    return { warehouseId: warehouse.id };
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function store(db, ctx, snapshot, existing, { automatic = false, ruleRevision = null } = {}) {
  const { data, fingerprint } = snapshot;
  const id = existing?.id || newId('cycle-count-plan');
  const key = 'daily-cycle-plan:' + hash([data.warehouseId, data.day, fingerprint, automatic]);
  await require('../commercial/storage-capacity').reserve(db, ctx.workspaceId, key,
    8192 + Buffer.byteLength(JSON.stringify(data)) * 4, { finished: true });
  const status = automatic ? 'READY' : 'DRAFT';
  const args = [id, ctx.workspaceId, data.warehouseId, data.day, status, fingerprint, JSON.stringify(data), ctx.actorId, automatic, ruleRevision];
  const changed = await db.query(`INSERT INTO stockchief_runtime.daily_cycle_count_plans
    (id,workspace_id,warehouse_id,business_day,status,source_fingerprint,snapshot,authorized_by,automatic,rule_revision,confirmed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $9 THEN clock_timestamp() END)
    ON CONFLICT(workspace_id,warehouse_id,business_day) DO UPDATE SET status=EXCLUDED.status,
      source_fingerprint=EXCLUDED.source_fingerprint,snapshot=EXCLUDED.snapshot,authorized_by=EXCLUDED.authorized_by,
      automatic=EXCLUDED.automatic,rule_revision=EXCLUDED.rule_revision,confirmed_at=EXCLUDED.confirmed_at,
      revision=daily_cycle_count_plans.revision+1,updated_at=clock_timestamp()
    WHERE daily_cycle_count_plans.status='DRAFT' RETURNING id`, args);
  if (!changed.rowCount) return { id, replayed: true };
  await audit.record(db, ctx, { action: automatic ? 'Saved automatic daily cycle-count plan' : 'Prepared daily cycle-count draft',
    reference: id, after: { warehouseId: data.warehouseId, day: data.day, shelves: data.shelves.length, fingerprint, automatic } });
  return { id, replayed: false };
}

async function prepare(db, ctx, input) {
  return db.transaction(async c => {
    await authority(c, ctx, false);
    const place = await source.warehouse(c, ctx.workspaceId, input.warehouseId, true);
    const clock = await time.forWorkspace(c, ctx.workspaceId);
    await lockDay(c, ctx.workspaceId, place.id, clock.calendarDate);
    const saved = await planForDay(c, ctx.workspaceId, place.id, clock.calendarDate, true);
    if (saved?.status === 'READY') return { id: saved.id, replayed: true };
    const snapshot = await source.snapshot(c, ctx.workspaceId, place, clock, limit(input.maximumShelves));
    if (saved?.source_fingerprint === snapshot.fingerprint && saved.authorized_by === ctx.actorId)
      return { id: saved.id, replayed: true };
    checkRevision(input.revision, saved?.revision || 0);
    return store(c, ctx, snapshot, saved);
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function confirm(db, ctx, id, input) {
  return db.transaction(async c => {
    await authority(c, ctx, false);
    const saved = (await c.query('SELECT *,business_day::text FROM stockchief_runtime.daily_cycle_count_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
      [ctx.workspaceId, id])).rows[0];
    if (!saved) throw new NotFoundError('That daily count plan is not in this inventory.');
    if (saved.status === 'READY') return { id, replayed: true };
    checkRevision(input.revision, saved.revision);
    if (saved.authorized_by !== ctx.actorId || input.confirmed !== 'yes' || input.fingerprint !== saved.source_fingerprint)
      throw new ValidationError('Confirm this exact current draft as the owner who prepared it.');
    const place = await source.warehouse(c, ctx.workspaceId, saved.warehouse_id, true);
    const clock = await time.forWorkspace(c, ctx.workspaceId);
    if (saved.business_day !== clock.calendarDate) throw new ValidationError('Prepare a new plan for the current business day.');
    const current = await source.snapshot(c, ctx.workspaceId, place, clock, saved.snapshot.maximumShelves);
    if (current.fingerprint !== saved.source_fingerprint) throw new ValidationError('Shelf stock, valuation, classifications or discrepancies changed. Prepare a fresh draft.');
    await c.query(`UPDATE stockchief_runtime.daily_cycle_count_plans SET status='READY',confirmed_at=clock_timestamp(),
      updated_at=clock_timestamp(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [ctx.workspaceId, id]);
    await audit.record(c, ctx, { action: 'Confirmed daily cycle-count plan', reference: id,
      after: { warehouseId: place.id, day: saved.business_day, fingerprint: saved.source_fingerprint } });
    return { id, replayed: false };
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function enqueue(db, workspaceId, cycleId) {
  const state = await policy.accountState(db, workspaceId);
  if (!policy.usesAgentTerms(state) || !policy.permits(state.plan, 4, 'automatic') || await policy.stopped(db, workspaceId, state, action, true)
      || !(await require('../autopilot/postgres-service').getState(db, workspaceId)).canAutomate) return 0;
  const day = await time.today(db, workspaceId);
  const rows = (await db.query(`SELECT r.warehouse_id,r.revision,r.authorized_by FROM stockchief_runtime.daily_cycle_count_rules r
    JOIN workspaces w ON w.id=r.workspace_id AND w.deletion_requested_at IS NULL
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.account_id=w.owner_account_id AND u.role='owner'
    JOIN locations l ON l.workspace_id=r.workspace_id AND l.id=r.warehouse_id AND l.parent_location_id IS NULL AND l.is_active=1
      AND l.custody_agreement_id IS NULL
    LEFT JOIN stockchief_runtime.daily_cycle_count_plans p ON p.workspace_id=r.workspace_id AND p.warehouse_id=r.warehouse_id
      AND p.business_day=$2::date AND p.status='READY'
    WHERE r.workspace_id=$1 AND p.id IS NULL ORDER BY r.warehouse_id`, [workspaceId, day])).rows;
  const queue = require('./postgres-job-queue');
  for (const row of rows) {
    await queue.enqueue(db, { workspaceId, kind: jobKind, idempotencyKey: 'daily-cycle:' + hash([day, row.warehouse_id, row.revision, cycleId]),
      payload: { day, warehouseId: row.warehouse_id, revision: row.revision, actorId: row.authorized_by }, priority: 65, maxAttempts: 3 });
  }
  return rows.length;
}

async function work(db, workspaceId, input) {
  const ctx = { workspaceId, actorId: input.actorId };
  await db.query('SAVEPOINT daily_cycle_count');
  try {
    await authority(db, ctx, true);
    const savedRule = await rule(db, workspaceId, input.warehouseId, true);
    if (!savedRule || savedRule.revision !== input.revision || savedRule.authorized_by !== ctx.actorId)
      throw new ValidationError('The owner’s warehouse rule changed before daily planning.');
    const place = await source.warehouse(db, workspaceId, input.warehouseId, true);
    const clock = await time.forWorkspace(db, workspaceId);
    if (input.day !== clock.calendarDate) throw new ValidationError('This daily plan belongs to an earlier business date.');
    await lockDay(db, workspaceId, place.id, clock.calendarDate);
    const existing = await planForDay(db, workspaceId, place.id, clock.calendarDate, true);
    let result = { id: existing?.id, replayed: true };
    if (existing?.status !== 'READY') {
      const month = clock.calendarDate.slice(0, 7) + '-01';
      if (!(await db.query('SELECT 1 FROM stockchief_runtime.product_class_months WHERE workspace_id=$1 AND month_start=$2', [workspaceId, month])).rowCount)
        await require('../forecasting/monthly-product-classes').calculate(db, workspaceId);
      const snapshot = await source.snapshot(db, workspaceId, place, clock, savedRule.maximum_shelves);
      result = await store(db, ctx, snapshot, existing, { automatic: true, ruleRevision: savedRule.revision });
    }
    await db.query('RELEASE SAVEPOINT daily_cycle_count');
    return result;
  } catch (error) {
    if (!['validation_error','entitlement_required','forbidden'].includes(error.code)) throw error;
    await db.query('ROLLBACK TO SAVEPOINT daily_cycle_count');
    await db.query('RELEASE SAVEPOINT daily_cycle_count');
    return { held: error.message };
  }
}

async function page(db, ctx, input = {}) {
  await owner(db, ctx);
  const state = await policy.requireWorkspaceJob(db, ctx.workspaceId, 4, 'draft');
  const clock = await time.forWorkspace(db, ctx.workspaceId);
  const warehouses = await source.warehouses(db, ctx.workspaceId);
  let current = null;
  if (input.id) {
    current = (await db.query(`SELECT *,business_day::text FROM stockchief_runtime.daily_cycle_count_plans
      WHERE workspace_id=$1 AND id=$2`, [ctx.workspaceId, input.id])).rows[0];
    if (!current) throw new NotFoundError('That daily count plan is not in this inventory.');
  }
  const chosen = current?.warehouse_id || input.warehouseId;
  const place = chosen ? warehouses.find(w => w.id === chosen) || null : warehouses[0] || null;
  if (input.warehouseId && !place && !current) throw new ValidationError('Choose an active warehouse in this inventory.');
  if (!current && place) current = await planForDay(db, ctx.workspaceId, place.id, clock.calendarDate);
  const history = (await db.query(`SELECT id,business_day::text,status,snapshot->>'warehouse' warehouse
    FROM stockchief_runtime.daily_cycle_count_plans WHERE workspace_id=$1 ORDER BY business_day DESC,updated_at DESC,id LIMIT 30`,
  [ctx.workspaceId])).rows;
  return { day: clock.calendarDate, place, warehouses, current, history, currentRule: place ? await rule(db, ctx.workspaceId, place.id) : null,
    automatic: policy.permits(state.plan, 4, 'automatic'), blocked: await policy.stopped(db, ctx.workspaceId, state, action, false) };
}

async function review(db, ctx, { filter, page: number }) {
  await owner(db, ctx);
  const state = await policy.accountState(db, ctx.workspaceId);
  const starter = policy.allowance(state.plan, 4) === 'suggest';
  const clock = await time.forWorkspace(db, ctx.workspaceId);
  const rows = await source.shelves(db, ctx.workspaceId, { clock, filter, limit: starter ? 1 : 101, offset: (number - 1) * 100 });
  return { cyclePlan: !starter, more: rows.length > 100,
    summary: 'Rank shelves using negative positions, unresolved counts, recent corrections, monthly A and B classes, and verified stock value.',
    rows: rows.slice(0,100).map(row => {
      const p = source.summary(row);
      return { Shelf: p.shelf, Warehouse: p.warehouse, SKU: p.sku, Product: p.product, Positions: p.positions, 'Recorded units': p.quantity,
        'Stocking unit': p.unit, 'Recent adjustments': p.recentAdjustments, 'Verified stock value': source.displayValue(p), Reason: p.reason };
    }) };
}

module.exports = { action, jobKind, configure, prepare, confirm, enqueue, work, page, review, displayValue: source.displayValue };
