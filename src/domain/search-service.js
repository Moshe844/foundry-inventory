'use strict';

const { escapeLike } = require('../lib/util');

/**
 * One search box, four kinds of answer: items, variants, serial numbers and
 * lots. Every result knows the record it should open.
 */
function search(db, workspaceId, rawTerm, { limit = 8 } = {}) {
  const term = String(rawTerm || '').trim();
  if (term.length < 1) return { term, results: [], total: 0 };
  const like = `%${escapeLike(term)}%`;
  const exact = term;

  const items = db
    .prepare(
      `SELECT i.id, i.name, i.base_code, i.tracking_mode, i.has_variants,
              COALESCE((SELECT SUM(b.on_hand) FROM balances b JOIN skus s ON s.id = b.sku_id
                         WHERE s.item_id = i.id), 0) AS on_hand
         FROM items i
        WHERE i.workspace_id = ?
          AND (i.name LIKE ? ESCAPE '\\' COLLATE NOCASE OR i.base_code LIKE ? ESCAPE '\\' COLLATE NOCASE)
        ORDER BY (i.name = ? COLLATE NOCASE) DESC, i.name COLLATE NOCASE
        LIMIT ?`
    )
    .all(workspaceId, like, like, exact, limit)
    .map((row) => ({
      type: 'item',
      id: row.id,
      title: row.name,
      subtitle: row.base_code ? `Item · ${row.base_code}` : 'Item',
      meta: `${row.on_hand} on hand`,
      href: `/inventory/${row.id}`,
      trackingMode: row.tracking_mode,
    }));

  const variants = db
    .prepare(
      `SELECT s.id, s.code, s.variant_label, s.item_id, i.name AS item_name, i.tracking_mode,
              COALESCE((SELECT SUM(b.on_hand) FROM balances b WHERE b.sku_id = s.id), 0) AS on_hand
         FROM skus s
         JOIN items i ON i.id = s.item_id
        WHERE s.workspace_id = ?
          AND (s.code LIKE ? ESCAPE '\\' COLLATE NOCASE OR s.variant_label LIKE ? ESCAPE '\\' COLLATE NOCASE)
        ORDER BY (s.code = ? COLLATE NOCASE) DESC, i.name COLLATE NOCASE
        LIMIT ?`
    )
    .all(workspaceId, like, like, exact, limit)
    .map((row) => ({
      type: row.variant_label ? 'variant' : 'sku',
      id: row.id,
      title: row.variant_label ? `${row.item_name} / ${row.variant_label}` : row.item_name,
      subtitle: `${row.variant_label ? 'Variant' : 'SKU'} · ${row.code}`,
      meta: `${row.on_hand} on hand`,
      href: `/inventory/${row.item_id}#sku-${row.id}`,
      trackingMode: row.tracking_mode,
    }));

  const serials = db
    .prepare(
      `SELECT su.id, su.serial, su.status, su.condition, s.item_id, s.variant_label,
              i.name AS item_name, l.name AS location_name
         FROM serial_units su
         JOIN skus s ON s.id = su.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN locations l ON l.id = su.location_id
        WHERE su.workspace_id = ? AND su.serial LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY (su.serial = ? COLLATE NOCASE) DESC, su.status, su.serial
        LIMIT ?`
    )
    .all(workspaceId, like, exact, limit)
    .map((row) => ({
      type: 'serial',
      id: row.id,
      title: row.serial,
      subtitle: `Unit · ${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''}`,
      meta: row.status === 'in_stock' ? `In stock · ${row.location_name}` : 'Issued',
      href: `/inventory/${row.item_id}#unit-${row.id}`,
    }));

  const lots = db
    .prepare(
      `SELECT lo.id, lo.code, lo.expires_at, s.item_id, s.variant_label, i.name AS item_name,
              COALESCE((SELECT SUM(lb.quantity) FROM lot_balances lb WHERE lb.lot_id = lo.id), 0) AS quantity
         FROM lots lo
         JOIN skus s ON s.id = lo.sku_id
         JOIN items i ON i.id = s.item_id
        WHERE lo.workspace_id = ? AND lo.code LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY (lo.code = ? COLLATE NOCASE) DESC, lo.code
        LIMIT ?`
    )
    .all(workspaceId, like, exact, limit)
    .map((row) => ({
      type: 'lot',
      id: row.id,
      title: `Lot ${row.code}`,
      subtitle: `${row.item_name}${row.variant_label ? ` / ${row.variant_label}` : ''}`,
      meta: `${row.quantity} on hand${row.expires_at ? ` · expires ${row.expires_at.slice(0, 10)}` : ''}`,
      href: `/inventory/${row.item_id}#lot-${row.id}`,
    }));

  const results = [...items, ...variants, ...serials, ...lots];
  return { term, results, total: results.length, groups: { items, variants, serials, lots } };
}

module.exports = { search };
