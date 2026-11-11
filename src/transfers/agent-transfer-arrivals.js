'use strict';

const policy = require('../commercial/agent-plan');
const permissions = require('../actions/permissions');
const warehouse = require('../operations/postgres-warehouse-access');
const businessTime = require('../lib/business-time');
const { AuthorizationError, ValidationError } = require('../domain/errors');

const ACTIVE = "('SHIPPED','IN_TRANSIT','PARTIALLY_RECEIVED')";
const outstanding = 'l.shipped_quantity-l.received_quantity-l.lost_quantity-l.damaged_quantity';
const unsettled = `EXISTS(SELECT 1 FROM inventory_transfer_lines l
  WHERE l.workspace_id=t.workspace_id AND l.transfer_id=t.id AND ${outstanding}>0)`;
const FOLLOW_UP = 'ARRIVAL_FOLLOW_UP_CHECKED';
const checkKey = (id, day) => `transfer-arrival-check:${id}:${day}`;
const isDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10) === day;
const expectedDate = `CASE WHEN t.expected_arrival_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
  AND pg_input_is_valid(t.expected_arrival_date,'date') THEN t.expected_arrival_date::date END`;

function dispatchDay(zone) {
  return `CASE WHEN pg_input_is_valid(t.shipped_at,'timestamptz')
    THEN (t.shipped_at::timestamptz AT TIME ZONE ${zone})::date END`;
}

function due(zone) {
  return `(${expectedDate}<$3::date OR (${expectedDate} IS NULL AND ${dispatchDay(zone)}<$3::date))`;
}

function candidates(zone) {
  // A missing ETA has no promised date. Ask for it after the dispatch day
  // passes in the inventory's business time zone.
  return `SELECT 124,'Transfer',t.transfer_number,'/transfers/'||t.id,
      coalesce(${expectedDate},${dispatchDay(zone)}+1)
    FROM inventory_transfers t WHERE t.workspace_id=$1 AND t.status IN ${ACTIVE} AND ${unsettled} AND ${due(zone)}`;
}

async function enabled(db, workspaceId, account, { lock = false } = {}) {
  if (!policy.usesAgentTerms(account) || !policy.permits(account.plan, 124, 'automatic') || account.shadow) return false;
  if (lock) {
    await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE',[workspaceId]);
    await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[workspaceId]);
    await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE',[workspaceId]);
    await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=124 FOR SHARE',[workspaceId]);
    const current = await policy.accountState(db, workspaceId);
    if (!policy.usesAgentTerms(current) || !policy.permits(current.plan,124,'automatic') || current.shadow) return false;
  }
  const result = await db.query(`SELECT w.deletion_requested_at, a.mode, a.paused, a.suspended,
    EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=w.id AND u.account_id=w.owner_account_id AND u.role='owner') has_owner
    FROM workspaces w LEFT JOIN workspace_autopilot a ON a.workspace_id=w.id WHERE w.id=$1`, [workspaceId]);
  const state = result.rows[0];
  if (!state?.has_owner || state.deletion_requested_at || state.mode === 'OBSERVE' || Number(state.paused) || Number(state.suspended)) return false;
  return !(await require('../autopilot/job-modes').restriction(db, workspaceId, 124, true));
}

async function receiver(db, ctx, { lock = false } = {}) {
  const actor = (await db.query(`SELECT u.role,u.permissions,u.warehouse_location_ids,u.account_id,w.owner_account_id
    FROM users u JOIN workspaces w ON w.id=u.workspace_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)${lock ? ' FOR SHARE OF u,w' : ''}`,
  [ctx.workspaceId, ctx.actorId])).rows[0];
  if (!actor || actor.role === 'owner' && actor.account_id !== actor.owner_account_id ||
      !permissions.can(actor, permissions.VIEW_TRANSFERS) || !permissions.can(actor, permissions.RECEIVE_TRANSFER)) return null;
  if (actor.role === 'owner') return { owner: true, locations: null };
  const roots = actor.warehouse_location_ids;
  const allowed = roots === null ? null : (await warehouse.locations(db, ctx.workspaceId, roots)).map(l => l.id);
  return { owner: false, locations: allowed };
}

// Re-read the live transfer against each scheduled notice. A transfer settled,
// rescheduled or moved out of a person's scope no longer asks them to act.
function openNotices(zone) {
  return `FROM stockchief_runtime.agent_operational_notices n
    JOIN inventory_transfers t ON t.workspace_id=n.workspace_id AND t.id=substring(n.link from 12)
    JOIN locations dst ON dst.workspace_id=t.workspace_id AND dst.id=t.destination_location_id
    JOIN locations src ON src.workspace_id=t.workspace_id AND src.id=t.source_location_id
    WHERE n.workspace_id=$1 AND n.job_id=124 AND n.kind='Transfer' AND NOT n.resolved
      AND t.status IN ${ACTIVE} AND ${unsettled}
      AND ($2::text[] IS NULL OR t.destination_location_id=ANY($2))
      AND ${due(zone)}`;
}

const checked = `EXISTS(SELECT 1 FROM inventory_transfer_events e
  WHERE e.workspace_id=t.workspace_id AND e.idempotency_key='transfer-arrival-check:'||t.id||':'||n.last_reminded::text)`;

async function inbox(db, workspaceId, access, account) {
  if (!access || !await enabled(db, workspaceId, account)) return [];
  const { calendarDate, timeZone } = await businessTime.forWorkspace(db, workspaceId);
  const rows = (await db.query(`SELECT t.destination_location_id, dst.name AS destination,
    count(*)::int AS count,min(${expectedDate})::text AS due
    ${openNotices('$4')}${access.owner ? '' : ' AND NOT ' + checked}
    GROUP BY t.destination_location_id,dst.name ORDER BY min(${expectedDate}) NULLS LAST,dst.name,t.destination_location_id`,
  [workspaceId, access.locations, calendarDate, timeZone])).rows;
  if (access.owner && rows.length) return [{
    kind: 'inventory', grouped: true, importance: 'Important', priority: 80,
    title: 'Overdue warehouse transfers',
    happened: `${rows.reduce((sum, row) => sum + row.count, 0)} transfer arrivals need follow-through.`,
    why: 'A scheduled check found open dispatched stock past its expected arrival or without a recorded arrival date.',
    recommendation: 'Review what each receiving warehouse still needs to confirm.',
    href: '/autopilot/reviews/transfer-arrivals', actionLabel: 'Review transfers',
    sourceId: 'agent-notice-124', dueDate: rows[0].due,
  }];
  return rows.map(row => ({
    kind: 'inventory', grouped: true, importance: 'Important', priority: 80,
    title: `Transfers awaiting receipt at ${row.destination}`,
    happened: `${row.count} transfer${row.count === 1 ? '' : 's'} need a receiving check.`,
    why: 'Dispatched stock remains open past its expected arrival or has no recorded arrival date.',
    recommendation: 'Record the stock that arrived or confirm that you checked and are still waiting.',
    href: '/transfers/arrival-follow-up?location=' + encodeURIComponent(row.destination_location_id),
    actionLabel: 'Check incoming transfers', sourceId: 'transfer-arrival:' + row.destination_location_id,
    dueDate: row.due, requiredPermissions: [permissions.VIEW_TRANSFERS, permissions.RECEIVE_TRANSFER],
  }));
}

async function page(db, ctx, { locationId = '', page = 1 } = {}) {
  await policy.requireWorkspaceJob(db, ctx.workspaceId, 124, 'suggest');
  const access = await receiver(db, ctx);
  if (!access) throw new AuthorizationError('Receiving transfer follow-ups requires permission to view and receive transfers.');
  if (locationId && access.locations && !access.locations.includes(locationId)) throw new AuthorizationError('This receiving location is outside your assigned warehouses.');
  const number = Number(page);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1000000) throw new ValidationError('Choose a valid transfer page.');
  const { calendarDate, timeZone } = await businessTime.forWorkspace(db, ctx.workspaceId);
  const account = await policy.accountState(db, ctx.workspaceId);
  if (!await enabled(db, ctx.workspaceId, account)) return { rows: [], more: false, page: number, locationId };
  const rows = (await db.query(`WITH selected AS (
    SELECT t.id,t.transfer_number,(${expectedDate})::text AS expected_arrival_date,t.shipped_at,dst.name AS destination,
      src.name AS source,n.last_reminded::text AS reminder_day,n.reminders,${checked} AS checked
    ${openNotices('$4')}
    AND ($5='' OR t.destination_location_id=$5)
    ORDER BY checked,expected_arrival_date NULLS LAST,t.shipped_at,t.id LIMIT 101 OFFSET $6
  ) SELECT p.*,coalesce(lines.detail,'[]'::jsonb) lines FROM selected p
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object(
    'code',s.code,'name',i.name,'unit',i.unit_label,'secondaryUnit',i.secondary_unit_label,
    'shipped',l.shipped_quantity::text,'received',l.received_quantity::text,
    'lost',l.lost_quantity::text,'damaged',l.damaged_quantity::text,'outstanding',(${outstanding})::text,
    'secondaryOutstanding',(l.shipped_secondary_quantity-l.received_secondary_quantity-l.lost_secondary_quantity-l.damaged_secondary_quantity)::text,
    'lot',lot.code,'serials',(SELECT jsonb_agg(u.serial ORDER BY u.serial)
      FROM inventory_transfer_serials x JOIN serial_units u ON u.workspace_id=x.workspace_id AND u.id=x.serial_unit_id
      WHERE x.workspace_id=l.workspace_id AND x.transfer_line_id=l.id AND x.state='IN_TRANSIT')
    ) ORDER BY s.code,l.id) detail
    FROM inventory_transfer_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN lots lot ON lot.workspace_id=l.workspace_id AND lot.id=l.lot_id
    WHERE l.workspace_id=$1 AND l.transfer_id=p.id) lines ON true
  ORDER BY p.checked,p.expected_arrival_date NULLS LAST,p.shipped_at,p.id`,
  [ctx.workspaceId, access.locations, calendarDate, timeZone, locationId, (number - 1) * 100])).rows;
  return { rows: rows.slice(0, 100), more: rows.length > 100, page: number, locationId };
}

async function check(db, ctx, transferId, reminderDay) {
  return db.transaction(async client => {
    const account = await policy.requireWorkspaceJob(client, ctx.workspaceId, 124, 'suggest');
    const access = await receiver(client, ctx, { lock: true });
    if (!access) throw new AuthorizationError('Receiving transfer follow-ups requires permission to view and receive transfers.');
    if (!await enabled(client, ctx.workspaceId, account, { lock: true })) {
      throw new ValidationError('Transfer follow-ups are paused. Use the transfer to record any physical receipt.');
    }
    return require('./postgres-transfer-service').recordArrivalCheck(client, ctx, transferId, reminderDay, access.locations);
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

module.exports = { unsettled, expectedDate, FOLLOW_UP, checkKey, isDay, candidates, enabled, receiver, inbox, page, check };
