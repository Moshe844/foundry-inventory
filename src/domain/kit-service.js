'use strict';

const { newId, nowIso } = require('../lib/util');
const { ValidationError, NotFoundError } = require('./errors');
const repo = require('./repository');

const positive = (value, label = 'Quantity') => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ValidationError(`${label} must be a positive whole number.`);
  }
  return number;
};

function definition(db, workspaceId, kitSkuId) {
  const kit = db.prepare(`${repo.SKU_SELECT} WHERE s.workspace_id = ? AND s.id = ? AND s.is_active = 1`)
    .get(workspaceId, kitSkuId);
  if (!kit) throw new NotFoundError('That kit SKU is not in this inventory.');
  const components = db.prepare(`SELECT kc.*, s.code, s.variant_label, i.name AS item_name,
      i.tracking_mode, i.unit_label
    FROM kit_components kc
    JOIN skus s ON s.id = kc.component_sku_id
    JOIN items i ON i.id = s.item_id
    WHERE kc.workspace_id = ? AND kc.kit_sku_id = ?
    ORDER BY i.name COLLATE NOCASE, s.variant_label COLLATE NOCASE, s.code`)
    .all(workspaceId, kitSkuId);
  return { kit, components, isKit: components.length > 0 };
}

function isKit(db, workspaceId, skuId) {
  return Boolean(db.prepare('SELECT 1 FROM kit_components WHERE workspace_id = ? AND kit_sku_id = ? LIMIT 1')
    .get(workspaceId, skuId));
}

function assertNoCycle(db, workspaceId, kitSkuId, componentSkuId) {
  const seen = new Set();
  const visit = (skuId) => {
    if (skuId === kitSkuId) throw new ValidationError('A kit cannot contain itself, directly or through another kit.');
    if (seen.has(skuId)) return;
    seen.add(skuId);
    for (const row of db.prepare('SELECT component_sku_id FROM kit_components WHERE workspace_id = ? AND kit_sku_id = ?')
      .all(workspaceId, skuId)) visit(row.component_sku_id);
  };
  visit(componentSkuId);
}

function normaliseDefinition(db, workspaceId, kitSkuId, supplied) {
  const kit = repo.requireSku(db, workspaceId, kitSkuId);
  if (!Array.isArray(supplied) || !supplied.length) {
    throw new ValidationError('Name at least one component SKU and quantity for this kit.');
  }
  const merged = new Map();
  for (const raw of supplied) {
    const component = repo.requireSku(db, workspaceId, raw.skuId);
    if (component.id === kit.id) throw new ValidationError('A kit cannot contain itself.');
    assertNoCycle(db, workspaceId, kit.id, component.id);
    merged.set(component.id, (merged.get(component.id) || 0) + positive(raw.quantity, 'Component quantity'));
  }
  return [...merged].map(([skuId, quantity]) => ({ skuId, quantity }));
}

function define(db, ctx, input) {
  const kit = repo.requireSku(db, ctx.workspaceId, input.kitSkuId);
  const components = normaliseDefinition(db, ctx.workspaceId, kit.id, input.components);
  const now = nowIso();
  const transaction = db.transaction(() => {
    db.prepare('DELETE FROM kit_components WHERE workspace_id = ? AND kit_sku_id = ?')
      .run(ctx.workspaceId, kit.id);
    const insert = db.prepare(`INSERT INTO kit_components
      (id, workspace_id, kit_sku_id, component_sku_id, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const component of components) {
      insert.run(newId('kitc'), ctx.workspaceId, kit.id, component.skuId, component.quantity, now, now);
    }
  });
  transaction();
  return definition(db, ctx.workspaceId, kit.id);
}

function explode(db, workspaceId, kitSkuId, multiplier = 1, path = new Set()) {
  if (path.has(kitSkuId)) throw new ValidationError('This kit definition contains a cycle.');
  const direct = db.prepare('SELECT component_sku_id, quantity FROM kit_components WHERE workspace_id = ? AND kit_sku_id = ?')
    .all(workspaceId, kitSkuId);
  if (!direct.length) return [{ skuId: kitSkuId, quantity: multiplier }];
  const nextPath = new Set(path).add(kitSkuId);
  const totals = new Map();
  for (const row of direct) {
    for (const leaf of explode(db, workspaceId, row.component_sku_id, multiplier * Number(row.quantity), nextPath)) {
      totals.set(leaf.skuId, (totals.get(leaf.skuId) || 0) + leaf.quantity);
    }
  }
  return [...totals].map(([skuId, quantity]) => ({ skuId, quantity }));
}

function snapshotOrderLine(db, workspaceId, salesOrderLineId, kitSkuId, kitsOrdered) {
  if (!isKit(db, workspaceId, kitSkuId)) return [];
  const components = explode(db, workspaceId, kitSkuId);
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO sales_order_kit_components
    (id, workspace_id, sales_order_line_id, component_sku_id, quantity_per_kit,
     quantity_required, quantity_fulfilled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`);
  return components.map((component) => {
    const id = newId('sokc');
    insert.run(id, workspaceId, salesOrderLineId, component.skuId, component.quantity,
      component.quantity * positive(kitsOrdered, 'Kit quantity'), now, now);
    return { id, ...component };
  });
}

function orderComponents(db, workspaceId, salesOrderLineId) {
  return db.prepare(`SELECT c.*, s.code, s.variant_label, i.name AS item_name,
      i.tracking_mode, i.unit_label
    FROM sales_order_kit_components c
    JOIN skus s ON s.id = c.component_sku_id
    JOIN items i ON i.id = s.item_id
    WHERE c.workspace_id = ? AND c.sales_order_line_id = ?
    ORDER BY i.name COLLATE NOCASE, s.variant_label COLLATE NOCASE, s.code`)
    .all(workspaceId, salesOrderLineId);
}

module.exports = {
  define, definition, isKit, explode, snapshotOrderLine, orderComponents,
  normaliseDefinition, positive,
};
