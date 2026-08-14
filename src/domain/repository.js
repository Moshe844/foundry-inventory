'use strict';

const { NotFoundError } = require('./errors');

/**
 * Every read in this file takes a workspace id and filters on it.
 * Tenancy is a property of the query, not of the caller's good intentions:
 * there is no accessor here that can return a row from another workspace.
 */

const SKU_SELECT = `
  SELECT
    s.id            AS id,
    s.workspace_id        AS workspace_id,
    s.item_id       AS item_id,
    s.code          AS code,
    s.variant_label AS variant_label,
    s.is_default    AS is_default,
    s.position      AS position,
    s.is_active     AS is_active,
    i.name          AS item_name,
    i.tracking_mode AS tracking_mode,
    i.has_variants  AS has_variants,
    i.allow_negative AS allow_negative,
    i.unit_label    AS unit_label
  FROM skus s
  JOIN items i ON i.id = s.item_id AND i.workspace_id = s.workspace_id
`;

function getItem(db, workspaceId, itemId) {
  return db.prepare('SELECT * FROM items WHERE id = ? AND workspace_id = ?').get(itemId, workspaceId) || null;
}

function requireItem(db, workspaceId, itemId) {
  const item = getItem(db, workspaceId, itemId);
  if (!item) throw new NotFoundError('That item could not be found.');
  return item;
}

function getSku(db, workspaceId, skuId) {
  return db.prepare(`${SKU_SELECT} WHERE s.id = ? AND s.workspace_id = ?`).get(skuId, workspaceId) || null;
}

function requireSku(db, workspaceId, skuId) {
  const sku = getSku(db, workspaceId, skuId);
  if (!sku) throw new NotFoundError('That item variant could not be found.');
  return sku;
}

function listSkusForItem(db, workspaceId, itemId) {
  return db
    .prepare(`${SKU_SELECT} WHERE s.item_id = ? AND s.workspace_id = ? ORDER BY s.position, s.code`)
    .all(itemId, workspaceId);
}

function getLocation(db, workspaceId, locationId) {
  return db.prepare('SELECT * FROM locations WHERE id = ? AND workspace_id = ?').get(locationId, workspaceId) || null;
}

function requireLocation(db, workspaceId, locationId, label = 'location') {
  const location = getLocation(db, workspaceId, locationId);
  if (!location) throw new NotFoundError(`That ${label} could not be found.`);
  return location;
}

function listLocations(db, workspaceId, { includeInactive = false } = {}) {
  const sql = includeInactive
    ? 'SELECT * FROM locations WHERE workspace_id = ? ORDER BY name'
    : 'SELECT * FROM locations WHERE workspace_id = ? AND is_active = 1 ORDER BY name';
  return db.prepare(sql).all(workspaceId);
}

function getLot(db, workspaceId, lotId) {
  return db.prepare('SELECT * FROM lots WHERE id = ? AND workspace_id = ?').get(lotId, workspaceId) || null;
}

function requireLot(db, workspaceId, lotId) {
  const lot = getLot(db, workspaceId, lotId);
  if (!lot) throw new NotFoundError('That lot could not be found.');
  return lot;
}

function getLotByCode(db, workspaceId, skuId, code) {
  return (
    db
      .prepare('SELECT * FROM lots WHERE workspace_id = ? AND sku_id = ? AND code = ? COLLATE NOCASE')
      .get(workspaceId, skuId, code) || null
  );
}

function getSerialUnit(db, workspaceId, serialUnitId) {
  return (
    db.prepare('SELECT * FROM serial_units WHERE id = ? AND workspace_id = ?').get(serialUnitId, workspaceId) || null
  );
}

function requireSerialUnit(db, workspaceId, serialUnitId) {
  const unit = getSerialUnit(db, workspaceId, serialUnitId);
  if (!unit) throw new NotFoundError('That unit could not be found.');
  return unit;
}

function getBalance(db, workspaceId, skuId, locationId) {
  const row = db
    .prepare('SELECT on_hand FROM balances WHERE workspace_id = ? AND sku_id = ? AND location_id = ?')
    .get(workspaceId, skuId, locationId);
  return row ? row.on_hand : 0;
}

function getLotBalance(db, workspaceId, lotId, locationId) {
  const row = db
    .prepare('SELECT quantity FROM lot_balances WHERE workspace_id = ? AND lot_id = ? AND location_id = ?')
    .get(workspaceId, lotId, locationId);
  return row ? row.quantity : 0;
}

function getSkuTotal(db, workspaceId, skuId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(on_hand), 0) AS total FROM balances WHERE workspace_id = ? AND sku_id = ?')
    .get(workspaceId, skuId);
  return row.total;
}

function getItemTotal(db, workspaceId, itemId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(b.on_hand), 0) AS total
       FROM balances b
       JOIN skus s ON s.id = b.sku_id
       WHERE b.workspace_id = ? AND s.item_id = ?`
    )
    .get(workspaceId, itemId);
  return row.total;
}

module.exports = {
  SKU_SELECT,
  getItem,
  requireItem,
  getSku,
  requireSku,
  listSkusForItem,
  getLocation,
  requireLocation,
  listLocations,
  getLot,
  requireLot,
  getLotByCode,
  getSerialUnit,
  requireSerialUnit,
  getBalance,
  getLotBalance,
  getSkuTotal,
  getItemTotal,
};
