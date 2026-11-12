'use strict';

const exact = require('../domain/exact-quantity');
const stock = require('../domain/stock-quantity');
const { hash } = require('../pricing/postgres-promotions');
const { ValidationError } = require('../domain/errors');
const time = require('../lib/business-time');
const { addDays } = require('../accounting/customer-money');
const { WINDOW_DAYS, COVER_DAYS, SAFETY_DAYS, MIN_ISSUE_EVENTS } = require('../purchasing/replenishment-decision');

const key = (skuId, locationId) => JSON.stringify([skuId, locationId]);
const canonical = value => value == null ? null : exact.canonical(value);
const profileKey = (profile, locationId) => hash([profile.sku_id, locationId, profile.tracking_mode, stock.profile({}, profile)]);

async function profile(db, workspaceId, skuId, locationId, lock = false) {
  const row = (await db.query(`SELECT i.*,s.id sku_id,s.code,l.id location_id,l.name location_name
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=$3
    WHERE s.workspace_id=$1 AND s.id=$2 AND s.is_active=1 AND i.is_active=1
      AND l.is_active=1 AND l.custody_agreement_id IS NULL${lock ? ' FOR SHARE OF i,s,l' : ''}`,
  [workspaceId, skuId, locationId])).rows[0];
  if (!row) throw new ValidationError('Choose an active product and owned stock location from this inventory.');
  return row;
}

function roundedDemand(issued, days, profile) {
  const precision = Number(profile.quantity_precision);
  const sold = BigInt(exact.atoms(issued, precision));
  const increment = BigInt(exact.atoms(profile.quantity_increment, precision, { positive: true }));
  const divisor = BigInt(WINDOW_DAYS) * increment;
  const raw = sold * BigInt(days);
  const result = (raw + divisor - 1n) / divisor * increment;
  return exact.fromAtoms(Number(result), precision);
}

function estimate(row, recorded, clock) {
  const { sku_id: skuId, location_id: locationId } = row;
  const leadSource = row.local_lead ?? (row.lead_time_assumed ? null : row.lead_time_days);
  const lead = Math.ceil(Number(leadSource));
  if (row.planning_suppressed || leadSource == null || !Number.isSafeInteger(lead) || Number(leadSource) < 0)
    throw new ValidationError('Record a lead time for this location or its supplier before setting local reorder points.');
  if (!recorded || Number(recorded.events) < MIN_ISSUE_EVENTS)
    throw new ValidationError('Record at least two separate sales or stock issues for this location in the last 90 days.');
  if (Number(recorded.incomplete) > 0)
    throw new ValidationError('Verify the actual batch, serial or weight evidence for the recorded sales before setting this reorder point.');
  const cover = Number(row.cover_days ?? COVER_DAYS);
  const issued = canonical(recorded.issued);
  const safety = row.safety_stock == null ? roundedDemand(issued, SAFETY_DAYS, row) :
    String(stock.validate(row, row.safety_stock, { label: 'Recorded local safety stock', total: true, positive: false }));
  const minimum = exact.add(roundedDemand(issued, lead, row), safety);
  const byCover = roundedDemand(issued, cover, row);
  const protectedTarget = exact.add(minimum, safety);
  const maximum = Number(byCover) > Number(protectedTarget) ? byCover : protectedTarget;
  const current = { policyId: row.policy_location_id === locationId ? row.policy_id : null,
    updatedAt: row.local_policy_updated_at || null, minimum: canonical(row.reorder_point),
    maximum: canonical(row.target_stock), safety: canonical(row.safety_stock) };
  const evidence = { skuId, locationId, code: row.code, name: row.item_name, location: row.location_name, unit: row.unit_label,
    secondaryUnit: row.secondary_unit_label, tracking: row.tracking_mode, soldWeight: canonical(recorded.sold_weight),
    issued, events: Number(recorded.events), lastSequence: String(recorded.last_seq), firstSequence: String(recorded.first_seq),
    lead, leadSource, cover, safety, minimum, maximum, current, day: clock.calendarDate, zone: clock.timeZone,
    profileKey: profileKey(row, locationId) };
  return { ...evidence, digest: hash(evidence), changed: current.minimum !== minimum || current.maximum !== maximum };
}

// Distinct physical sales per product and location in the 90-day window,
// with the evidence gaps that make a location estimate unreliable.
async function sales(db, workspaceId, skuIds) {
  const clock = await time.forWorkspace(db, workspaceId);
  const start = time.dayBoundary(addDays(clock.calendarDate, 1 - WINDOW_DAYS), clock.timeZone);
  const args = [workspaceId, skuIds, start, clock.instant];
  const physical = (await db.query(`SELECT d.sku_id,d.location_id,sum(d.issued)::text issued,
    sum(-m.secondary_quantity_delta)::text sold_weight,min(m.seq) first_seq,max(m.seq) last_seq,
    count(DISTINCT coalesce(nullif(m.reference,''),m.id)) events,
    count(*) FILTER(WHERE (i.tracking_mode='lot' AND m.lot_id IS NULL)
      OR (i.tracking_mode='serial' AND d.issued<>greatest(CASE WHEN m.serial_unit_id IS NOT NULL THEN 1 ELSE 0 END,
        (SELECT count(*) FROM stockchief_runtime.inventory_movement_serial_units su WHERE su.workspace_id=m.workspace_id AND su.movement_id=m.id)))
      OR (i.secondary_unit_label IS NOT NULL AND (m.secondary_quantity_delta IS NULL OR m.secondary_quantity_delta>=0))) incomplete
    FROM stockchief_runtime.replenishment_demand_events d JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id
    JOIN skus s ON s.workspace_id=d.workspace_id AND s.id=d.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE d.workspace_id=$1 AND d.sku_id=ANY($2::text[]) AND d.occurred_at>=$3::timestamptz AND d.occurred_at<=$4::timestamptz
      AND m.operation='issue' AND m.reason_code IN('sale','sold') GROUP BY d.sku_id,d.location_id`, args)).rows;
  return { clock, start, recorded: new Map(physical.map(r => [key(r.sku_id, r.location_id), r])) };
}

async function read(db, workspaceId, skuIds) {
  if (!skuIds.length) return new Map();
  const { clock, recorded } = await sales(db, workspaceId, skuIds);
  if (!recorded.size) return new Map();
  const profiles = new Map((await db.query(`SELECT s.id sku_id,i.unit_label,i.quantity_precision,i.quantity_increment::text,
    i.secondary_unit_label,i.secondary_precision,i.secondary_increment::text,i.tracking_mode
    FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    WHERE s.workspace_id=$1 AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`, [workspaceId, skuIds])).rows.map(r => [r.sku_id, r]));
  const rows = await require('../purchasing/postgres-replenishment-state').rows(db, workspaceId, { onlySkuIds: skuIds });
  const result = new Map();
  for (const row of rows) {
    const positionKey = key(row.sku_id, row.location_id), sold = recorded.get(positionKey);
    if (!sold || !profiles.has(row.sku_id)) continue;
    try { result.set(positionKey, estimate({ ...row, ...profiles.get(row.sku_id) }, sold, clock)); }
    catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      result.set(positionKey, { skuId: row.sku_id, locationId: row.location_id, code: row.code, location: row.location_name, error: error.message });
    }
  }
  return result;
}

async function current(db, workspaceId, skuId, locationId) {
  const result = (await read(db, workspaceId, [skuId])).get(key(skuId, locationId));
  if (!result || result.error) throw new ValidationError(result?.error || 'Record at least two separate sales or stock issues for this location in the last 90 days.');
  return result;
}

module.exports = { profile, profileKey, key, read, current, sales, estimate };
