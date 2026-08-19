'use strict';

const { nowIso } = require('../lib/util');

const json = (value, fallback) => {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
};

function get(db, workspaceId, userId) {
  const row = db.prepare('SELECT * FROM manager_contexts WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  if (!row) return { lastIntentClass: null, lastWorkItemId: null, lastPurchaseOrderId: null, lastInvestigationId: null, lastEntities: {}, recentTurns: [] };
  return {
    lastIntentClass: row.last_intent_class,
    lastWorkItemId: row.last_work_item_id,
    lastPurchaseOrderId: row.last_purchase_order_id,
    lastInvestigationId: row.last_investigation_id,
    lastEntities: json(row.last_entities, {}),
    recentTurns: json(row.recent_turns, []),
    updatedAt: row.updated_at,
  };
}

function remember(db, ctx, update) {
  const current = get(db, ctx.workspaceId, ctx.actorId);
  const turns = [...current.recentTurns, ...(update.turn ? [update.turn] : [])].slice(-8);
  db.prepare(
    `INSERT INTO manager_contexts
       (workspace_id, user_id, last_intent_class, last_work_item_id, last_purchase_order_id,
        last_investigation_id, last_entities, recent_turns, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, user_id) DO UPDATE SET
       last_intent_class=excluded.last_intent_class,
       last_work_item_id=excluded.last_work_item_id,
       last_purchase_order_id=excluded.last_purchase_order_id,
       last_investigation_id=excluded.last_investigation_id,
       last_entities=excluded.last_entities, recent_turns=excluded.recent_turns, updated_at=excluded.updated_at`
  ).run(ctx.workspaceId, ctx.actorId,
    update.intentClass ?? current.lastIntentClass,
    update.workItemId ?? current.lastWorkItemId,
    update.purchaseOrderId ?? current.lastPurchaseOrderId,
    update.investigationId ?? current.lastInvestigationId,
    JSON.stringify(update.entities ?? current.lastEntities), JSON.stringify(turns), nowIso());
  return get(db, ctx.workspaceId, ctx.actorId);
}

function snapshot(db, ctx) {
  const conversation = get(db, ctx.workspaceId, ctx.actorId);
  const openWork = db.prepare(
    `SELECT id, category, execution_status, recommended_action FROM work_items WHERE workspace_id = ?
      AND execution_status NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at DESC LIMIT 8`
  ).all(ctx.workspaceId).map((row) => ({ id: row.id, category: row.category, status: row.execution_status }));
  const openInvestigations = db.prepare(
    `SELECT id, trigger, status, affected_entities FROM inventory_investigations WHERE workspace_id = ?
      AND status NOT IN ('RESOLVED') ORDER BY updated_at DESC LIMIT 8`
  ).all(ctx.workspaceId).map((row) => ({ id: row.id, trigger: row.trigger, status: row.status }));
  return { conversation, openWork, openInvestigations };
}

module.exports = { get, remember, snapshot };
