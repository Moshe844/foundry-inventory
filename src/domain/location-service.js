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
  const clash = db
    .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE')
    .get(ctx.workspaceId, name);
  if (clash) throw new ValidationError(`A location called "${name}" already exists.`, { field: 'name' });

  const id = newId('loc');
  db.prepare(
    `INSERT INTO locations (id, workspace_id, name, kind, note, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, ctx.workspaceId, name, kind, note, nowIso());
  return repo.requireLocation(db, ctx.workspaceId, id);
}

function updateLocation(db, ctx, locationId, input) {
  const location = repo.requireLocation(db, ctx.workspaceId, locationId);
  const name = requireText(input.name, 'Location name', { max: 120 });
  const kind = requireOneOf(input.kind, LOCATION_KIND_IDS, 'Location type');
  const note = trimOrNull(input.note);
  const clash = db
    .prepare('SELECT 1 FROM locations WHERE workspace_id = ? AND name = ? COLLATE NOCASE AND id <> ?')
    .get(ctx.workspaceId, name, locationId);
  if (clash) throw new ValidationError(`A location called "${name}" already exists.`, { field: 'name' });

  db.prepare('UPDATE locations SET name = ?, kind = ?, note = ? WHERE id = ? AND workspace_id = ?').run(
    name,
    kind,
    note,
    locationId,
    ctx.workspaceId
  );
  return { ...location, name, kind, note };
}

function setLocationActive(db, ctx, locationId, isActive) {
  const location = repo.requireLocation(db, ctx.workspaceId, locationId);
  if (!isActive) {
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

module.exports = { createLocation, updateLocation, setLocationActive, listLocationsWithStock };
