'use strict';

/**
 * The stock is in the building. It is in the wrong building.
 *
 * A business with two locations does not have one demand curve, it has two, and
 * they are rarely the same shape. Downtown sells the small size four times as
 * fast as Uptown does. Both are stocked from the same purchase order, in the
 * same proportion, because that is how the order was written; four weeks later
 * one of them is empty and the other has most of a year's supply.
 *
 * Nothing in the totals shows this. Company-wide there is plenty. The reorder
 * point is comfortable. The only way to see it is to forecast each location on
 * its own evidence and then compare, which is what this does.
 *
 * A transfer is the cheapest possible fix for a shortage — the stock is already
 * bought, already paid for, and the only cost is moving it — so it is checked
 * before purchasing, always. The constraint that keeps this from doing harm is
 * that the giving location keeps enough for its own demand first: a transfer
 * that solves a stockout by creating one somewhere else is not a solution, it
 * is the same problem in a different postcode.
 */

const forecastEngine = require('./forecast');
const demandHistory = require('./demand-history');

const round = (value, places = 1) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const DEFAULTS = {
  // A location giving stock away keeps at least this much of its own cover.
  sourceKeepDays: 21,
  // Below this gap there is nothing worth a van.
  minimumUnits: 1,
  // The receiving location has to be genuinely short, not merely lower.
  shortageDays: 10,
  // And the source has to be genuinely long.
  surplusDays: 45,
};

/** Where this product physically is, location by location. */
function holdings(db, workspaceId, skuId) {
  return db.prepare(`SELECT b.location_id, b.on_hand, l.name AS location_name, l.kind, l.is_active
    FROM balances b JOIN locations l ON l.id = b.location_id
    WHERE b.workspace_id = ? AND b.sku_id = ? AND l.is_active = 1
    ORDER BY l.name`).all(workspaceId, skuId)
    .map((row) => ({
      locationId: row.location_id, locationName: row.location_name,
      kind: row.kind, onHand: Number(row.on_hand),
    }));
}

/**
 * Looks at one product across every location and proposes moves.
 *
 * Returns a list because a single shortage can legitimately be filled from more
 * than one place, and because saying "move 40 from Main" when Main only has 25
 * to spare is worse than saying nothing.
 */
function forSku(db, workspaceId, skuId, options = {}) {
  const now = options.now || Date.now();
  const settings = { ...DEFAULTS, ...(options.settings || {}) };
  const keepDays = options.goals && options.goals.sourceKeepDays
    ? Number(options.goals.sourceKeepDays) : settings.sourceKeepDays;

  const places = holdings(db, workspaceId, skuId);
  if (places.length < 2) {
    return { skuId, transfers: [], places, reason: 'only one location holds this' };
  }

  // Each location gets its own forecast from its own movements. This is the
  // whole idea: a company-wide rate would average Downtown's four a day with
  // Uptown's one and be wrong about both.
  const assessed = places.map((place) => {
    const forecast = forecastEngine.forSku(db, workspaceId, skuId, {
      now, locationId: place.locationId, horizonDays: 30,
    });
    const committed = demandHistory.committedDemand(db, workspaceId, skuId, {
      locationId: place.locationId,
    });
    const rate = forecast.dailyRate;
    const free = Math.max(0, place.onHand - committed.units);
    return {
      ...place,
      dailyRate: rate,
      confidence: forecast.confidence,
      committed: committed.units,
      free,
      daysOfCover: rate && rate > 0 ? round(free / rate) : null,
    };
  });

  const short = assessed
    .filter((place) => place.dailyRate > 0 && place.daysOfCover !== null
      && place.daysOfCover < settings.shortageDays)
    .sort((a, b) => a.daysOfCover - b.daysOfCover);

  const long = assessed
    .filter((place) => place.daysOfCover === null
      ? place.free > 0 && !place.dailyRate
      : place.daysOfCover > settings.surplusDays)
    .sort((a, b) => (b.daysOfCover || Infinity) - (a.daysOfCover || Infinity));

  const transfers = [];
  // A working copy, so two proposed transfers cannot both spend the same units.
  const spare = new Map(long.map((place) => [place.locationId, spareAt(place, keepDays)]));

  for (const destination of short) {
    // Bring the short location up to the same cover the surplus one is being
    // left with, not to the brim: the aim is to stop a stockout, not to move
    // the whole problem across town.
    const wanted = Math.max(0, Math.ceil(destination.dailyRate * settings.shortageDays) - destination.free);
    let remaining = wanted;

    for (const source of long) {
      if (remaining <= 0) break;
      if (source.locationId === destination.locationId) continue;
      const available = spare.get(source.locationId) || 0;
      if (available < settings.minimumUnits) continue;

      const units = Math.min(available, remaining);
      if (units < settings.minimumUnits) continue;
      spare.set(source.locationId, available - units);
      remaining -= units;

      transfers.push({
        skuId,
        fromLocationId: source.locationId,
        fromLocationName: source.locationName,
        toLocationId: destination.locationId,
        toLocationName: destination.locationName,
        units,
        sourceDaysOfCover: source.daysOfCover,
        destinationDaysOfCover: destination.daysOfCover,
        destinationDailyRate: destination.dailyRate,
        confidence: destination.confidence,
        why: `${source.locationName} has about `
          + `${source.daysOfCover === null ? 'stock that is not moving' : `${Math.round(source.daysOfCover)} days of supply`}`
          + ` while ${destination.locationName} has ${Math.round(destination.daysOfCover)} `
          + `and is selling about ${destination.dailyRate} a day. Moving ${units} covers `
          + `${destination.locationName} without taking ${source.locationName} below `
          + `${keepDays} days of its own cover.`,
      });
    }
  }

  return { skuId, transfers, places: assessed, keepDays, settings };
}

/**
 * How much a location can give away without hurting itself.
 *
 * A location with no measurable demand of its own can give everything it is not
 * already committed to — there is nothing there to protect.
 */
function spareAt(place, keepDays) {
  if (!place.dailyRate || place.dailyRate <= 0) return place.free;
  return Math.max(0, Math.floor(place.free - place.dailyRate * keepDays));
}

/**
 * Sweeps the workspace for products whose stock is in the wrong place.
 *
 * @param options.skuIds narrow it; a full sweep forecasts every location of
 *        every product and is meant for the scheduled run, not a page load.
 */
function sweep(db, workspaceId, options = {}) {
  const skuIds = options.skuIds || db.prepare(`SELECT DISTINCT b.sku_id AS id
    FROM balances b JOIN skus s ON s.id = b.sku_id
    WHERE b.workspace_id = ? AND b.on_hand > 0 AND s.is_active = 1`).all(workspaceId).map((row) => row.id);

  const all = [];
  for (const skuId of skuIds) {
    const result = forSku(db, workspaceId, skuId, options);
    for (const transfer of result.transfers) all.push(transfer);
  }
  all.sort((a, b) => a.destinationDaysOfCover - b.destinationDaysOfCover);
  return all;
}

module.exports = { forSku, sweep, holdings, spareAt, DEFAULTS };
