'use strict';

/** Deterministic record attributes used by catalog search and policy groups. */
const { newId, nowIso, requireText } = require('../lib/util');
const { ValidationError, NotFoundError } = require('../domain/errors');

const SUBJECTS = new Set(['item', 'sku', 'supplier', 'location']);
const TABLE = { item: 'items', sku: 'skus', supplier: 'suppliers', location: 'locations' };
const OPS = new Set(['equals', 'in', 'exists']);

function requireSubject(db, workspaceId, subjectType, subjectId) {
  if (!SUBJECTS.has(subjectType)) throw new ValidationError(`Attributes cannot be attached to ${subjectType}.`);
  const row = db.prepare(`SELECT id FROM ${TABLE[subjectType]} WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, subjectId);
  if (!row) throw new NotFoundError(`That ${subjectType} is not in this inventory.`);
}

function set(db, ctx, subjectType, subjectId, input, source = 'owner') {
  requireSubject(db, ctx.workspaceId, subjectType, subjectId);
  const key = requireText(input.key, 'Attribute name', { max: 100 }).trim().toLowerCase();
  const values = (Array.isArray(input.values) ? input.values : [input.value])
    .map((value) => requireText(value, 'Attribute value', { max: 300 }));
  if (values.length > 100) throw new ValidationError('Keep one attribute under 100 values.');
  const now = nowIso();
  const replace = input.replace !== false;
  const tx = db.transaction(() => {
    if (replace) db.prepare(`DELETE FROM catalog_attributes
      WHERE workspace_id = ? AND subject_type = ? AND subject_id = ? AND attribute_key = ?`)
      .run(ctx.workspaceId, subjectType, subjectId, key);
    const insert = db.prepare(`INSERT OR IGNORE INTO catalog_attributes
      (id, workspace_id, subject_type, subject_id, attribute_key, attribute_value, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const value of values) insert.run(newId('attr'), ctx.workspaceId, subjectType, subjectId,
      key, value, source, now, now);
  });
  tx.immediate();
  return list(db, ctx.workspaceId, subjectType, subjectId);
}

function list(db, workspaceId, subjectType, subjectId) {
  requireSubject(db, workspaceId, subjectType, subjectId);
  return db.prepare(`SELECT attribute_key AS key, attribute_value AS value, source
    FROM catalog_attributes WHERE workspace_id = ? AND subject_type = ? AND subject_id = ?
    ORDER BY attribute_key, attribute_value COLLATE NOCASE`).all(workspaceId, subjectType, subjectId);
}

function validateSelector(selector) {
  if (selector === undefined || selector === null) return {};
  if (typeof selector !== 'object' || Array.isArray(selector)) throw new ValidationError('A group selector must be structured data.');
  const clean = {};
  for (const group of ['all', 'any', 'none']) {
    if (selector[group] === undefined) continue;
    if (!Array.isArray(selector[group]) || selector[group].length > 50) {
      throw new ValidationError(`A selector's ${group} group must contain at most 50 criteria.`);
    }
    clean[group] = selector[group].map((raw) => {
      const key = requireText(raw.key, 'Selector attribute', { max: 100 }).trim().toLowerCase();
      const op = raw.op || (Array.isArray(raw.value) ? 'in' : 'equals');
      if (!OPS.has(op)) throw new ValidationError(`Selector operation ${op} is not supported.`);
      const value = op === 'exists' ? null : raw.value;
      if (op === 'in' && (!Array.isArray(value) || !value.length || value.length > 100)) {
        throw new ValidationError('An "in" selector needs 1–100 values.');
      }
      if (op === 'equals' && (value === undefined || value === null || String(value).trim() === '')) {
        throw new ValidationError('An equality selector needs a value.');
      }
      return { key, op, value };
    });
  }
  return clean;
}

function criterionMatches(values, criterion) {
  const owned = values.get(criterion.key) || [];
  if (criterion.op === 'exists') return owned.length > 0;
  if (criterion.op === 'equals') return owned.some((value) => value.toLowerCase() === String(criterion.value).toLowerCase());
  const wanted = new Set(criterion.value.map((value) => String(value).toLowerCase()));
  return owned.some((value) => wanted.has(value.toLowerCase()));
}

function matches(db, workspaceId, subjectType, subjectId, rawSelector) {
  const selector = validateSelector(rawSelector);
  if (!Object.keys(selector).length) return true;
  requireSubject(db, workspaceId, subjectType, subjectId);
  const rows = db.prepare(`SELECT attribute_key, attribute_value FROM catalog_attributes
    WHERE workspace_id = ? AND subject_type = ? AND subject_id = ?`).all(workspaceId, subjectType, subjectId);
  const values = new Map();
  for (const row of rows) values.set(row.attribute_key,
    [...(values.get(row.attribute_key) || []), row.attribute_value]);
  const all = (selector.all || []).every((criterion) => criterionMatches(values, criterion));
  const any = !(selector.any || []).length || selector.any.some((criterion) => criterionMatches(values, criterion));
  const none = !(selector.none || []).some((criterion) => criterionMatches(values, criterion));
  return all && any && none;
}

function matchesProduct(db, workspaceId, plan, selector) {
  if (!selector || !Object.keys(selector).length) return true;
  let itemId = plan.itemId || null;
  if (!itemId && plan.skuId) itemId = (db.prepare('SELECT item_id FROM skus WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, plan.skuId) || {}).item_id;
  return (plan.skuId && matches(db, workspaceId, 'sku', plan.skuId, selector))
    || (itemId && matches(db, workspaceId, 'item', itemId, selector));
}

module.exports = { SUBJECTS, set, list, matches, matchesProduct, validateSelector };
