'use strict';

const crypto = require('node:crypto');
const { inTransaction } = require('../db');
const { ValidationError, NotFoundError, AuthorizationError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');

function json(value, fallback) {
  try { return JSON.parse(value) ?? fallback; } catch { return fallback; }
}

function cleanToken(value) {
  return String(value || '').trim().replace(/^["'`]+|["'`.,;:!?]+$/g, '');
}

function parseInstruction(message) {
  const text = String(message || '').trim();
  if (!/\b(code|codes|sku|skus|identifier|identifiers)\b/i.test(text)) return null;
  if (/\b(vendor|supplier)\b/i.test(text)) return null;
  if (!/\b(replace|change|rewrite|rename|swap|convert)\b/i.test(text)) return null;

  let match = text.match(/\bfrom\s+["'`]?([A-Za-z0-9._/-]+)["'`]?(?:\s+)(?:to|with)\s+["'`]?([A-Za-z0-9._/-]+)["'`]?/i);
  if (!match) match = text.match(/\bprefix\s+["'`]?([A-Za-z0-9._/-]+)["'`]?(?:\s+)(?:to|with)\s+["'`]?([A-Za-z0-9._/-]+)["'`]?/i);
  if (!match) match = text.match(/\b(?:replace|change|rewrite|rename|swap|convert)\s+["'`]?([A-Za-z0-9._/-]+)["'`]?(?:\s+)(?:to|with)\s+["'`]?([A-Za-z0-9._/-]+)["'`]?/i);
  if (!match) return null;

  const from = cleanToken(match[1]);
  const to = cleanToken(match[2]);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  const explicitlyPrefix = /\b(first\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:letters?|characters?)|prefix|start(?:ing)?\s+with|begins?\s+with)\b/i.test(text);
  const bulk = /\b(each|every|all|bulk|across|codes|skus|items|products)\b/i.test(text);
  return { mode: explicitlyPrefix || bulk ? 'prefix' : 'exact', from, to };
}

function matchesInstruction(message) { return Boolean(parseInstruction(message)); }

function normaliseOperation(value) {
  if (!value || typeof value !== 'object') return null;
  const from = cleanToken(value.from || value.fromText);
  const to = cleanToken(value.to || value.toText);
  const mode = value.mode || value.transformMode;
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  return { mode: mode === 'exact' ? 'exact' : 'prefix', from, to };
}

function transform(value, operation) {
  const code = String(value || '');
  if (operation.mode === 'exact') {
    return code.toLowerCase() === operation.from.toLowerCase() ? operation.to : null;
  }
  return code.toLowerCase().startsWith(operation.from.toLowerCase())
    ? `${operation.to}${code.slice(operation.from.length)}` : null;
}

function snapshotFor(db, workspaceId, operation) {
  const rows = db.prepare(`SELECT i.id AS item_id, i.name, i.base_code,
      s.id AS sku_id, s.code AS sku_code, s.variant_label
    FROM items i JOIN skus s ON s.item_id = i.id AND s.workspace_id = i.workspace_id
    WHERE i.workspace_id = ? AND i.is_active = 1 AND s.is_active = 1
    ORDER BY i.name, s.position`).all(workspaceId);
  const grouped = new Map();
  for (const row of rows) {
    const nextBase = transform(row.base_code, operation);
    const nextSku = transform(row.sku_code, operation);
    if (nextBase === null && nextSku === null) continue;
    if (!grouped.has(row.item_id)) grouped.set(row.item_id, {
      itemId: row.item_id, name: row.name, oldBaseCode: row.base_code,
      newBaseCode: nextBase === null ? row.base_code : nextBase, skus: [],
    });
    if (nextSku !== null) grouped.get(row.item_id).skus.push({
      skuId: row.sku_id, variantLabel: row.variant_label, oldCode: row.sku_code, newCode: nextSku,
    });
  }
  const items = [...grouped.values()];
  if (!items.length) {
    throw new ValidationError(`No active item or SKU codes begin with ${operation.from}. Nothing was changed.`);
  }

  const itemIds = new Set(items.map((item) => item.itemId));
  const skuIds = new Set(items.flatMap((item) => item.skus.map((sku) => sku.skuId)));
  const desiredBases = new Map();
  for (const item of items) {
    if (!item.newBaseCode) continue;
    const key = item.newBaseCode.toLowerCase();
    if (desiredBases.has(key) && desiredBases.get(key) !== item.itemId) {
      throw new ValidationError(`That change would give two products the code ${item.newBaseCode}. Nothing was changed.`);
    }
    desiredBases.set(key, item.itemId);
    const conflict = db.prepare(`SELECT id, name FROM items WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE`)
      .get(workspaceId, item.newBaseCode);
    if (conflict && !itemIds.has(conflict.id)) {
      throw new ValidationError(`${item.newBaseCode} is already used by ${conflict.name}. Nothing was changed.`);
    }
  }
  const desiredSkus = new Map();
  for (const sku of items.flatMap((item) => item.skus)) {
    const key = sku.newCode.toLowerCase();
    if (desiredSkus.has(key) && desiredSkus.get(key) !== sku.skuId) {
      throw new ValidationError(`That change would create the duplicate SKU ${sku.newCode}. Nothing was changed.`);
    }
    desiredSkus.set(key, sku.skuId);
    const conflict = db.prepare('SELECT id FROM skus WHERE workspace_id = ? AND code = ? COLLATE NOCASE')
      .get(workspaceId, sku.newCode);
    if (conflict && !skuIds.has(conflict.id)) {
      throw new ValidationError(`The SKU ${sku.newCode} already exists. Nothing was changed.`);
    }
  }
  return { operation, items, productCount: items.length,
    skuCount: items.reduce((sum, item) => sum + item.skus.length, 0) };
}

function hash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function hydrate(row) {
  if (!row) return null;
  return { id: row.id, workspaceId: row.workspace_id, instruction: row.instruction,
    operation: json(row.operation, {}), snapshot: json(row.snapshot, {}), integrityHash: row.integrity_hash,
    status: row.status, result: json(row.result, {}), createdAt: row.created_at, completedAt: row.completed_at };
}

function get(db, workspaceId, id) {
  const row = db.prepare('SELECT * FROM catalog_code_change_proposals WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, id);
  if (!row) throw new NotFoundError('That code-change review is not in this inventory.');
  return hydrate(row);
}

function create(db, ctx, membership, instruction, options = {}) {
  // A model-selected capability supplies typed parameters. Parsing the sentence
  // remains only an offline/backwards-compatible fallback, not the way the
  // route decides whether this operation exists.
  const operation = normaliseOperation(options.operation) || parseInstruction(instruction);
  if (!operation) throw new ValidationError('Say which existing code text should change and what should replace it.');
  const snapshot = snapshotFor(db, ctx.workspaceId, operation);
  const integrityHash = hash(snapshot);
  const existing = db.prepare(`SELECT * FROM catalog_code_change_proposals
    WHERE workspace_id = ? AND integrity_hash = ? AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`)
    .get(ctx.workspaceId, integrityHash);
  if (existing) return hydrate(existing);
  const id = newId('ccp');
  db.prepare(`INSERT INTO catalog_code_change_proposals
    (id, workspace_id, requested_by_user_id, instruction, operation, snapshot, integrity_hash, status, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', '{}', ?)`)
    .run(id, ctx.workspaceId, membership.id, instruction, JSON.stringify(operation),
      JSON.stringify(snapshot), integrityHash, nowIso());
  return get(db, ctx.workspaceId, id);
}

function approve(db, ctx, membership, id, expectedHash) {
  if (!membership || membership.role !== 'owner') throw new AuthorizationError('Only an owner can change catalogue codes.');
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'COMPLETED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That code change was cancelled.');
  if (!expectedHash || expectedHash !== proposal.integrityHash) throw new ValidationError('Review the current code changes before approving.');
  const current = snapshotFor(db, ctx.workspaceId, proposal.operation);
  if (hash(current) !== proposal.integrityHash) {
    throw new ValidationError('Catalogue codes changed after this preview was prepared. Ask Foundry again to prepare a current preview.');
  }
  return inTransaction(db, () => {
    const now = nowIso();
    for (const item of current.items) {
      if (item.newBaseCode !== item.oldBaseCode) {
        db.prepare('UPDATE items SET base_code = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
          .run(item.newBaseCode, now, ctx.workspaceId, item.itemId);
      }
      for (const sku of item.skus) {
        db.prepare('UPDATE skus SET code = ? WHERE workspace_id = ? AND id = ?')
          .run(sku.newCode, ctx.workspaceId, sku.skuId);
      }
    }
    const result = { productCount: current.productCount, skuCount: current.skuCount,
      from: proposal.operation.from, to: proposal.operation.to };
    db.prepare(`UPDATE catalog_code_change_proposals SET status = 'COMPLETED', approved_by_user_id = ?,
      result = ?, completed_at = ? WHERE workspace_id = ? AND id = ?`)
      .run(membership.id, JSON.stringify(result), now, ctx.workspaceId, id);
    return get(db, ctx.workspaceId, id);
  });
}

function cancel(db, workspaceId, id) {
  const proposal = get(db, workspaceId, id);
  if (proposal.status === 'PENDING') db.prepare(
    "UPDATE catalog_code_change_proposals SET status = 'CANCELLED' WHERE workspace_id = ? AND id = ?"
  ).run(workspaceId, id);
  return get(db, workspaceId, id);
}

module.exports = { parseInstruction, matchesInstruction, normaliseOperation, transform, snapshotFor, create, get, approve, cancel };
