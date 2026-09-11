'use strict';

const repo = require('./repository');
const { ValidationError, InvariantError } = require('./errors');
const { LOCATION_KIND_IDS } = require('./constants');
const { newId, nowIso, requireText, requireOneOf, trimOrNull } = require('../lib/util');
const entitlements = require('../entitlements/service');

function createLocation(db, ctx, input) {
  // Asked by name, so a plan change never needs this line to change.
  entitlements.assertWithin(db, ctx, 'locations');
  const name = requireText(input.name, 'Location name', { max: 120 });
  const kind = requireOneOf(input.kind, LOCATION_KIND_IDS, 'Location type');
  const note = trimOrNull(input.note);
  /*
   * Where parcels leave from.
   *
   * Optional, because most locations never post anything and a stockroom does
   * not need a postal address to hold stock. It matters at exactly one moment:
   * a carrier will not quote a rate without an origin, and Foundry will not
   * invent one.
   */
  const address = trimOrNull(input.address);
  const parent = input.parentLocationId
    ? repo.requireLocation(db, ctx.workspaceId, input.parentLocationId, 'parent location')
    : null;
  if (parent && !parent.is_active) {
    throw new ValidationError(`${parent.name} is archived and cannot contain another location.`);
  }
  const barcode = trimOrNull(input.barcode);
  const pickSequence = parsePickSequence(input.pickSequence);
  assertBarcodeAvailable(db, ctx.workspaceId, barcode);
  const clash = db
    .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.workspaceId, name);
  if (clash) throw new ValidationError(`A location called "${name}" already exists.`, { field: 'name' });

  const id = newId('loc');
  db.prepare(
    `INSERT INTO locations (id, workspace_id, name, kind, parent_location_id, barcode,
       pick_sequence, note, address, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(id, ctx.workspaceId, name, kind, parent ? parent.id : null, barcode,
    pickSequence, note, address, nowIso());
  return repo.requireLocation(db, ctx.workspaceId, id);
}

function updateLocation(db, ctx, locationId, input) {
  const location = repo.requireLocation(db, ctx.workspaceId, locationId);
  const name = requireText(input.name, 'Location name', { max: 120 });
  const kind = requireOneOf(input.kind, LOCATION_KIND_IDS, 'Location type');
  const note = trimOrNull(input.note);
  /*
   * An address left out of the form does not erase one already held.
   *
   * The edit form is also used to rename a location, and a rename that
   * silently cleared the address would stop every parcel shipping from it
   * without saying anything.
   */
  const address = input.address === undefined ? location.address : trimOrNull(input.address);
  const parentId = input.parentLocationId === undefined
    ? location.parent_location_id
    : trimOrNull(input.parentLocationId);
  if (parentId === location.id) throw new ValidationError('A location cannot contain itself.');
  if (parentId) {
    const parent = repo.requireLocation(db, ctx.workspaceId, parentId, 'parent location');
    if (!parent.is_active) throw new ValidationError(`${parent.name} is archived and cannot contain another location.`);
    if (descendantIds(db, ctx.workspaceId, location.id).includes(parentId)) {
      throw new ValidationError('That would create a loop in the warehouse layout.');
    }
  }
  const barcode = input.barcode === undefined ? location.barcode : trimOrNull(input.barcode);
  const pickSequence = input.pickSequence === undefined
    ? Number(location.pick_sequence || 0)
    : parsePickSequence(input.pickSequence);
  assertBarcodeAvailable(db, ctx.workspaceId, barcode, location.id);
  const clash = db
    .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(ctx.workspaceId, name, locationId);
  if (clash) throw new ValidationError(`A location called "${name}" already exists.`, { field: 'name' });

  db.prepare(`UPDATE locations SET name = ?, kind = ?, parent_location_id = ?, barcode = ?,
    pick_sequence = ?, note = ?, address = ?
    WHERE id = ? AND workspace_id = ?`).run(
    name,
    kind,
    parentId,
    barcode,
    pickSequence,
    note,
    address,
    locationId,
    ctx.workspaceId
  );
  return repo.requireLocation(db, ctx.workspaceId, locationId);
}

function parsePickSequence(value) {
  if (value === undefined || value === null || value === '') return 0;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 999999) {
    throw new ValidationError('Pick sequence must be a whole number from 0 to 999999.', { field: 'pickSequence' });
  }
  return number;
}

function assertBarcodeAvailable(db, workspaceId, barcode, exceptId = null) {
  if (!barcode) return;
  const clash = db.prepare(`SELECT name FROM locations
    WHERE workspace_id = ? AND barcode = ? COLLATE NOCASE AND id <> COALESCE(?, '')`)
    .get(workspaceId, barcode, exceptId);
  if (clash) throw new ValidationError(`Barcode ${barcode} already identifies ${clash.name}.`, { field: 'barcode' });
}

function descendantIds(db, workspaceId, locationId) {
  return db.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM locations WHERE workspace_id = ? AND parent_location_id = ?
      UNION ALL
      SELECT l.id FROM locations l JOIN descendants d ON l.parent_location_id = d.id
       WHERE l.workspace_id = ?
    ) SELECT id FROM descendants`).all(workspaceId, locationId, workspaceId).map((row) => row.id);
}

function setLocationActive(db, ctx, locationId, isActive) {
  const location = repo.requireLocation(db, ctx.workspaceId, locationId);
  if (!isActive) {
    const child = db.prepare(`SELECT name FROM locations
      WHERE workspace_id = ? AND parent_location_id = ? AND is_active = 1 LIMIT 1`)
      .get(ctx.workspaceId, locationId);
    if (child) {
      throw new InvariantError(
        `${location.name} still contains ${child.name}. Move or archive its sublocations first.`,
        'location_has_children'
      );
    }
    const row = db
      .prepare('SELECT COALESCE(SUM(on_hand), 0) AS total FROM balances WHERE workspace_id = ? AND location_id = ?')
      .get(ctx.workspaceId, locationId);
    if (row.total !== 0) {
      throw new InvariantError(
        `${location.name} still holds ${row.total} units. Move the stock elsewhere before archiving it.`,
        'location_has_stock'
      );
    }
  }
  db.prepare('UPDATE locations SET is_active = ? WHERE id = ? AND workspace_id = ?').run(
    isActive ? 1 : 0,
    locationId,
    ctx.workspaceId
  );
  return repo.requireLocation(db, ctx.workspaceId, locationId);
}

/** Locations with the numbers staff actually want next to them. */
function listLocationsWithStock(db, workspaceId) {
  return db
    .prepare(
      `SELECT l.*,
              COALESCE(SUM(b.on_hand), 0)                        AS on_hand,
              COUNT(DISTINCT CASE WHEN b.on_hand <> 0 THEN b.sku_id END) AS sku_count
         FROM locations l
         LEFT JOIN balances b ON b.location_id = l.id AND b.workspace_id = l.workspace_id
        WHERE l.workspace_id = ?
        GROUP BY l.id
        ORDER BY l.is_active DESC, l.name`
    )
    .all(workspaceId);
}

function listHierarchy(db, workspaceId, { includeInactive = false } = {}) {
  const rows = db.prepare(`WITH RECURSIVE tree AS (
      SELECT l.*, 0 AS depth, printf('%08d:%s', l.pick_sequence, l.name) AS sort_path,
             l.name AS display_path
        FROM locations l
       WHERE l.workspace_id = ? AND l.parent_location_id IS NULL
      UNION ALL
      SELECT child.*, tree.depth + 1,
             tree.sort_path || '/' || printf('%08d:%s', child.pick_sequence, child.name),
             tree.display_path || ' / ' || child.name
        FROM locations child JOIN tree ON child.parent_location_id = tree.id
       WHERE child.workspace_id = ?
    ) SELECT tree.*,
       COALESCE((SELECT SUM(b.on_hand) FROM balances b
          WHERE b.workspace_id = tree.workspace_id AND b.location_id = tree.id), 0) AS on_hand,
       COALESCE((SELECT COUNT(DISTINCT b.sku_id) FROM balances b
          WHERE b.workspace_id = tree.workspace_id AND b.location_id = tree.id AND b.on_hand <> 0), 0) AS sku_count
      FROM tree
     WHERE (? = 1 OR is_active = 1)
     ORDER BY sort_path`).all(workspaceId, workspaceId, includeInactive ? 1 : 0);
  return rows;
}

module.exports = { createLocation, updateLocation, setLocationActive, listLocationsWithStock,
  listHierarchy, descendantIds };
