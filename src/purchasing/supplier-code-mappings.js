'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError, InvariantError } = require('../domain/errors');
const permissions = require('../actions/permissions');

function cleanCode(value, label) {
  const code = requireText(value, label, { max: 60 });
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(code)) {
    throw new ValidationError(`${label} may use letters, numbers, dots, underscores, slashes and hyphens.`, {
      field: label === 'Your code' ? 'internalBaseCode' : 'vendorCode',
    });
  }
  return code;
}

function suffix(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function integrity(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function getSupplier(db, workspaceId, supplierId) {
  const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ? AND workspace_id = ?')
    .get(supplierId, workspaceId);
  if (!supplier) throw new NotFoundError('That supplier is not in this inventory.');
  return supplier;
}

function linkedItem(db, workspaceId, supplierId, vendorCode) {
  const rows = db.prepare(
    `SELECT DISTINCT i.id, i.name, i.base_code
       FROM supplier_items si
       JOIN skus s ON s.id = si.sku_id
       JOIN items i ON i.id = s.item_id
      WHERE si.workspace_id = ? AND si.supplier_id = ? AND si.is_active = 1
        AND si.supplier_sku = ? COLLATE NOCASE AND i.is_active = 1`
  ).all(workspaceId, supplierId, vendorCode);
  if (!rows.length) throw new ValidationError(`Foundry could not find vendor code ${vendorCode} for this supplier.`);
  if (rows.length > 1) {
    throw new ValidationError(
      `${vendorCode} is linked to more than one product. Resolve that supplier-catalogue conflict before changing your code.`
    );
  }
  return rows[0];
}

function previewState(db, workspaceId, supplierId, vendorCode, internalBaseCode, forcedItemId = null) {
  const supplier = getSupplier(db, workspaceId, supplierId);
  const item = forcedItemId
    ? db.prepare('SELECT id, name, base_code FROM items WHERE id = ? AND workspace_id = ? AND is_active = 1')
      .get(forcedItemId, workspaceId)
    : linkedItem(db, workspaceId, supplierId, vendorCode);
  if (!item) throw new NotFoundError('That product is not in this inventory.');

  const skus = db.prepare(
    `SELECT id, code, variant_label FROM skus
      WHERE workspace_id = ? AND item_id = ? AND is_active = 1 ORDER BY position`
  ).all(workspaceId, item.id);
  if (!skus.length) throw new ValidationError('That product has no active stock positions to rename.');

  const proposed = skus.map((sku) => ({
    skuId: sku.id,
    variantLabel: sku.variant_label,
    beforeCode: sku.code,
    afterCode: sku.variant_label ? `${internalBaseCode}-${suffix(sku.variant_label)}` : internalBaseCode,
  }));
  if (new Set(proposed.map((row) => row.afterCode.toLowerCase())).size !== proposed.length) {
    throw new ValidationError('That code would give two variants the same internal SKU. Choose a more specific code.');
  }

  const itemClash = db.prepare(
    'SELECT name FROM items WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE AND id <> ?'
  ).get(workspaceId, internalBaseCode, item.id);
  if (itemClash) throw new ValidationError(`${itemClash.name} already uses your code ${internalBaseCode}.`);

  const ids = proposed.map((row) => row.skuId);
  const placeholders = ids.map(() => '?').join(',');
  for (const row of proposed) {
    const clash = db.prepare(
      `SELECT i.name, s.variant_label FROM skus s JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ? AND s.code = ? COLLATE NOCASE AND s.id NOT IN (${placeholders})`
    ).get(workspaceId, row.afterCode, ...ids);
    if (clash) throw new ValidationError(`${row.afterCode} is already used by ${clash.name}${clash.variant_label ? ` / ${clash.variant_label}` : ''}.`);
  }

  const payload = {
    workspaceId, supplierId, vendorCode, internalBaseCode, itemId: item.id,
    affected: proposed.map((row) => ({ skuId: row.skuId, beforeCode: row.beforeCode, afterCode: row.afterCode })),
  };
  return { supplier, item, vendorCode, internalBaseCode, affected: proposed, integrityHash: integrity(payload) };
}

function preview(db, ctx, membership, input) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'manage supplier code mappings');
  const vendorCode = cleanCode(input.vendorCode, 'Vendor code');
  const internalBaseCode = cleanCode(input.internalBaseCode, 'Your code');
  const state = previewState(db, ctx.workspaceId, input.supplierId, vendorCode, internalBaseCode);
  const id = newId('scmp');
  db.prepare(
    `INSERT INTO supplier_code_mapping_proposals
       (id, workspace_id, supplier_id, vendor_code, internal_base_code, affected_item_id,
        affected_skus, integrity_hash, status, requested_by_user_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`
  ).run(id, ctx.workspaceId, input.supplierId, vendorCode, internalBaseCode, state.item.id,
    JSON.stringify(state.affected), state.integrityHash, ctx.actorId, nowIso());
  return getProposal(db, ctx.workspaceId, id);
}

function hydrateProposal(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, supplierId: row.supplier_id,
    supplierName: row.supplier_name, vendorCode: row.vendor_code,
    internalBaseCode: row.internal_base_code, itemId: row.affected_item_id,
    itemName: row.item_name, affected: JSON.parse(row.affected_skus || '[]'),
    integrityHash: row.integrity_hash, status: row.status,
    createdAt: row.created_at, appliedAt: row.applied_at,
  };
}

function getProposal(db, workspaceId, id) {
  const row = db.prepare(
    `SELECT p.*, s.name AS supplier_name, i.name AS item_name
       FROM supplier_code_mapping_proposals p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN items i ON i.id = p.affected_item_id
      WHERE p.id = ? AND p.workspace_id = ?`
  ).get(id, workspaceId);
  if (!row) throw new NotFoundError('That code change is not in this inventory.');
  return hydrateProposal(row);
}

function saveMapping(db, ctx, proposal) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO supplier_code_mappings
       (id, workspace_id, supplier_id, vendor_code, internal_base_code, created_by_user_id,
        source, created_at, updated_at, last_applied_at)
     VALUES (?, ?, ?, ?, ?, ?, 'customer', ?, ?, ?)
     ON CONFLICT(workspace_id, supplier_id, vendor_code) DO UPDATE SET
       internal_base_code = excluded.internal_base_code,
       created_by_user_id = excluded.created_by_user_id,
       source = 'customer', updated_at = excluded.updated_at, last_applied_at = excluded.last_applied_at`
  ).run(newId('scm'), ctx.workspaceId, proposal.supplierId, proposal.vendorCode,
    proposal.internalBaseCode, ctx.actorId, now, now, now);
}

function applyState(db, ctx, state) {
  db.prepare('UPDATE items SET base_code = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(state.internalBaseCode, nowIso(), state.item.id, ctx.workspaceId);
  const updateSku = db.prepare('UPDATE skus SET code = ? WHERE id = ? AND workspace_id = ?');
  for (const row of state.affected) updateSku.run(row.afterCode, row.skuId, ctx.workspaceId);
}

function apply(db, ctx, membership, proposalId) {
  permissions.assertCan(membership, permissions.MANAGE_SUPPLIERS, 'approve supplier code mappings');
  const proposal = getProposal(db, ctx.workspaceId, proposalId);
  if (proposal.status === 'APPLIED') return proposal;
  if (proposal.status !== 'PROPOSED') throw new InvariantError('That code change is no longer available.', 'mapping_not_proposed');

  return inTransaction(db, () => {
    const state = previewState(db, ctx.workspaceId, proposal.supplierId, proposal.vendorCode, proposal.internalBaseCode);
    if (state.integrityHash !== proposal.integrityHash) {
      db.prepare("UPDATE supplier_code_mapping_proposals SET status = 'INVALIDATED' WHERE id = ?").run(proposal.id);
      throw new InvariantError('The product codes changed after this preview. Ask Foundry to prepare it again.', 'mapping_changed');
    }
    applyState(db, ctx, state);
    saveMapping(db, ctx, proposal);
    db.prepare("UPDATE supplier_code_mapping_proposals SET status = 'APPLIED', applied_at = ? WHERE id = ?")
      .run(nowIso(), proposal.id);
    return getProposal(db, ctx.workspaceId, proposal.id);
  });
}

function applySavedForSupplierItem(db, ctx, supplierId, skuId, vendorCode) {
  if (!vendorCode) return null;
  const mapping = db.prepare(
    `SELECT * FROM supplier_code_mappings
      WHERE workspace_id = ? AND supplier_id = ? AND vendor_code = ? COLLATE NOCASE`
  ).get(ctx.workspaceId, supplierId, vendorCode);
  if (!mapping) return null;
  const sku = db.prepare('SELECT item_id FROM skus WHERE id = ? AND workspace_id = ?').get(skuId, ctx.workspaceId);
  if (!sku) return null;
  const state = previewState(db, ctx.workspaceId, supplierId, mapping.vendor_code, mapping.internal_base_code, sku.item_id);
  applyState(db, ctx, state);
  db.prepare('UPDATE supplier_code_mappings SET last_applied_at = ?, updated_at = ? WHERE id = ?')
    .run(nowIso(), nowIso(), mapping.id);
  return state;
}

function listForSupplier(db, workspaceId, supplierId) {
  getSupplier(db, workspaceId, supplierId);
  return db.prepare(
    `SELECT si.supplier_sku AS vendorCode, i.id AS itemId, i.name AS itemName,
            i.base_code AS currentInternalBaseCode, COUNT(DISTINCT si.sku_id) AS linkedVariants,
            m.internal_base_code AS rememberedInternalBaseCode, m.updated_at AS rememberedAt
       FROM supplier_items si
       JOIN skus s ON s.id = si.sku_id
       JOIN items i ON i.id = s.item_id
       LEFT JOIN supplier_code_mappings m
         ON m.workspace_id = si.workspace_id AND m.supplier_id = si.supplier_id
        AND m.vendor_code = si.supplier_sku COLLATE NOCASE
      WHERE si.workspace_id = ? AND si.supplier_id = ? AND si.is_active = 1
        AND si.supplier_sku IS NOT NULL AND TRIM(si.supplier_sku) <> ''
      GROUP BY LOWER(si.supplier_sku), i.id
      ORDER BY i.name COLLATE NOCASE, si.supplier_sku COLLATE NOCASE`
  ).all(workspaceId, supplierId);
}

function parseInstruction(message) {
  const text = String(message || '').trim();
  const patterns = [
    /(?:change|map|rename|replace)\s+(?:the\s+)?(?:vendor|supplier)(?:'s)?\s+(?:code|sku)\s+["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?\s+(?:to|as)\s+(?:my\s+|our\s+)?(?:code\s+)?["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?/i,
    /(?:for\s+)?(?:vendor|supplier)\s+(?:code|sku)\s+["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?\s*,?\s*(?:use|make it|call it)\s+["']?([A-Za-z0-9][A-Za-z0-9._/-]*)["']?/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { matched: true, vendorCode: match[1], internalBaseCode: match[2] };
  }
  return { matched: false };
}

function previewFromInstruction(db, ctx, membership, message) {
  const parsed = parseInstruction(message);
  if (!parsed.matched) return { matched: false };
  const candidates = db.prepare(
    `SELECT DISTINCT s.id, s.name FROM supplier_items si
       JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.workspace_id = ? AND si.is_active = 1 AND si.supplier_sku = ? COLLATE NOCASE`
  ).all(ctx.workspaceId, parsed.vendorCode);
  if (!candidates.length) {
    throw new ValidationError(`Foundry could not find vendor code ${parsed.vendorCode} in this inventory.`);
  }
  const named = candidates.filter((supplier) => message.toLowerCase().includes(supplier.name.toLowerCase()));
  const choices = named.length ? named : candidates;
  if (choices.length !== 1) {
    throw new ValidationError(`${parsed.vendorCode} is used by more than one supplier. Name the supplier too.`);
  }
  return { matched: true, proposal: preview(db, ctx, membership, {
    supplierId: choices[0].id, vendorCode: parsed.vendorCode, internalBaseCode: parsed.internalBaseCode,
  }) };
}

module.exports = {
  cleanCode, previewState, preview, getProposal, apply, applySavedForSupplierItem,
  listForSupplier, parseInstruction, previewFromInstruction,
};
