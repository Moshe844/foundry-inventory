'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const inventory = require('../domain/inventory-engine');
const itemService = require('../domain/item-service');
const { ValidationError, NotFoundError, AuthorizationError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

function json(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function matchesInstruction(message) {
  const text = String(message || '');
  // Explicit PDF/document wording belongs to the document-intake provenance
  // flow, which can also reverse its receipt movements. This service owns the
  // tabular import pipeline and relative phrases with no named document.
  if (/\b(pdf|document)\b/i.test(text)) return false;
  const remove = /\b(delete|remove|undo|roll\s*back|take\s+out|archive)\b/i.test(text);
  const records = /\b(items?|products?|records?|inventory)\b/i.test(text);
  const recent = /\b(newly|recently|just|latest|last)\b/i.test(text)
    && /\b(add(?:ed)?|creat(?:ed)?|import(?:ed)?)\b/i.test(text);
  const importSource = /\b(last|latest|recent|earlier|previous)\s+(?:spreadsheet|sheet|import|upload)\b/i.test(text);
  return remove && records && (recent || importSource);
}

function createdItemIds(db, importId) {
  const rows = db.prepare(`SELECT item_id, parsed FROM import_rows
    WHERE import_id = ? AND status = 'IMPORTED' AND item_id IS NOT NULL
    ORDER BY row_number`).all(importId);
  const ids = [];
  for (const row of rows) {
    const parsed = json(row.parsed, {});
    // An existingItemId means this import updated or added stock to a product
    // that pre-dated the file. It is never eligible for source rollback.
    if (parsed.existingItemId) continue;
    if (!ids.includes(row.item_id)) ids.push(row.item_id);
  }
  return ids;
}

function relevantImport(db, workspaceId, instruction) {
  const plans = db.prepare(`SELECT * FROM import_plans
    WHERE workspace_id = ? AND status IN ('SUCCEEDED','PARTIAL')
    ORDER BY COALESCE(completed_at, created_at) DESC`).all(workspaceId);
  const stated = String(instruction || '').toLowerCase();
  const named = plans.find((plan) => stated.includes(String(plan.source_name || '').toLowerCase()));
  const ordered = named ? [named, ...plans.filter((plan) => plan.id !== named.id)] : plans;
  for (const plan of ordered) {
    const ids = createdItemIds(db, plan.id);
    if (ids.length) return { plan, itemIds: ids };
  }
  return null;
}

function snapshotFor(db, workspaceId, plan, itemIds) {
  const items = [];
  for (const id of itemIds) {
    const item = db.prepare('SELECT * FROM items WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    if (!item) continue;
    const variants = db.prepare(`SELECT s.id, s.code, s.variant_label,
        COALESCE(SUM(b.on_hand), 0) AS on_hand
      FROM skus s LEFT JOIN balances b ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.item_id = ?
      GROUP BY s.id ORDER BY s.position`).all(workspaceId, id);
    const locations = db.prepare(`SELECT s.id AS sku_id, l.id AS location_id, l.name, b.on_hand
      FROM skus s JOIN balances b ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
      JOIN locations l ON l.id = b.location_id AND l.workspace_id = b.workspace_id
      WHERE s.workspace_id = ? AND s.item_id = ? AND b.on_hand <> 0
      ORDER BY l.name, s.position`).all(workspaceId, id);
    items.push({
      id: item.id,
      name: item.name,
      baseCode: item.base_code,
      active: Boolean(item.is_active),
      variants,
      locations,
      onHand: variants.reduce((sum, variant) => sum + Number(variant.on_hand || 0), 0),
    });
  }
  return {
    source: {
      id: plan.id,
      sourceName: plan.source_name,
      completedAt: plan.completed_at || plan.created_at,
    },
    items,
    productCount: items.length,
    variantCount: items.reduce((sum, item) => sum + item.variants.length, 0),
    onHand: items.reduce((sum, item) => sum + item.onHand, 0),
  };
}

function integrityHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    importPlanId: row.import_plan_id,
    instruction: row.instruction,
    snapshot: json(row.snapshot, {}),
    integrityHash: row.integrity_hash,
    status: row.status,
    result: json(row.result, {}),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM import_removal_proposals WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That import-removal review is not in this inventory.');
  return hydrate(row);
}

function create(db, ctx, membership, instruction) {
  const found = relevantImport(db, ctx.workspaceId, instruction);
  if (!found) {
    throw new ValidationError('Foundry could not find a recent completed import that created products. Nothing was removed.');
  }
  const snapshot = snapshotFor(db, ctx.workspaceId, found.plan, found.itemIds);
  const activeItems = snapshot.items.filter((item) => item.active);
  if (!activeItems.length) {
    throw new ValidationError(`${found.plan.source_name} has no active products left to remove. Nothing was removed.`);
  }
  snapshot.items = activeItems;
  snapshot.productCount = activeItems.length;
  snapshot.variantCount = activeItems.reduce((sum, item) => sum + item.variants.length, 0);
  snapshot.onHand = activeItems.reduce((sum, item) => sum + item.onHand, 0);
  const hash = integrityHash(snapshot);
  const existing = db.prepare(`SELECT * FROM import_removal_proposals
    WHERE workspace_id = ? AND import_plan_id = ? AND integrity_hash = ? AND status = 'PENDING'
    ORDER BY created_at DESC LIMIT 1`).get(ctx.workspaceId, found.plan.id, hash);
  if (existing) return hydrate(existing);
  const id = newId('irp');
  db.prepare(`INSERT INTO import_removal_proposals
    (id, workspace_id, import_plan_id, requested_by_user_id, instruction, snapshot,
     integrity_hash, status, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', '{}', ?)`).run(
      id, ctx.workspaceId, found.plan.id, membership.id, instruction,
      JSON.stringify(snapshot), hash, nowIso()
    );
  return get(db, ctx.workspaceId, id);
}

function selectedIds(input) {
  const values = Array.isArray(input) ? input : input ? [input] : [];
  return [...new Set(values.map(String).filter(Boolean))];
}

function approve(db, ctx, membership, id, expectedHash, requestedItemIds) {
  if (!membership || membership.role !== 'owner') {
    throw new AuthorizationError('Only an owner can remove imported products.');
  }
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'COMPLETED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That removal was cancelled.');
  if (!expectedHash || expectedHash !== proposal.integrityHash) {
    throw new ValidationError('The removal preview changed. Review it again before approving.');
  }
  const ids = selectedIds(requestedItemIds);
  if (!ids.length) throw new ValidationError('Select at least one product to remove.');
  const allowed = new Set(proposal.snapshot.items.map((item) => item.id));
  if (ids.some((itemId) => !allowed.has(itemId))) {
    throw new ValidationError('One of the selected products was not in this import review. Nothing was removed.');
  }
  const plan = db.prepare('SELECT * FROM import_plans WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, proposal.importPlanId);
  const current = snapshotFor(db, ctx.workspaceId, plan, proposal.snapshot.items.map((item) => item.id));
  if (integrityHash(current) !== proposal.integrityHash) {
    throw new ValidationError('Stock or product details changed after this preview was prepared. Review the newly added products again.');
  }
  const selected = current.items.filter((item) => ids.includes(item.id));

  return inTransaction(db, () => {
    const now = nowIso();
    const movementIds = [];
    const skuIds = selected.flatMap((item) => item.variants.map((variant) => variant.id));
    for (const item of selected) {
      for (const position of item.locations) {
        const result = inventory.adjust(db, ctx, {
          skuId: position.sku_id,
          locationId: position.location_id,
          countedQty: 0,
          reasonCode: 'correction',
          reference: plan.source_name,
          notes: `Removed product records created by import ${plan.source_name}.`,
        });
        movementIds.push(...result.movementIds);
      }
      itemService.setItemActive(db, ctx, item.id, false);
    }
    if (skuIds.length) {
      const placeholders = skuIds.map(() => '?').join(',');
      db.prepare(`UPDATE attention_items SET status = 'RESOLVED', resolution_reason = ?, resolved_at = ?
        WHERE workspace_id = ? AND status IN ('OPEN','ACKNOWLEDGED') AND sku_id IN (${placeholders})`)
        .run('The imported product was removed from active inventory.', now, ctx.workspaceId, ...skuIds);
    }
    const result = {
      productsRemoved: selected.length,
      variantsRemoved: skuIds.length,
      unitsRemoved: selected.reduce((sum, item) => sum + item.onHand, 0),
      itemIds: selected.map((item) => item.id),
      skuIds,
      movementIds,
      sourceName: plan.source_name,
    };
    db.prepare(`UPDATE import_removal_proposals SET status = 'COMPLETED', approved_by_user_id = ?,
      result = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(membership.id, JSON.stringify(result), now, ctx.workspaceId, id);
    return get(db, ctx.workspaceId, id);
  });
}

function cancel(db, workspaceId, id) {
  const proposal = get(db, workspaceId, id);
  if (proposal.status === 'PENDING') {
    db.prepare("UPDATE import_removal_proposals SET status = 'CANCELLED' WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, id);
  }
  return get(db, workspaceId, id);
}

module.exports = {
  matchesInstruction,
  createdItemIds,
  relevantImport,
  snapshotFor,
  create,
  get,
  approve,
  cancel,
};
