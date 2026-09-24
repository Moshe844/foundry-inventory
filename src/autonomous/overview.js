'use strict';

const operations = require('./service');

const ACTIVE = ['PLANNED', 'AUTHORIZED', 'RUNNING', 'VERIFYING', 'RECOVERING', 'COMPENSATING'];
const PHASE_COPY = { OBSERVE:'observing',UNDERSTAND:'reviewing',DECIDE:'deciding',PLAN:'planning',
  SIMULATE:'checking',AUTHORIZE:'checking authority for',EXECUTE:'executing',VERIFY:'verifying',
  RECOVER:'recovering',COMPENSATE:'reconciling',LEARN:'learning from',ESCALATE:'escalating' };

/**
 * One customer-facing view over every durable kind of work. Domain engines
 * keep their own state; this projection stops Brief from mistaking “not in the
 * old work_items table” for “nothing is happening.”
 */
function inProgress(db, workspaceId, { limit = 25 } = {}) {
  const result = operations.list(db, workspaceId, { statuses: ACTIVE, limit }).map((op) => ({
    id: `operation:${op.id}`, title: op.title, because: op.summary || `StockChief is ${PHASE_COPY[op.phase] || 'reviewing'} this now.`,
    link: op.link || `/autopilot/history#operation-${op.id}`, action: 'See work', status: op.status,
  }));
  const known = new Set(operations.list(db, workspaceId, { statuses: ACTIVE, limit: 200 })
    .filter((op) => op.sourceKind && op.sourceId).map((op) => `${op.sourceKind}:${op.sourceId}`));
  const append = (kind, rows, shape) => rows.forEach((row) => {
    if (result.length < limit && !known.has(`${kind}:${row.id}`)) result.push(shape(row));
  });
  append('work_item', db.prepare(`SELECT id, category, execution_status AS status, policy_evaluation FROM work_items
    WHERE workspace_id = ? AND execution_status IN ('DETECTED','PLANNED','AUTHORIZED','EXECUTING','VERIFYING')
    ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`work:${row.id}`, title:String(row.category).replaceAll('_',' '),
      because:'StockChief is working through this now.', link:`/autopilot/work/${row.id}`, action:'See work', status:row.status,
    }));
  append('runtime_job', db.prepare(`SELECT id, kind, status FROM runtime_jobs WHERE workspace_id = ?
    AND status IN ('PENDING','RUNNING','RETRY') ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`job:${row.id}`, title:String(row.kind).replaceAll('_',' '),
      because:row.status === 'RETRY' ? 'A safe retry is waiting.' : 'Durable background work is active.',
      link:'/settings/operations', action:'See operation', status:row.status,
    }));
  append('ui_job', db.prepare(`SELECT id, description, kind, status FROM foundry_ui_jobs WHERE workspace_id = ?
    AND status IN ('queued','running') ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`ui:${row.id}`, title:row.description || String(row.kind).replaceAll('_',' '),
      because:'StockChief is still working on your request.', link:'/ask', action:'See request', status:row.status,
    }));
  append('accounting_shadow', db.prepare(`SELECT id, connector_id, status FROM accounting_shadow_runs
    WHERE workspace_id = ? AND status = 'RUNNING' ORDER BY started_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`shadow:${row.id}`, title:'Checking accounting before enabling writes',
      because:'StockChief is comparing both books without changing either one.',
      link:`/settings/connections/${row.connector_id}`, action:'See connection', status:row.status,
    }));
  append('connection_sync', db.prepare(`SELECT id, connector_id, sync_kind, status FROM connection_sync_runs
    WHERE workspace_id = ? AND status = 'RUNNING' ORDER BY started_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`sync:${row.id}`, title:`Syncing ${String(row.sync_kind).replaceAll('_',' ')}`,
      because:'StockChief is reading provider activity now.', link:`/settings/connections/${row.connector_id}`,
      action:'See connection', status:row.status,
    }));
  append('repair_case', db.prepare(`SELECT id, symptom, status FROM repair_cases WHERE workspace_id = ?
    AND status IN ('EXECUTING','VERIFYING') ORDER BY updated_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`repair:${row.id}`, title:row.symptom, because:'StockChief is repairing and verifying this inconsistency.',
      link:`/repairs/${row.id}`, action:'See repair', status:row.status,
    }));
  append('import_plan', db.prepare(`SELECT id, source_name, status FROM import_plans WHERE workspace_id = ?
    AND status IN ('ANALYSING','EXECUTING') ORDER BY created_at DESC LIMIT ?`).all(workspaceId, limit), (row) => ({
      id:`import:${row.id}`, title:`Importing ${row.source_name}`, because:'StockChief is processing your records.',
      link:`/imports/${row.id}`, action:'See import', status:row.status,
    }));
  return result.slice(0, limit);
}

function completed(db, workspaceId, since, { limit = 25 } = {}) {
  return operations.list(db, workspaceId, { statuses:['COMPLETED'], limit:200 })
    .filter((op) => op.completedAt >= since && op.sourceKind !== 'work_item')
    .slice(0, limit).map((op) => ({ id:op.id, headline:op.title,
      detail:op.verification.reason || op.summary || 'StockChief completed and verified the expected result.',
      link:op.link || `/autopilot/history#operation-${op.id}`, verified:true }));
}

module.exports = { inProgress, completed };
