'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const inventory = require('../domain/inventory-engine');
const itemService = require('../domain/item-service');
const { ValidationError, NotFoundError, AuthorizationError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

const ACTIVE_WORK = new Set([
  'DETECTED', 'PLANNED', 'WAITING_FOR_APPROVAL', 'AUTHORIZED', 'EXECUTING', 'VERIFYING', 'BLOCKED',
]);

function json(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function matchesInstruction(message) {
  const text = String(message || '');
  const remove = /\b(delete|remove|undo|roll\s*back|take\s+out)\b/i.test(text);
  const records = /\b(items?|products?|records?|inventory|stock)\b/i.test(text);
  // Provenance removal is selected only when the person actually names a
  // source document/import. Words such as "added", "earlier" or "newly" also
  // occur in ordinary single-product removal ("added by mistake") and must not
  // turn a named SKU into a whole-document rollback.
  const source = /\b(pdf|document|file|sheet|spreadsheet|upload|import)\b/i.test(text);
  return remove && records && source;
}

function documents(db, workspaceId) {
  return db.prepare(`SELECT * FROM setup_documents
    WHERE workspace_id = ? AND status = 'APPLIED'
    ORDER BY applied_at DESC, created_at DESC`).all(workspaceId)
    .filter((row) => !json(row.result, {}).removedAt);
}

function normal(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function referencedDocument(db, workspaceId, message) {
  const available = documents(db, workspaceId);
  if (!available.length) return null;
  const stated = normal(message);
  const named = available.find((row) => {
    const source = normal(row.source_name);
    return source.length >= 4 && stated.includes(source);
  });
  return named || available[0];
}

function createdItemIds(db, workspaceId, document) {
  const recorded = json(document.result, {}).createdItemIds;
  if (Array.isArray(recorded) && recorded.length) return [...new Set(recorded)];
  if (!document.purchase_order_id) return [];
  // Older document records predate createdItemIds. Their generated products
  // still carry both independent pieces of provenance: the document PO line
  // and the exact source filename in the item description.
  return db.prepare(`SELECT DISTINCT i.id
      FROM purchase_order_lines pol
      JOIN skus s ON s.id = pol.sku_id AND s.workspace_id = pol.workspace_id
      JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
     WHERE pol.workspace_id = ? AND pol.purchase_order_id = ? AND i.description = ?`)
    .all(workspaceId, document.purchase_order_id, `Created from ${document.source_name}`)
    .map((row) => row.id);
}

function snapshotFor(db, workspaceId, document, itemIds = null) {
  const ids = itemIds || createdItemIds(db, workspaceId, document);
  const items = [];
  for (const id of ids) {
    const item = db.prepare('SELECT * FROM items WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
    if (!item) continue;
    const variants = db.prepare(`SELECT s.id, s.code, s.variant_label,
        COALESCE(SUM(b.on_hand), 0) AS on_hand
      FROM skus s LEFT JOIN balances b ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
      WHERE s.workspace_id = ? AND s.item_id = ?
      GROUP BY s.id ORDER BY s.position`).all(workspaceId, id);
    const locations = db.prepare(`SELECT s.id AS sku_id, l.id AS location_id, l.name,
        b.on_hand
      FROM skus s JOIN balances b ON b.sku_id = s.id AND b.workspace_id = s.workspace_id
      JOIN locations l ON l.id = b.location_id AND l.workspace_id = b.workspace_id
      WHERE s.workspace_id = ? AND s.item_id = ? AND b.on_hand <> 0
      ORDER BY l.name, s.position`).all(workspaceId, id);
    items.push({
      id: item.id, name: item.name, active: Boolean(item.is_active),
      variants, locations,
      onHand: variants.reduce((sum, variant) => sum + Number(variant.on_hand || 0), 0),
    });
  }
  return {
    document: { id: document.id, sourceName: document.source_name, appliedAt: document.applied_at,
      purchaseOrderId: document.purchase_order_id },
    items,
    productCount: items.length,
    variantCount: items.reduce((sum, item) => sum + item.variants.length, 0),
    onHand: items.reduce((sum, item) => sum + item.onHand, 0),
  };
}

function hash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function hydrate(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, setupDocumentId: row.setup_document_id,
    instruction: row.instruction, snapshot: json(row.snapshot, {}), integrityHash: row.integrity_hash,
    status: row.status, result: json(row.result, {}), createdAt: row.created_at, completedAt: row.completed_at,
  };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM document_removal_proposals WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That removal review is not in this inventory.');
  return hydrate(row);
}

function create(db, ctx, membership, instruction) {
  const document = referencedDocument(db, ctx.workspaceId, instruction);
  if (!document) {
    throw new ValidationError('Foundry could not find an earlier applied document in this inventory. Nothing was removed.');
  }
  const snapshot = snapshotFor(db, ctx.workspaceId, document);
  const activeItems = snapshot.items.filter((item) => item.active);
  snapshot.items = activeItems;
  snapshot.productCount = activeItems.length;
  snapshot.variantCount = activeItems.reduce((sum, item) => sum + item.variants.length, 0);
  snapshot.onHand = activeItems.reduce((sum, item) => sum + item.onHand, 0);
  if (!snapshot.items.length) {
    throw new ValidationError(`${document.source_name} did not create any products Foundry can safely remove. Nothing was removed.`);
  }
  const integrityHash = hash(snapshot);
  const existing = db.prepare(`SELECT * FROM document_removal_proposals
    WHERE workspace_id = ? AND setup_document_id = ? AND integrity_hash = ? AND status = 'PENDING'
    ORDER BY created_at DESC LIMIT 1`).get(ctx.workspaceId, document.id, integrityHash);
  if (existing) return hydrate(existing);
  const id = newId('drp');
  db.prepare(`INSERT INTO document_removal_proposals
    (id, workspace_id, setup_document_id, requested_by_user_id, instruction, snapshot,
     integrity_hash, status, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', '{}', ?)`)
    .run(id, ctx.workspaceId, document.id, membership.id, instruction, JSON.stringify(snapshot), integrityHash, nowIso());
  return get(db, ctx.workspaceId, id);
}

function supersedeRelatedWork(db, workspaceId, itemIds, skuIds, now) {
  const needles = new Set([...itemIds, ...skuIds]);
  const rows = db.prepare('SELECT id, execution_status, affected_entities FROM work_items WHERE workspace_id = ?')
    .all(workspaceId);
  for (const row of rows) {
    if (!ACTIVE_WORK.has(row.execution_status)) continue;
    const serialized = JSON.stringify(json(row.affected_entities, {}));
    if (![...needles].some((id) => serialized.includes(id))) continue;
    db.prepare(`UPDATE work_items SET execution_status = 'SUPERSEDED', verification_status = 'NOT_APPLICABLE',
      outcome = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(JSON.stringify({ reason: 'The product was removed from active inventory.' }), now, workspaceId, row.id);
  }
}

function selectedIds(input, fallback) {
  const values = Array.isArray(input) ? input : input ? [input] : fallback;
  return [...new Set((values || []).map(String).filter(Boolean))];
}

function approve(db, ctx, membership, id, expectedHash, requestedItemIds = null) {
  if (!membership || membership.role !== 'owner') throw new AuthorizationError('Only an owner can remove imported products.');
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'COMPLETED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That removal was cancelled.');
  if (!expectedHash || expectedHash !== proposal.integrityHash) {
    throw new ValidationError('The removal preview changed. Review it again before approving.');
  }
  const allowed = new Set(proposal.snapshot.items.map((item) => item.id));
  const itemIdsToRemove = selectedIds(requestedItemIds, [...allowed]);
  if (!itemIdsToRemove.length) throw new ValidationError('Select at least one product to remove.');
  if (itemIdsToRemove.some((itemId) => !allowed.has(itemId))) {
    throw new ValidationError('One of the selected products was not in this document review. Nothing was removed.');
  }
  const document = db.prepare('SELECT * FROM setup_documents WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, proposal.setupDocumentId);
  const current = snapshotFor(db, ctx.workspaceId, document, proposal.snapshot.items.map((item) => item.id));
  if (hash(current) !== proposal.integrityHash) {
    throw new ValidationError('Stock changed after this preview was prepared. Ask Foundry to remove the uploaded items again so you can review the current quantities.');
  }

  const selected = current.items.filter((item) => itemIdsToRemove.includes(item.id));

  return inTransaction(db, () => {
    const now = nowIso();
    const movementIds = [];
    const itemIds = selected.map((item) => item.id);
    const skuIds = selected.flatMap((item) => item.variants.map((variant) => variant.id));
    for (const item of selected) {
      for (const position of item.locations) {
        const result = inventory.adjust(db, ctx, {
          skuId: position.sku_id, locationId: position.location_id, countedQty: 0,
          reasonCode: 'correction', reference: document.source_name,
          notes: `Removed product records created from ${document.source_name}.`,
        });
        movementIds.push(...result.movementIds);
      }
      if (item.active) itemService.setItemActive(db, ctx, item.id, false);
    }
    if (skuIds.length) {
      const placeholders = skuIds.map(() => '?').join(',');
      db.prepare(`UPDATE attention_items SET status = 'RESOLVED', resolution_reason = ?, resolved_at = ?
        WHERE workspace_id = ? AND status IN ('OPEN','ACKNOWLEDGED') AND sku_id IN (${placeholders})`)
        .run('The product was removed from active inventory.', now, ctx.workspaceId, ...skuIds);
    }
    supersedeRelatedWork(db, ctx.workspaceId, itemIds, skuIds, now);
    const documentResult = json(document.result, {});
    documentResult.removalProposalId = id;
    documentResult.removedItemIds = [...new Set([...(documentResult.removedItemIds || []), ...itemIds])];
    const sourceItemIds = createdItemIds(db, ctx.workspaceId, document);
    const remaining = sourceItemIds.some((itemId) => {
      const row = db.prepare('SELECT is_active FROM items WHERE workspace_id = ? AND id = ?')
        .get(ctx.workspaceId, itemId);
      return row && row.is_active;
    });
    if (!remaining) documentResult.removedAt = now;
    db.prepare('UPDATE setup_documents SET result = ? WHERE workspace_id = ? AND id = ?')
      .run(JSON.stringify(documentResult), ctx.workspaceId, document.id);
    const result = { productsRemoved: itemIds.length, variantsRemoved: skuIds.length,
      unitsRemoved: selected.reduce((sum, item) => sum + item.onHand, 0),
      itemIds, skuIds, movementIds, sourceName: document.source_name };
    db.prepare(`UPDATE document_removal_proposals SET status = 'COMPLETED', approved_by_user_id = ?,
      result = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(membership.id, JSON.stringify(result), now, ctx.workspaceId, id);
    return get(db, ctx.workspaceId, id);
  });
}

function cancel(db, workspaceId, id) {
  const proposal = get(db, workspaceId, id);
  if (proposal.status === 'PENDING') {
    db.prepare("UPDATE document_removal_proposals SET status = 'CANCELLED' WHERE workspace_id = ? AND id = ?")
      .run(workspaceId, id);
  }
  return get(db, workspaceId, id);
}

module.exports = { matchesInstruction, referencedDocument, createdItemIds, snapshotFor, create, get, approve, cancel };
