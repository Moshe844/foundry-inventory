'use strict';

const time = require('../lib/business-time');
const { addDays } = require('../accounting/customer-money');
const { hash } = require('../pricing/postgres-promotions');
const { ValidationError } = require('../domain/errors');

async function warehouses(db, workspaceId) {
  return (await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND parent_location_id IS NULL
    AND is_active=1 AND custody_agreement_id IS NULL ORDER BY lower(name),id`, [workspaceId])).rows;
}

async function warehouse(db, workspaceId, warehouseId, lock = false) {
  const row = (await db.query(`SELECT id,name FROM locations WHERE workspace_id=$1 AND id=$2 AND parent_location_id IS NULL
    AND is_active=1 AND custody_agreement_id IS NULL${lock ? ' FOR SHARE' : ''}`, [workspaceId, warehouseId])).rows[0];
  if (!row) throw new ValidationError('Choose an active owned warehouse or top-level stock location.');
  return row;
}

const rank = 'negative DESC,pending DESC,adjustments DESC,CASE class WHEN \'A\' THEN 0 WHEN \'B\' THEN 1 ELSE 2 END,value DESC NULLS LAST,sku_id,location_id';

async function shelves(db, workspaceId, { clock, warehouseId = null, filter = '', limit, offset = 0 }) {
  const start = time.dayBoundary(addDays(clock.calendarDate, -89), clock.timeZone);
  const args = [workspaceId, warehouseId, clock.calendarDate, start, clock.instant, filter, limit, offset];
  return (await db.query(`WITH RECURSIVE tree AS (
    SELECT l.id,l.name,l.id warehouse_id,l.name warehouse_name,l.name path,NULL::text shelf_id
    FROM locations l WHERE l.workspace_id=$1 AND l.parent_location_id IS NULL AND l.is_active=1
      AND l.custody_agreement_id IS NULL AND ($2::text IS NULL OR l.id=$2)
    UNION ALL
    SELECT l.id,l.name,t.warehouse_id,t.warehouse_name,t.path||' / '||l.name,
      CASE WHEN l.kind='shelf' THEN l.id ELSE t.shelf_id END
    FROM tree t JOIN locations l ON l.workspace_id=$1 AND l.parent_location_id=t.id AND l.is_active=1 AND l.custody_agreement_id IS NULL
  ), money AS (
    SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1
  ), differences AS (
    SELECT m.sku_id,m.location_id,count(*) n,max(m.seq) last_adjustment
    FROM movements m JOIN tree t ON t.id=m.location_id WHERE m.workspace_id=$1 AND m.operation='adjust'
      AND stockchief_movement_instant(m.occurred_at) BETWEEN $4::timestamptz AND $5::timestamptz
    GROUP BY m.sku_id,m.location_id
  ), observed AS (
    SELECT q.sku_id,q.location_id,count(*) n,sum(hashtextextended(jsonb_build_array(q.campaign_id,q.before_quantity,q.counter_quantity,q.counted_quantity)::text,0)::numeric)::text digest
    FROM warehouse_count_campaign_lines q JOIN warehouse_count_campaigns c ON c.workspace_id=q.workspace_id AND c.id=q.campaign_id
    JOIN tree t ON t.id=q.location_id WHERE q.workspace_id=$1 AND q.applied_at IS NULL AND c.status<>'COMPLETED'
      AND c.created_at BETWEEN $4::timestamptz AND $5::timestamptz
      AND coalesce(q.counted_quantity,q.counter_quantity,q.before_quantity)<>q.before_quantity
    GROUP BY q.sku_id,q.location_id
  ), positions AS (
    SELECT b.sku_id,b.location_id,b.on_hand,b.secondary_on_hand,b.updated_at,s.code,i.name product,i.unit_label,
      t.warehouse_id,t.warehouse_name,coalesce(t.shelf_id,t.id) shelf_id,b.on_hand<0 negative,
      coalesce(d.n,0) adjustments,d.last_adjustment,coalesce(o.n,0) pending,o.digest observed,
      abc.class,books.base_currency,v.updated_at cost_updated_at,
      CASE WHEN b.on_hand>0 AND books.base_currency IS NOT NULL AND v.quantity_units=b.on_hand
        AND (i.secondary_unit_label IS NULL OR v.secondary_quantity_units=b.secondary_on_hand)
        THEN v.total_cost_minor END value
    FROM tree t JOIN balances b ON b.workspace_id=$1 AND b.location_id=t.id
    JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    LEFT JOIN money books ON true
    LEFT JOIN accounting_inventory_cost_balances v ON v.workspace_id=b.workspace_id AND v.sku_id=b.sku_id AND v.location_id=b.location_id
    LEFT JOIN differences d ON d.sku_id=b.sku_id AND d.location_id=b.location_id
    LEFT JOIN observed o ON o.sku_id=b.sku_id AND o.location_id=b.location_id
    LEFT JOIN stockchief_runtime.product_class_months month ON month.workspace_id=b.workspace_id
      AND month.month_start=date_trunc('month',$3::date)::date AND month.currency=books.base_currency
    LEFT JOIN stockchief_runtime.product_class_values abc ON abc.workspace_id=month.workspace_id AND abc.item_id=i.id AND abc.month_start=month.month_start
    WHERE ($6='' OR lower(s.code)=lower($6)) AND (b.on_hand<>0 OR d.n>0 OR o.n>0)
  ), ranked AS (
    SELECT p.*,row_number() OVER(PARTITION BY shelf_id ORDER BY ${rank}) spot,
      jsonb_build_array(sku_id,location_id,code,product,unit_label,on_hand,secondary_on_hand,updated_at,
        adjustments,last_adjustment,pending,observed,class,base_currency,value,cost_updated_at) proof
    FROM positions p
  ), grouped AS (
    SELECT shelf_id,warehouse_id,warehouse_name,max(base_currency) currency,count(*) positions,
      count(*) FILTER(WHERE negative) negative_positions,sum(adjustments) recent_adjustments,sum(pending) unresolved_differences,
      count(*) FILTER(WHERE class='A') class_a,count(*) FILTER(WHERE class='B') class_b,
      count(*) FILTER(WHERE on_hand>0 AND value IS NULL) unknown_values,sum(value)::text value_minor,
      max(code) FILTER(WHERE spot=1) lead_sku,max(product) FILTER(WHERE spot=1) lead_product,
      (max(on_hand) FILTER(WHERE spot=1))::text lead_on_hand,max(unit_label) FILTER(WHERE spot=1) lead_unit,
      sum(hashtextextended(proof::text,101)::numeric)::text proof_one,sum(hashtextextended(proof::text,203)::numeric)::text proof_two
    FROM ranked GROUP BY shelf_id,warehouse_id,warehouse_name
  )
  SELECT g.*,t.name shelf,t.path,count(*) OVER() eligible_shelves FROM grouped g JOIN tree t ON t.id=g.shelf_id
  ORDER BY negative_positions DESC,unresolved_differences DESC,recent_adjustments DESC,class_a DESC,class_b DESC,
    value_minor::numeric DESC NULLS LAST,t.path,t.id LIMIT $7 OFFSET $8`, args)).rows;
}

function reason(row) {
  const count = (value, label) => Number(value) ? value + ' ' + label + (Number(value) === 1 ? '' : 's') : null;
  return [
    count(row.negative_positions, 'negative stock position'),
    count(row.unresolved_differences, 'unresolved count difference'),
    count(row.recent_adjustments, 'recent adjustment'),
    count(row.class_a, 'monthly A position'),
    count(row.class_b, 'monthly B position'),
    count(row.unknown_values, 'unverified stock value'),
  ].filter(Boolean).join(' · ') || 'Recorded stock value';
}

function displayValue({ valueMinor, currency }) {
  if (valueMinor == null || !currency) return null;
  const money = require('../domain/currency');
  if (Number.isSafeInteger(Number(valueMinor))) return money.format(valueMinor, currency);
  const digits = money.exponent(currency);
  const text = String(valueMinor).padStart(digits + 1, '0');
  return currency + ' ' + (digits ? text.slice(0, -digits) + '.' + text.slice(-digits) : text);
}

function summary(row) {
  return { shelfId: row.shelf_id, shelf: row.shelf, path: row.path, warehouse: row.warehouse_name,
    positions: Number(row.positions), negativePositions: Number(row.negative_positions), recentAdjustments: Number(row.recent_adjustments),
    unresolvedDifferences: Number(row.unresolved_differences), classA: Number(row.class_a), classB: Number(row.class_b),
    unknownValues: Number(row.unknown_values), valueMinor: row.value_minor, currency: row.currency,
    sku: row.lead_sku, product: row.lead_product, quantity: row.lead_on_hand, unit: row.lead_unit,
    reason: reason(row), evidence: hash([row.proof_one, row.proof_two]) };
}

async function snapshot(db, workspaceId, place, clock, maximumShelves) {
  const rows = await shelves(db, workspaceId, { clock, warehouseId: place.id, limit: maximumShelves });
  if (!rows.length) throw new ValidationError('No recorded stock positions or recent discrepancies are available in this warehouse.');
  const data = { day: clock.calendarDate, zone: clock.timeZone, warehouseId: place.id, warehouse: place.name,
    maximumShelves, eligibleShelves: Number(rows[0].eligible_shelves), shelves: rows.map(summary) };
  return { data, fingerprint: hash(data) };
}

module.exports = { warehouses, warehouse, shelves, summary, snapshot, displayValue };
