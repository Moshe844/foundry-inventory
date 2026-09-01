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

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function effectiveRemoved(result) {
  if (!result.removedAt) return false;
  return !result.restoredAt || String(result.removedAt) > String(result.restoredAt);
}

function sourceFor(db, workspaceId, connectorId, messageId) {
  const message = db.prepare(`SELECT * FROM connection_email_messages
    WHERE id = ? AND workspace_id = ? AND connector_id = ? AND trust_status = 'TRUSTED'`)
    .get(messageId, workspaceId, connectorId);
  if (!message) throw new NotFoundError('That approved supplier email is no longer available.');
  const attachment = db.prepare(`SELECT a.*, d.id AS document_id, d.source_name, d.interpretation,
      d.result AS document_result, d.applied_at
    FROM connection_email_attachments a
    JOIN setup_documents d ON d.workspace_id = a.workspace_id AND d.content_hash = a.content_hash
      AND d.status = 'APPLIED'
    WHERE a.workspace_id = ? AND a.message_id = ?
    ORDER BY d.applied_at LIMIT 1`).get(workspaceId, messageId);
  if (!attachment) throw new ValidationError('This email does not contain an earlier imported file that can be restored.');
  const result = json(attachment.document_result, {});
  if (!effectiveRemoved(result)) {
    throw new ValidationError('The earlier import is currently present. Restoring it would duplicate stock.');
  }
  return { message, attachment, result, interpretation: json(attachment.interpretation, {}) };
}

function lineItemName(line) {
  const style = String(line.styleName || '').trim();
  const color = String(line.color || '').trim();
  return color && !style.toLowerCase().includes(color.toLowerCase()) ? `${style} - ${color}` : style;
}

function buildSnapshot(db, workspaceId, connectorId, messageId) {
  const source = sourceFor(db, workspaceId, connectorId, messageId);
  const itemIds = [...new Set((source.result.createdItemIds || []).map(String))];
  if (!itemIds.length) {
    throw new ValidationError('The original import did not record the products it created, so Foundry cannot restore it safely.');
  }
  const allowed = new Set(itemIds);
  const defaultLocation = db.prepare('SELECT id, name FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
    .get(workspaceId, source.interpretation.destinationName || source.result.location);
  if (!defaultLocation) throw new ValidationError('The original destination no longer exists. Nothing was restored.');

  const lines = [];
  for (const line of source.interpretation.lines || []) {
    const itemName = lineItemName(line);
    const sku = db.prepare(`SELECT s.id AS sku_id, s.code, s.variant_label, s.is_active AS sku_active,
        i.id AS item_id, i.name AS item_name, i.is_active AS item_active, i.tracking_mode
      FROM items i JOIN skus s ON s.item_id = i.id AND s.workspace_id = i.workspace_id
      WHERE i.workspace_id = ? AND i.name = ? COLLATE NOCASE
        AND COALESCE(s.variant_label, '') = ? COLLATE NOCASE`)
      .get(workspaceId, itemName, String(line.size || ''));
    if (!sku || !allowed.has(sku.item_id)) {
      throw new ValidationError(`${itemName}${line.size ? ` / ${line.size}` : ''} no longer matches the product created by the original import. Nothing was restored.`);
    }
    if (sku.tracking_mode !== 'quantity') {
      throw new ValidationError(`${sku.item_name} no longer uses quantity tracking. Nothing was restored.`);
    }
    const allocations = (Array.isArray(line.locationQuantities) && line.locationQuantities.length
      ? line.locationQuantities : [{ locationName: defaultLocation.name, quantity: line.quantity }])
      .filter((entry) => Number(entry.quantity) > 0);
    for (const allocation of allocations) {
      const location = db.prepare('SELECT id, name FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
        .get(workspaceId, allocation.locationName);
      if (!location) throw new ValidationError(`The original location ${allocation.locationName} no longer exists. Nothing was restored.`);
      lines.push({
        itemId: sku.item_id, itemName: sku.item_name, itemActive: Boolean(sku.item_active),
        skuId: sku.sku_id, skuCode: sku.code, variant: sku.variant_label || '', skuActive: Boolean(sku.sku_active),
        locationId: location.id, locationName: location.name, quantity: Number(allocation.quantity),
        unitLabel: source.interpretation.unitLabel || source.result.unitLabel || 'unit',
        currentOnHand: Number(db.prepare(`SELECT COALESCE(on_hand, 0) AS qty FROM balances
          WHERE workspace_id = ? AND sku_id = ? AND location_id = ?`).get(workspaceId, sku.sku_id, location.id)?.qty || 0),
      });
    }
  }
  if (!lines.length) throw new ValidationError('The original import has no positive quantities to restore.');
  const allBalances = db.prepare(`SELECT b.sku_id, b.location_id, b.on_hand
    FROM balances b WHERE b.workspace_id = ? AND b.sku_id IN (${lines.map(() => '?').join(',')})
    ORDER BY b.sku_id, b.location_id`).all(workspaceId, ...lines.map((line) => line.skuId));
  return {
    source: {
      messageId, connectorId, attachmentId: source.attachment.id, filename: source.attachment.filename,
      setupDocumentId: source.attachment.document_id, originallyImportedAt: source.attachment.applied_at,
      removedAt: source.result.removedAt, supplier: source.result.supplier || source.interpretation.supplierName || '',
    },
    lines,
    productCount: new Set(lines.map((line) => line.itemId)).size,
    variantCount: new Set(lines.map((line) => line.skuId)).size,
    totalUnits: lines.reduce((sum, line) => sum + line.quantity, 0),
    unitLabel: lines[0].unitLabel,
    currentState: { allBalances },
  };
}

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, setupDocumentId: row.setup_document_id,
    connectorId: row.connector_id, messageId: row.message_id, snapshot: json(row.snapshot, {}),
    integrityHash: row.integrity_hash, status: row.status, result: json(row.result, {}),
    createdAt: row.created_at, completedAt: row.completed_at };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM document_restore_reviews WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That restoration review is no longer available.');
  return hydrate(row);
}

function prepare(db, ctx, membership, connectorId, messageId) {
  const existing = db.prepare(`SELECT * FROM document_restore_reviews
    WHERE workspace_id = ? AND connector_id = ? AND message_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(ctx.workspaceId, connectorId, messageId);
  if (existing && existing.status !== 'PENDING') return hydrate(existing);
  const snapshot = buildSnapshot(db, ctx.workspaceId, connectorId, messageId);
  const integrityHash = hash(snapshot);
  if (existing) {
    if (existing.integrity_hash !== integrityHash) {
      db.prepare(`UPDATE document_restore_reviews SET snapshot = ?, integrity_hash = ?
        WHERE workspace_id = ? AND id = ?`)
        .run(JSON.stringify(snapshot), integrityHash, ctx.workspaceId, existing.id);
    }
    return get(db, ctx.workspaceId, existing.id);
  }
  const id = newId('drr');
  db.prepare(`INSERT INTO document_restore_reviews
    (id, workspace_id, setup_document_id, connector_id, message_id, requested_by_user_id,
      snapshot, integrity_hash, status, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', '{}', ?)`)
    .run(id, ctx.workspaceId, snapshot.source.setupDocumentId, connectorId, messageId, membership.id,
      JSON.stringify(snapshot), integrityHash, nowIso());
  return get(db, ctx.workspaceId, id);
}

function approve(db, ctx, membership, id, expectedHash) {
  if (!membership || membership.role !== 'owner') throw new AuthorizationError('Only an owner can restore an earlier import.');
  const review = get(db, ctx.workspaceId, id);
  if (review.status === 'COMPLETED') return review;
  if (review.status !== 'PENDING') throw new ValidationError('That restoration was declined.');
  if (!expectedHash || expectedHash !== review.integrityHash) {
    throw new ValidationError('The restoration preview changed. Review it again before approving.');
  }
  const current = buildSnapshot(db, ctx.workspaceId, review.connectorId, review.messageId);
  if (hash(current) !== review.integrityHash) {
    throw new ValidationError('Inventory changed after this preview was prepared. Open the email again to review current stock before restoring it.');
  }
  return inTransaction(db, () => {
    const now = nowIso();
    const movementIds = [];
    for (const itemId of new Set(current.lines.map((line) => line.itemId))) {
      const item = current.lines.find((line) => line.itemId === itemId);
      if (!item.itemActive) itemService.setItemActive(db, ctx, itemId, true);
    }
    for (const line of current.lines) {
      const received = inventory.receive(db, ctx, {
        skuId: line.skuId, locationId: line.locationId, quantity: line.quantity,
        reasonCode: 'opening_balance', reference: current.source.filename,
        notes: `Restored the removed import from ${current.source.filename}; approved from supplier email ${current.source.messageId}.`,
      });
      movementIds.push(...received.movementIds);
    }
    const document = db.prepare('SELECT result FROM setup_documents WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, review.setupDocumentId);
    const documentResult = json(document.result, {});
    documentResult.restoredAt = now;
    documentResult.restorationReviewId = id;
    documentResult.restorationMessageId = review.messageId;
    documentResult.restoredUnits = current.totalUnits;
    db.prepare('UPDATE setup_documents SET result = ? WHERE workspace_id = ? AND id = ?')
      .run(JSON.stringify(documentResult), ctx.workspaceId, review.setupDocumentId);
    db.prepare(`UPDATE connection_email_attachments SET setup_document_id = ?
      WHERE workspace_id = ? AND message_id = ? AND content_hash =
        (SELECT content_hash FROM setup_documents WHERE id = ?)`)
      .run(review.setupDocumentId, ctx.workspaceId, review.messageId, review.setupDocumentId);
    db.prepare(`UPDATE connection_email_messages SET processing_status = 'INVENTORY_RESTORED', processed_at = ?
      WHERE workspace_id = ? AND id = ?`).run(now, ctx.workspaceId, review.messageId);
    const result = { productsRestored: current.productCount, variantsRestored: current.variantCount,
      unitsRestored: current.totalUnits, unitLabel: current.unitLabel, movementIds };
    db.prepare(`UPDATE document_restore_reviews SET status = 'COMPLETED', approved_by_user_id = ?,
      result = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(membership.id, JSON.stringify(result), now, ctx.workspaceId, id);
    return get(db, ctx.workspaceId, id);
  });
}

function decline(db, workspaceId, id) {
  const review = get(db, workspaceId, id);
  if (review.status !== 'PENDING') return review;
  const now = nowIso();
  db.prepare("UPDATE document_restore_reviews SET status = 'DECLINED', completed_at = ? WHERE workspace_id = ? AND id = ?")
    .run(now, workspaceId, id);
  db.prepare(`UPDATE connection_email_messages SET processing_status = 'SAVED_NO_ACTION', processed_at = ?
    WHERE workspace_id = ? AND id = ?`).run(now, workspaceId, review.messageId);
  return get(db, workspaceId, id);
}

module.exports = { effectiveRemoved, buildSnapshot, prepare, get, approve, decline };
