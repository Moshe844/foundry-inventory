'use strict';

const crypto = require('node:crypto');
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');
const prices = require('../pricing/price-service');
const suppliers = require('../purchasing/supplier-service');

const PURCHASE_COST = /\b(?:supplier|vendor|purchase|purchasing|buying|wholesale|unit)\s+(?:price|cost)\b|\b(?:price|amount)\s+(?:i|we)\s+pay\b|\bwhat\s+(?:i|we)\s+pay\s+(?:our\s+)?suppliers?\b/i;
const CHANGE = /\b(?:add|set|change|update|make|record|apply|use|put)\b/i;
const MONEY = /[$£€¥]\s*[\d,]+(?:\.\d{1,2})?|\b(?:USD|EUR|GBP|CAD|AUD|JPY)\s*[\d,]+(?:\.\d{1,2})?/i;
const INFORMATION_ONLY = /^\s*(?:why|what|where|when|who|how much|does|do|did|is|are|was|were)\b/i;

function matchesInstruction(message) {
  const text = String(message || '').trim();
  if (!PURCHASE_COST.test(text) || !MONEY.test(text) || !CHANGE.test(text)) return false;
  return !INFORMATION_ONLY.test(text);
}

function moneyFrom(message) {
  const text = String(message || '');
  const symbol = text.match(/([$£€¥])\s*([\d,]+(?:\.\d{1,2})?)/);
  const coded = text.match(/\b(USD|EUR|GBP|CAD|AUD|JPY)\s*([\d,]+(?:\.\d{1,2})?)/i);
  const amount = Number(String((symbol && symbol[2]) || (coded && coded[2]) || '').replace(/,/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('What purchase cost per inventory unit should Foundry use?');
  const currency = coded ? coded[1].toUpperCase()
    : ({ '$': 'USD', '£': 'GBP', '€': 'EUR', '¥': 'JPY' }[(symbol && symbol[1]) || '$'] || 'USD');
  return { amount, amountMinor: prices.toMinor(String(amount), 'Purchase cost'), currency };
}

function catalogue(db, workspaceId) {
  return db.prepare(`SELECT s.id AS sku_id, s.item_id, s.code, s.variant_label, i.name AS item_name
    FROM skus s JOIN items i ON i.id = s.item_id
    WHERE s.workspace_id = ? AND s.is_active = 1 AND i.is_active = 1
    ORDER BY i.name, s.position`).all(workspaceId);
}

function targetSkuIds(db, workspaceId, message) {
  const rows = catalogue(db, workspaceId);
  if (!rows.length) throw new ValidationError('There are no inventory products to cost yet.');
  const lower = String(message || '').toLowerCase();
  const named = rows.filter((row) => [row.code, row.item_name]
    .filter(Boolean).some((value) => lower.includes(String(value).toLowerCase())));
  if (named.length) return [...new Set(named.map((row) => row.sku_id))];
  const allScope = /\b(?:all|every|each)\b[\s\S]{0,35}\b(?:item|items|product|products|sku|skus|variant|variants)\b/i.test(message)
    || /\b(?:my|our|the)\s+(?:inventory\s+)?(?:items|products|skus|variants)\b/i.test(message);
  if (allScope || rows.length === 1) return rows.map((row) => row.sku_id);
  throw new ValidationError('Which product should receive this purchase cost? You can also say “all inventory items.”');
}

function applicableSupplierItem(db, workspaceId, skuId) {
  const rows = db.prepare(`SELECT si.id, si.is_preferred FROM supplier_items si
    JOIN suppliers s ON s.id = si.supplier_id
    WHERE si.workspace_id = ? AND si.sku_id = ? AND si.is_active = 1 AND s.status = 'active'
    ORDER BY si.is_preferred DESC, si.updated_at DESC`).all(workspaceId, skuId);
  const preferred = rows.filter((row) => row.is_preferred);
  if (preferred.length === 1) return preferred[0].id;
  return rows.length === 1 ? rows[0].id : null;
}

function currentFingerprint(current) {
  if (!current) return null;
  return { id: current.id || current.supplier_item_id || null, amountMinor: current.amount_minor, currency: current.currency };
}

function integrity(input) {
  return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function createProposal(db, ctx, input) {
  const sku = prices.requireSku(db, ctx.workspaceId, input.skuId);
  const current = prices.purchaseCostForSku(db, ctx.workspaceId, sku.id);
  if (current && current.amount_minor === input.amountMinor && current.currency === input.currency) return null;
  const supplierItemId = applicableSupplierItem(db, ctx.workspaceId, sku.id);
  const payload = { workspaceId: ctx.workspaceId, skuId: sku.id, amountMinor: input.amountMinor,
    currency: input.currency, supplierItemId, current: currentFingerprint(current) };
  const id = newId('pcpurch');
  db.prepare(`INSERT INTO purchase_cost_change_proposals
    (id, workspace_id, sku_id, amount_minor, currency, supplier_item_id, source_text,
     status, current_cost_id, integrity_hash, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`)
    .run(id, ctx.workspaceId, sku.id, input.amountMinor, input.currency, supplierItemId,
      input.sourceText, current && current.id || null, integrity(payload), ctx.actorId, nowIso());
  return get(db, ctx.workspaceId, id);
}

function get(db, workspaceId, id) {
  const row = db.prepare(`SELECT p.*, s.item_id, s.code, s.variant_label, i.name AS item_name,
      sup.name AS supplier_name
    FROM purchase_cost_change_proposals p
    JOIN skus s ON s.id = p.sku_id JOIN items i ON i.id = s.item_id
    LEFT JOIN supplier_items si ON si.id = p.supplier_item_id
    LEFT JOIN suppliers sup ON sup.id = si.supplier_id
    WHERE p.id = ? AND p.workspace_id = ?`).get(id, workspaceId);
  if (!row) throw new NotFoundError('That purchase-cost change is not in this inventory.');
  const current = prices.purchaseCostForSku(db, workspaceId, row.sku_id);
  const selling = prices.currentForSku(db, workspaceId, row.sku_id);
  const differenceMinor = selling.isSet ? selling.amount_minor - row.amount_minor : null;
  return { ...row, current,
    displayName: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
    currentFormatted: current ? current.formatted : 'Not set',
    proposedFormatted: prices.formatMinor(row.amount_minor, row.currency),
    sellingPrice: selling, differenceMinor,
    belowCost: differenceMinor !== null && differenceMinor < 0,
    marginFormatted: differenceMinor === null ? null : prices.formatMinor(Math.abs(differenceMinor), row.currency) };
}

function prepare(db, ctx, message) {
  const instruction = requireText(message, 'Purchase-cost instruction', { max: 1200 });
  const money = moneyFrom(instruction);
  const skuIds = targetSkuIds(db, ctx.workspaceId, instruction);
  const proposals = db.transaction(() => skuIds.map((skuId) => createProposal(db, ctx, {
    skuId, amountMinor: money.amountMinor, currency: money.currency, sourceText: instruction,
  })).filter(Boolean))();
  if (!proposals.length) throw new ValidationError('Every selected product already has that purchase cost.');
  return { instruction, proposals, unitCostMinor: money.amountMinor, currency: money.currency,
    productCount: proposals.length, belowCostCount: proposals.filter((proposal) => proposal.belowCost).length };
}

function approve(db, ctx, membership, id, expectedHash) {
  const proposal = get(db, ctx.workspaceId, id);
  if (proposal.status === 'COMPLETED') return proposal;
  if (proposal.status !== 'PENDING') throw new ValidationError('That purchase-cost change is no longer waiting for approval.');
  if (expectedHash !== proposal.integrity_hash) throw new ValidationError('That purchase-cost preview changed. Review it again.');
  const current = prices.purchaseCostForSku(db, ctx.workspaceId, proposal.sku_id);
  const check = integrity({ workspaceId: ctx.workspaceId, skuId: proposal.sku_id,
    amountMinor: proposal.amount_minor, currency: proposal.currency,
    supplierItemId: proposal.supplier_item_id, current: currentFingerprint(current) });
  if (check !== proposal.integrity_hash) throw new ValidationError('The current purchase cost changed after this preview was prepared. Start again from the latest cost.');
  prices.setPurchaseCost(db, ctx, { skuId: proposal.sku_id, amountMinor: proposal.amount_minor,
    currency: proposal.currency, supplierItemId: proposal.supplier_item_id,
    source: 'approved_instruction', sourceDetail: { proposalId: proposal.id, statedAs: proposal.source_text } });
  if (proposal.supplier_item_id) suppliers.updateItemCost(db, ctx, membership, proposal.supplier_item_id, proposal.amount_minor / 100);
  db.prepare(`UPDATE purchase_cost_change_proposals SET status = 'COMPLETED', approved_by_user_id = ?, completed_at = ?
    WHERE id = ? AND workspace_id = ?`).run(ctx.actorId, nowIso(), id, ctx.workspaceId);
  return get(db, ctx.workspaceId, id);
}

function approveBatch(db, ctx, membership, entries) {
  return db.transaction(() => entries.map((entry) => approve(db, ctx, membership, entry.id, entry.integrityHash)))();
}

function cancelBatch(db, workspaceId, ids) {
  return db.transaction(() => ids.map((id) => {
    const proposal = get(db, workspaceId, id);
    if (proposal.status === 'PENDING') db.prepare(`UPDATE purchase_cost_change_proposals SET status = 'CANCELLED', cancelled_at = ?
      WHERE id = ? AND workspace_id = ?`).run(nowIso(), id, workspaceId);
    return get(db, workspaceId, id);
  }))();
}

module.exports = { matchesInstruction, moneyFrom, targetSkuIds, prepare, get, approve, approveBatch, cancelBatch };
