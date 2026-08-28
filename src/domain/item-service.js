'use strict';

const { inTransaction } = require('../db');
const repo = require('./repository');
const { ValidationError, InvariantError } = require('./errors');
const { TRACKING_MODE_IDS } = require('./constants');
const entitlements = require('../entitlements/service');
const {
  newId,
  nowIso,
  trimOrNull,
  requireText,
  requireOneOf,
} = require('../lib/util');

const MAX_OPTIONS = 3;
const MAX_VARIANTS = 200;

function codeSlug(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
}

function uniqueCode(db, workspaceId, candidate, taken) {
  const base = candidate || 'SKU';
  let code = base;
  let n = 1;
  const exists = (value) =>
    taken.has(value.toLowerCase()) ||
    !!db.prepare('SELECT 1 FROM skus WHERE workspace_id = ? AND code = ? COLLATE NOCASE').get(workspaceId, value);
  while (exists(code)) {
    n += 1;
    code = `${base}-${n}`;
  }
  taken.add(code.toLowerCase());
  return code;
}

/**
 * Parses the option axes captured by the item-creation form.
 * Input shape: [{ name: 'Color', values: 'Navy, Cream' }, ...]
 */
function parseOptions(rawOptions) {
  const options = [];
  for (const raw of rawOptions || []) {
    if (!raw) continue;
    const name = trimOrNull(raw.name);
    const valuesRaw = typeof raw.values === 'string' ? raw.values.split(',') : raw.values || [];
    const values = valuesRaw.map((v) => trimOrNull(v)).filter(Boolean);
    if (!name && values.length === 0) continue;
    if (!name) throw new ValidationError('Give each option a name, such as Color or Size.');
    if (values.length === 0) {
      throw new ValidationError(`Add at least one choice for "${name}".`);
    }
    const seen = new Set();
    for (const value of values) {
      const key = value.toLowerCase();
      if (seen.has(key)) throw new ValidationError(`"${value}" is listed twice under ${name}.`);
      seen.add(key);
    }
    options.push({ name, values });
  }
  if (options.length === 0) {
    throw new ValidationError('Add at least one option, such as Size or Color.');
  }
  if (options.length > MAX_OPTIONS) {
    throw new ValidationError(`Mission 1 supports up to ${MAX_OPTIONS} option axes.`);
  }
  const total = options.reduce((acc, o) => acc * o.values.length, 1);
  if (total > MAX_VARIANTS) {
    throw new ValidationError(`That would create ${total} variants. Keep it under ${MAX_VARIANTS}.`);
  }
  return options;
}

function combinations(options) {
  return options.reduce(
    (acc, option) =>
      acc.flatMap((combo) => option.values.map((value) => [...combo, { option: option.name, value }])),
    [[]]
  );
}

function createItem(db, ctx, input) {
  return inTransaction(db, () => {
    // A variant item creates several SKUs at once; the check counts what the
    // plan actually limits rather than the item the person thinks they added.
    entitlements.assertWithin(db, ctx, 'skus');
    const now = nowIso();
    const name = requireText(input.name, 'Item name');
    const trackingMode = requireOneOf(input.trackingMode, TRACKING_MODE_IDS, 'Tracking type');
    const hasVariants = input.hasVariants === true || input.hasVariants === 'on' || input.hasVariants === '1';
    const baseCode = trimOrNull(input.baseCode);
    const description = trimOrNull(input.description);
    const unitLabel = trimOrNull(input.unitLabel) || 'unit';

    if (baseCode) {
      const clash = db
        .prepare('SELECT 1 FROM items WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE')
        .get(ctx.workspaceId, baseCode);
      if (clash) throw new ValidationError(`Another item already uses the code ${baseCode}.`, { field: 'baseCode' });
    }

    const itemId = newId('item');
    db.prepare(
      `INSERT INTO items (
         id, workspace_id, name, base_code, description, unit_label, tracking_mode,
         has_variants, allow_negative, is_active, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
    ).run(itemId, ctx.workspaceId, name, baseCode, description, unitLabel, trackingMode, hasVariants ? 1 : 0, now, now);

    const taken = new Set();
    const skuIds = [];

    if (hasVariants) {
      const options = parseOptions(input.options);
      const optionRows = options.map((option, index) => {
        const id = newId('opt');
        db.prepare('INSERT INTO item_options (id, workspace_id, item_id, name, position) VALUES (?, ?, ?, ?, ?)').run(
          id,
          ctx.workspaceId,
          itemId,
          option.name,
          index
        );
        return { ...option, id };
      });

      const combos = combinations(optionRows);
      combos.forEach((combo, index) => {
        const label = combo.map((c) => c.value).join(' / ');
        const codeBase = [baseCode || codeSlug(name), ...combo.map((c) => codeSlug(c.value))]
          .filter(Boolean)
          .join('-');
        const code = uniqueCode(db, ctx.workspaceId, codeBase, taken);
        const skuId = newId('sku');
        db.prepare(
          `INSERT INTO skus (id, workspace_id, item_id, code, variant_label, is_default, position, is_active, created_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`
        ).run(skuId, ctx.workspaceId, itemId, code, label, index, now);
        for (const part of combo) {
          const optionRow = optionRows.find((o) => o.name === part.option);
          db.prepare('INSERT INTO sku_option_values (sku_id, option_id, value) VALUES (?, ?, ?)').run(
            skuId,
            optionRow.id,
            part.value
          );
        }
        skuIds.push(skuId);
      });
    } else {
      const code = uniqueCode(db, ctx.workspaceId, baseCode || codeSlug(name), taken);
      const skuId = newId('sku');
      db.prepare(
        `INSERT INTO skus (id, workspace_id, item_id, code, variant_label, is_default, position, is_active, created_at)
         VALUES (?, ?, ?, ?, NULL, 1, 0, 1, ?)`
      ).run(skuId, ctx.workspaceId, itemId, code, now);
      skuIds.push(skuId);
    }

    return { itemId, skuIds };
  });
}

function updateItem(db, ctx, itemId, input) {
  return inTransaction(db, () => {
    const item = repo.requireItem(db, ctx.workspaceId, itemId);
    const name = requireText(input.name, 'Item name');
    const baseCode = trimOrNull(input.baseCode);
    const description = trimOrNull(input.description);
    const unitLabel = trimOrNull(input.unitLabel) || 'unit';
    const allowNegative = input.allowNegative === true || input.allowNegative === 'on' || input.allowNegative === '1';

    if (baseCode) {
      const clash = db
        .prepare('SELECT 1 FROM items WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE AND id <> ?')
        .get(ctx.workspaceId, baseCode, itemId);
      if (clash) throw new ValidationError(`Another item already uses the code ${baseCode}.`, { field: 'baseCode' });
    }
    if (allowNegative && item.tracking_mode !== 'quantity') {
      throw new ValidationError('Negative stock can only be allowed on quantity-tracked items.');
    }

    db.prepare(
      `UPDATE items
          SET name = ?, base_code = ?, description = ?, unit_label = ?, allow_negative = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`
    ).run(name, baseCode, description, unitLabel, allowNegative ? 1 : 0, nowIso(), itemId, ctx.workspaceId);

    return repo.requireItem(db, ctx.workspaceId, itemId);
  });
}

function addVariant(db, ctx, itemId, values) {
  return inTransaction(db, () => {
    const item = repo.requireItem(db, ctx.workspaceId, itemId);
    if (!item.has_variants) throw new ValidationError('This item does not use variants.');
    const options = db
      .prepare('SELECT * FROM item_options WHERE item_id = ? AND workspace_id = ? ORDER BY position')
      .all(itemId, ctx.workspaceId);

    const parts = options.map((option) => {
      const value = requireText(values[option.id] ?? values[option.name], option.name, { max: 80 });
      return { option, value };
    });

    const label = parts.map((p) => p.value).join(' / ');
    const duplicate = db
      .prepare('SELECT 1 FROM skus WHERE item_id = ? AND workspace_id = ? AND variant_label = ? COLLATE NOCASE')
      .get(itemId, ctx.workspaceId, label);
    if (duplicate) throw new InvariantError(`The variant "${label}" already exists.`, 'duplicate_variant');

    const codeBase = [item.base_code || codeSlug(item.name), ...parts.map((p) => codeSlug(p.value))].join('-');
    const code = uniqueCode(db, ctx.workspaceId, codeBase, new Set());
    const position = db
      .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM skus WHERE item_id = ?')
      .get(itemId).next;
    const skuId = newId('sku');
    db.prepare(
      `INSERT INTO skus (id, workspace_id, item_id, code, variant_label, is_default, position, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?)`
    ).run(skuId, ctx.workspaceId, itemId, code, label, position, nowIso());
    for (const part of parts) {
      db.prepare('INSERT INTO sku_option_values (sku_id, option_id, value) VALUES (?, ?, ?)').run(
        skuId,
        part.option.id,
        part.value
      );
    }
    return { skuId, code, label };
  });
}

function setItemActive(db, ctx, itemId, isActive) {
  const item = repo.requireItem(db, ctx.workspaceId, itemId);
  if (!isActive) {
    const total = repo.getItemTotal(db, ctx.workspaceId, itemId);
    if (total !== 0) {
      throw new InvariantError(
        `${item.name} still has ${total} on hand. Move or issue the stock before archiving it.`,
        'item_has_stock'
      );
    }
  }
  db.prepare('UPDATE items SET is_active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(
    isActive ? 1 : 0,
    nowIso(),
    itemId,
    ctx.workspaceId
  );
  return repo.requireItem(db, ctx.workspaceId, itemId);
}

/**
 * Creates an exact, already-known set of variants without inventing the
 * Cartesian product of their option values. Imports and provider bootstraps
 * use this boundary; provider code still never writes catalogue tables.
 */
function createExactItem(db, ctx, input) {
  return inTransaction(db, () => {
    const variants = Array.isArray(input.variants) ? input.variants : [];
    if (!variants.length) throw new ValidationError('Add at least one product variant.');
    if (variants.length > MAX_VARIANTS) throw new ValidationError(`Keep one product under ${MAX_VARIANTS} variants.`);
    entitlements.assertWithin(db, ctx, 'skus', { adding: variants.length });
    const now = nowIso();
    const name = requireText(input.name, 'Item name');
    const trackingMode = requireOneOf(input.trackingMode || 'quantity', TRACKING_MODE_IDS, 'Tracking type');
    const baseCode = trimOrNull(input.baseCode);
    if (baseCode && db.prepare('SELECT 1 FROM items WHERE workspace_id = ? AND base_code = ? COLLATE NOCASE')
      .get(ctx.workspaceId, baseCode)) {
      throw new ValidationError(`Another item already uses the code ${baseCode}.`, { field: 'baseCode' });
    }

    const optionNames = [];
    for (const variant of variants) {
      for (const rawName of Object.keys(variant.options || {})) {
        const optionName = requireText(rawName, 'Option name', { max: 80 });
        if (!optionNames.some((existing) => existing.toLowerCase() === optionName.toLowerCase())) optionNames.push(optionName);
      }
    }
    if (optionNames.length > MAX_OPTIONS) throw new ValidationError(`Use at most ${MAX_OPTIONS} option axes.`);
    const hasVariants = variants.length > 1 || optionNames.length > 0 || variants.some((variant) => trimOrNull(variant.label));
    const itemId = newId('item');
    db.prepare(`INSERT INTO items (
      id, workspace_id, name, base_code, description, unit_label, tracking_mode,
      has_variants, allow_negative, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`)
      .run(itemId, ctx.workspaceId, name, baseCode, trimOrNull(input.description),
        trimOrNull(input.unitLabel) || 'unit', trackingMode, hasVariants ? 1 : 0, now, now);

    const optionRows = optionNames.map((optionName, position) => {
      const id = newId('opt');
      db.prepare('INSERT INTO item_options (id, workspace_id, item_id, name, position) VALUES (?, ?, ?, ?, ?)')
        .run(id, ctx.workspaceId, itemId, optionName, position);
      return { id, name: optionName };
    });
    const taken = new Set();
    const created = variants.map((variant, position) => {
      const values = optionRows.map((option) => {
        const matchingKey = Object.keys(variant.options || {}).find((key) => key.toLowerCase() === option.name.toLowerCase());
        return matchingKey ? requireText(variant.options[matchingKey], option.name, { max: 80 }) : null;
      });
      const label = hasVariants
        ? trimOrNull(variant.label) || values.filter(Boolean).join(' / ') || `Variant ${position + 1}`
        : null;
      const fallback = [baseCode || codeSlug(name), hasVariants ? codeSlug(label) : null].filter(Boolean).join('-');
      const code = uniqueCode(db, ctx.workspaceId, trimOrNull(variant.code) || fallback, taken);
      const skuId = newId('sku');
      db.prepare(`INSERT INTO skus
        (id, workspace_id, item_id, code, variant_label, is_default, position, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`)
        .run(skuId, ctx.workspaceId, itemId, code, label, hasVariants ? 0 : 1, position, now);
      optionRows.forEach((option, index) => {
        if (values[index] !== null) db.prepare('INSERT INTO sku_option_values (sku_id, option_id, value) VALUES (?, ?, ?)')
          .run(skuId, option.id, values[index]);
      });
      return { skuId, code, label, sourceKey: variant.sourceKey || null };
    });
    return { itemId, skus: created, skuIds: created.map((row) => row.skuId) };
  });
}

/** Archive one variant without pretending that its zero balance is a count change. */
function setSkuActive(db, ctx, skuId, isActive) {
  const sku = db.prepare(
    `SELECT s.*, i.name AS item_name FROM skus s JOIN items i ON i.id = s.item_id
      WHERE s.id = ? AND s.workspace_id = ?`
  ).get(skuId, ctx.workspaceId);
  if (!sku) throw new ValidationError('That product or variant is not in this inventory.');
  if (!isActive) {
    const total = db.prepare(
      'SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ? AND sku_id = ?'
    ).get(ctx.workspaceId, skuId).n;
    if (total !== 0) {
      throw new InvariantError(
        `${sku.item_name}${sku.variant_label ? ` / ${sku.variant_label}` : ''} still has ${total} on hand. `
          + 'Move or issue the stock before archiving it.',
        'sku_has_stock'
      );
    }
  }
  const now = nowIso();
  db.prepare('UPDATE skus SET is_active = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
    .run(isActive ? 1 : 0, now, skuId, ctx.workspaceId);
  const active = db.prepare(
    'SELECT COUNT(*) AS n FROM skus WHERE workspace_id = ? AND item_id = ? AND is_active = 1'
  ).get(ctx.workspaceId, sku.item_id).n;
  if (!isActive && active === 0) {
    db.prepare('UPDATE items SET is_active = 0, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(now, sku.item_id, ctx.workspaceId);
  }
  return db.prepare('SELECT * FROM skus WHERE id = ? AND workspace_id = ?').get(skuId, ctx.workspaceId);
}

/** Full detail used by the item page: SKUs, per-location stock, lots, units. */
function getItemDetail(db, workspaceId, itemId) {
  const item = repo.requireItem(db, workspaceId, itemId);
  const skus = repo.listSkusForItem(db, workspaceId, itemId);
  const options = db
    .prepare('SELECT * FROM item_options WHERE item_id = ? AND workspace_id = ? ORDER BY position')
    .all(itemId, workspaceId);
  const locations = repo.listLocations(db, workspaceId);

  const balances = db
    .prepare(
      `SELECT b.sku_id, b.location_id, b.on_hand, l.name AS location_name
         FROM balances b
         JOIN skus s ON s.id = b.sku_id
         JOIN locations l ON l.id = b.location_id
        WHERE b.workspace_id = ? AND s.item_id = ?`
    )
    .all(workspaceId, itemId);

  const byLocation = new Map();
  for (const row of balances) {
    const current = byLocation.get(row.location_id) || { locationId: row.location_id, name: row.location_name, total: 0 };
    current.total += row.on_hand;
    byLocation.set(row.location_id, current);
  }

  const skuRows = skus.map((sku) => {
    const perLocation = balances
      .filter((b) => b.sku_id === sku.id)
      .map((b) => ({ locationId: b.location_id, locationName: b.location_name, onHand: b.on_hand }))
      .sort((a, b) => a.locationName.localeCompare(b.locationName));
    return {
      ...sku,
      total: perLocation.reduce((sum, row) => sum + row.onHand, 0),
      perLocation,
    };
  });

  let lots = [];
  let units = [];
  if (item.tracking_mode === 'lot') {
    lots = db
      .prepare(
        `SELECT lo.id, lo.code, lo.sku_id, lo.expires_at, lo.received_at, lo.note,
                s.variant_label,
                COALESCE(SUM(lb.quantity), 0) AS total
           FROM lots lo
           JOIN skus s ON s.id = lo.sku_id
           LEFT JOIN lot_balances lb ON lb.lot_id = lo.id
          WHERE lo.workspace_id = ? AND s.item_id = ?
          GROUP BY lo.id
          ORDER BY (lo.expires_at IS NULL), lo.expires_at, lo.code`
      )
      .all(workspaceId, itemId);
    const lotLocations = db
      .prepare(
        `SELECT lb.lot_id, lb.location_id, lb.quantity, l.name AS location_name
           FROM lot_balances lb
           JOIN locations l ON l.id = lb.location_id
           JOIN lots lo ON lo.id = lb.lot_id
           JOIN skus s ON s.id = lo.sku_id
          WHERE lb.workspace_id = ? AND s.item_id = ? AND lb.quantity <> 0`
      )
      .all(workspaceId, itemId);
    lots = lots.map((lot) => ({
      ...lot,
      perLocation: lotLocations.filter((l) => l.lot_id === lot.id),
    }));
  }

  if (item.tracking_mode === 'serial') {
    units = db
      .prepare(
        `SELECT su.*, l.name AS location_name, s.variant_label
           FROM serial_units su
           JOIN skus s ON s.id = su.sku_id
           LEFT JOIN locations l ON l.id = su.location_id
          WHERE su.workspace_id = ? AND s.item_id = ?
          ORDER BY su.status, su.serial`
      )
      .all(workspaceId, itemId);
  }

  const recent = require('./activity-service').listActivity(db, workspaceId, { itemId, limit: 12 }).groups;

  return {
    item,
    options,
    skus: skuRows,
    locations,
    locationTotals: [...byLocation.values()].sort((a, b) => a.name.localeCompare(b.name)),
    total: skuRows.reduce((sum, s) => sum + s.total, 0),
    lots,
    units,
    recent,
  };
}

module.exports = {
  createItem,
  createExactItem,
  updateItem,
  addVariant,
  setItemActive,
  setSkuActive,
  getItemDetail,
  parseOptions,
  codeSlug,
};
