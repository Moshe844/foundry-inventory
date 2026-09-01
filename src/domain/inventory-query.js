'use strict';

const { escapeLike } = require('../lib/util');
const { TRACKING_MODE_IDS } = require('./constants');

/**
 * Read models for the Inventory list and the Overview.
 * Totals always come from `balances`, which the engine keeps in step with the
 * movement ledger; nothing here recomputes stock on its own.
 */

function listItems(db, workspaceId, options = {}) {
  const limit = Math.min(Number(options.limit) || 50, 200);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const where = ['i.workspace_id = @workspaceId'];
  const params = { workspaceId, limit: limit + 1, offset };

  if (options.archivedOnly) where.push('i.is_active = 0');
  else if (!options.includeArchived) where.push('i.is_active = 1');
  if (Array.isArray(options.itemIds) && options.itemIds.length) {
    const names = options.itemIds.map((id, index) => {
      const name = `sourceItem${index}`;
      params[name] = id;
      return `@${name}`;
    });
    where.push(`i.id IN (${names.join(',')})`);
  }

  if (options.q) {
    const term = `%${escapeLike(String(options.q).trim())}%`;
    params.term = term;
    where.push(`(
      i.name LIKE @term ESCAPE '\\' COLLATE NOCASE
      OR i.base_code LIKE @term ESCAPE '\\' COLLATE NOCASE
      OR i.description LIKE @term ESCAPE '\\' COLLATE NOCASE
      OR EXISTS (SELECT 1 FROM skus s2 WHERE s2.item_id = i.id AND (
           s2.code LIKE @term ESCAPE '\\' COLLATE NOCASE
        OR s2.variant_label LIKE @term ESCAPE '\\' COLLATE NOCASE))
      OR EXISTS (SELECT 1 FROM serial_units su JOIN skus s3 ON s3.id = su.sku_id
                  WHERE s3.item_id = i.id AND su.serial LIKE @term ESCAPE '\\' COLLATE NOCASE)
      OR EXISTS (SELECT 1 FROM lots lo JOIN skus s4 ON s4.id = lo.sku_id
                  WHERE s4.item_id = i.id AND lo.code LIKE @term ESCAPE '\\' COLLATE NOCASE)
    )`);
  }

  if (options.trackingMode && TRACKING_MODE_IDS.includes(options.trackingMode)) {
    where.push('i.tracking_mode = @trackingMode');
    params.trackingMode = options.trackingMode;
  }
  if (options.hasVariants === true) where.push('i.has_variants = 1');

  if (options.locationId) {
    params.locationId = options.locationId;
    where.push(`EXISTS (SELECT 1 FROM balances b2 JOIN skus s5 ON s5.id = b2.sku_id
                         WHERE s5.item_id = i.id AND b2.location_id = @locationId AND b2.on_hand <> 0)`);
  }

  const stockExpr = options.locationId
    ? `COALESCE((SELECT SUM(b.on_hand) FROM balances b JOIN skus s ON s.id = b.sku_id
                  WHERE s.item_id = i.id AND b.location_id = @locationId), 0)`
    : `COALESCE((SELECT SUM(b.on_hand) FROM balances b JOIN skus s ON s.id = b.sku_id
                  WHERE s.item_id = i.id), 0)`;

  const sql = `
    SELECT i.*,
           ${stockExpr} AS on_hand,
           (SELECT COUNT(*) FROM skus s WHERE s.item_id = i.id) AS sku_count,
           (SELECT COUNT(DISTINCT b.location_id) FROM balances b JOIN skus s ON s.id = b.sku_id
             WHERE s.item_id = i.id AND b.on_hand <> 0) AS location_count,
           (SELECT s.code FROM skus s WHERE s.item_id = i.id ORDER BY s.position LIMIT 1) AS first_sku_code
      FROM items i
     WHERE ${where.join(' AND ')}
     ORDER BY ${orderClause(options.sort)}
     LIMIT @limit OFFSET @offset`;

  const rows = db.prepare(sql).all(params);
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit), hasMore, offset, limit };
}

function orderClause(sort) {
  switch (sort) {
    case 'stock_asc':
      return 'on_hand ASC, i.name COLLATE NOCASE';
    case 'stock_desc':
      return 'on_hand DESC, i.name COLLATE NOCASE';
    case 'newest':
      return 'i.created_at DESC';
    default:
      return 'i.name COLLATE NOCASE';
  }
}

function overview(db, workspaceId) {
  const itemCount = db
    .prepare('SELECT COUNT(*) AS n FROM items WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const locationCount = db
    .prepare('SELECT COUNT(*) AS n FROM locations WHERE workspace_id = ? AND is_active = 1')
    .get(workspaceId).n;
  const unitsOnHand = db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS n FROM balances WHERE workspace_id = ?')
    .get(workspaceId).n;

  const zeroStock = db
    .prepare(
      `SELECT i.id, i.name, i.tracking_mode, i.base_code
         FROM items i
        WHERE i.workspace_id = ? AND i.is_active = 1
          AND COALESCE((SELECT SUM(b.on_hand) FROM balances b
                         JOIN skus s ON s.id = b.sku_id
                        WHERE s.item_id = i.id), 0) = 0
        ORDER BY i.name COLLATE NOCASE
        LIMIT 8`
    )
    .all(workspaceId);

  const zeroCount = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i
        WHERE i.workspace_id = ? AND i.is_active = 1
          AND COALESCE((SELECT SUM(b.on_hand) FROM balances b
                         JOIN skus s ON s.id = b.sku_id
                        WHERE s.item_id = i.id), 0) = 0`
    )
    .get(workspaceId).n;

  const byLocation = db
    .prepare(
      `SELECT l.id, l.name, l.kind, COALESCE(SUM(b.on_hand), 0) AS on_hand,
              COUNT(DISTINCT CASE WHEN b.on_hand <> 0 THEN b.sku_id END) AS sku_count
         FROM locations l
         LEFT JOIN balances b ON b.location_id = l.id
        WHERE l.workspace_id = ? AND l.is_active = 1
        GROUP BY l.id
        ORDER BY on_hand DESC, l.name`
    )
    .all(workspaceId);

  const movementsToday = db
    .prepare(
      `SELECT COUNT(DISTINCT group_id) AS n FROM movements
        WHERE workspace_id = ? AND occurred_at >= ?`
    )
    .get(workspaceId, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()).n;

  const expiringLots = db
    .prepare(
      `SELECT lo.id, lo.code, lo.expires_at, s.item_id, i.name AS item_name,
              COALESCE(SUM(lb.quantity), 0) AS quantity
         FROM lots lo
         JOIN skus s ON s.id = lo.sku_id
         JOIN items i ON i.id = s.item_id
         LEFT JOIN lot_balances lb ON lb.lot_id = lo.id
        WHERE lo.workspace_id = ? AND lo.expires_at IS NOT NULL
        GROUP BY lo.id
       HAVING quantity > 0
        ORDER BY lo.expires_at
        LIMIT 5`
    )
    .all(workspaceId);

  const trackedUnits = db
    .prepare(
      `SELECT COUNT(*) AS n FROM serial_units WHERE workspace_id = ? AND status = 'in_stock'`
    )
    .get(workspaceId).n;

  return {
    itemCount,
    locationCount,
    unitsOnHand,
    zeroStock,
    zeroCount,
    byLocation,
    movementsToday,
    expiringLots,
    trackedUnits,
  };
}

module.exports = { listItems, overview };
