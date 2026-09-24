'use strict';

const { newId, nowIso } = require('../lib/util');
const { NotFoundError, ValidationError } = require('../domain/errors');

const GOALS = {
  service_level: { defaultValue: 'balanced', parse: value => String(value || 'balanced') },
  max_days_of_supply: { defaultValue: null, parse: value => value === null ? null : Number(value) },
  inventory_cap_minor: { defaultValue: null, parse: value => value === null ? null : Number(value) },
  cash_reserve_minor: { defaultValue: null, parse: value => value === null ? null : Number(value) },
  prioritise_core_products: { defaultValue: false, parse: value => value === true || value === 'true' },
  conservative_seasonal: { defaultValue: false, parse: value => value === true || value === 'true' },
};

const number = value => value === null || value === undefined ? null : Number(value);
const object = value => {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return {}; }
};

function goalValue(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER, money = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = money ? Math.round(Number(value) * 100) : Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ValidationError(`${label} must be a whole number from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

async function goals(database, workspaceId) {
  const rows = (await database.query(`SELECT key,value,stated_as FROM operational_preferences
    WHERE workspace_id=$1 AND key=ANY($2::text[])`, [workspaceId, Object.keys(GOALS)])).rows;
  const values = Object.fromEntries(Object.entries(GOALS).map(([key, definition]) => [key, definition.defaultValue]));
  const stated = [];
  for (const row of rows) {
    values[row.key] = GOALS[row.key].parse(object(row.value).value ?? object(row.value));
    if (row.stated_as) stated.push(row.stated_as);
  }
  return {
    serviceLevel: values.service_level,
    maxDaysOfSupply: values.max_days_of_supply,
    inventoryCapMinor: values.inventory_cap_minor,
    cashReserveMinor: values.cash_reserve_minor,
    prioritiseCoreProducts: values.prioritise_core_products,
    conservativeSeasonal: values.conservative_seasonal,
    stated,
  };
}

async function saveGoals(database, ctx, input) {
  const values = {
    service_level: ['lean', 'balanced', 'protective'].includes(input.serviceLevel) ? input.serviceLevel : 'balanced',
    max_days_of_supply: goalValue(input.maxDaysOfSupply, 'Maximum days of supply', { minimum: 7, maximum: 730 }),
    inventory_cap_minor: goalValue(input.inventoryCap, 'Inventory investment limit', { maximum: 99999999999, money: true }),
    cash_reserve_minor: goalValue(input.cashReserve, 'Cash reserve', { maximum: 99999999999, money: true }),
    prioritise_core_products: input.prioritiseCoreProducts === 'on',
    conservative_seasonal: input.conservativeSeasonal === 'on',
  };
  await database.transaction(async client => {
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === false) {
        await client.query('DELETE FROM operational_preferences WHERE workspace_id=$1 AND key=$2', [ctx.workspaceId, key]);
        continue;
      }
      const at = nowIso();
      await client.query(`INSERT INTO operational_preferences
        (id,workspace_id,key,value,source,set_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,'configuration',$5,$6,$6)
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=EXCLUDED.value,source='configuration',
          set_by_user_id=EXCLUDED.set_by_user_id,updated_at=EXCLUDED.updated_at`,
      [newId('pref'), ctx.workspaceId, key, JSON.stringify({ value }), ctx.actorId, at]);
    }
  }, { isolation: 'SERIALIZABLE' });
  return goals(database, ctx.workspaceId);
}

async function position(database, workspaceId) {
  const result = await database.query(`WITH movement_sales AS (
      SELECT sku_id,location_id,COALESCE(SUM(-quantity_delta),0) AS sold_90
      FROM movements WHERE workspace_id=$1 AND operation='issue' AND quantity_delta<0
        AND occurred_at::timestamptz >= clock_timestamp()-interval '90 days' GROUP BY sku_id,location_id
    ), committed AS (
      SELECT line.sku_id,order_record.fulfillment_location_id AS location_id,
        COALESCE(SUM(line.quantity_ordered-line.quantity_fulfilled),0) AS units
      FROM sales_order_lines line JOIN sales_orders order_record ON order_record.id=line.sales_order_id
      WHERE line.workspace_id=$1 AND order_record.status IN ('CONFIRMED','BACKORDERED','PARTIALLY_FULFILLED')
      GROUP BY line.sku_id,order_record.fulfillment_location_id
    ), incoming AS (
      SELECT line.sku_id,COALESCE(line.destination_location_id,order_record.destination_location_id) AS location_id,
        COALESCE(SUM(line.quantity_units-line.quantity_received_units),0) AS units
      FROM purchase_order_lines line JOIN purchase_orders order_record ON order_record.id=line.purchase_order_id
      WHERE line.workspace_id=$1 AND order_record.status IN ('APPROVED','ORDERED','PARTIALLY_RECEIVED')
      GROUP BY line.sku_id,COALESCE(line.destination_location_id,order_record.destination_location_id)
    ), latest_cost AS (
      SELECT DISTINCT ON (sku_id) sku_id,amount_minor FROM sku_purchase_costs WHERE workspace_id=$1
      ORDER BY sku_id,created_at DESC,id DESC
    )
    SELECT s.id AS sku_id,s.code,i.id AS item_id,i.name,i.tracking_mode,l.id AS location_id,l.name AS location_name,
      COALESCE(b.on_hand,0) AS on_hand,COALESCE(c.units,0) AS committed,COALESCE(inc.units,0) AS incoming,
      COALESCE(ms.sold_90,0) AS sold_90,rp.id AS policy_id,rp.reorder_point,rp.target_stock,rp.safety_stock,
      COALESCE(rp.lead_time_days,14) AS lead_time_days,lc.amount_minor AS cost_minor
    FROM skus s JOIN items i ON i.id=s.item_id AND i.workspace_id=s.workspace_id
    CROSS JOIN locations l LEFT JOIN balances b ON b.workspace_id=s.workspace_id AND b.sku_id=s.id AND b.location_id=l.id
    LEFT JOIN movement_sales ms ON ms.sku_id=s.id AND ms.location_id=l.id
    LEFT JOIN committed c ON c.sku_id=s.id AND c.location_id=l.id
    LEFT JOIN incoming inc ON inc.sku_id=s.id AND inc.location_id=l.id
    LEFT JOIN LATERAL (SELECT policy.* FROM reorder_policies policy
      WHERE policy.workspace_id=s.workspace_id AND policy.sku_id=s.id
        AND (policy.location_id=l.id OR policy.location_id IS NULL)
      ORDER BY (policy.location_id=l.id) DESC LIMIT 1) rp ON TRUE
    LEFT JOIN latest_cost lc ON lc.sku_id=s.id
    WHERE s.workspace_id=$1 AND s.is_active=1 AND i.is_active=1 AND l.workspace_id=$1 AND l.is_active=1
    ORDER BY i.name,s.position,l.name`, [workspaceId]);
  return result.rows.map(row => {
    const onHand = Number(row.on_hand); const committed = Number(row.committed); const incoming = Number(row.incoming);
    const sold90 = Number(row.sold_90); const dailyRate = sold90 / 90; const available = onHand - committed;
    const projected = available + incoming; const leadTimeDays = Number(row.lead_time_days);
    const reorderPoint = number(row.reorder_point); const targetStock = number(row.target_stock);
    const inferredReorder = Math.max(1, Math.ceil(dailyRate * (leadTimeDays + 7)));
    const effectiveReorder = reorderPoint ?? inferredReorder;
    return { ...row, onHand, committed, incoming, sold90, dailyRate, available, projected, leadTimeDays,
      reorderPoint, targetStock, safetyStock:number(row.safety_stock), costMinor:number(row.cost_minor),
      inferredReorder, effectiveReorder, daysOfSupply:dailyRate > 0 ? available / dailyRate : null,
      shortage:projected <= effectiveReorder, displayName:row.name + (row.code ? ` · ${row.code}` : '') };
  });
}

async function ensureRecommendations(database, workspaceId, rows) {
  for (const row of rows.filter(candidate => candidate.shortage && candidate.dailyRate > 0)) {
    const recommended = Math.max(row.inferredReorder, row.safetyStock || 0);
    if (row.reorderPoint !== null && Math.abs(row.reorderPoint - recommended) < 2) continue;
    const key = `postgres-planning:reorder:${row.sku_id}:${recommended}`;
    const at = nowIso();
    await database.query(`INSERT INTO planning_recommendations
      (id,workspace_id,kind,subject_type,subject_id,sku_id,current_value,recommended_value,headline,why,
       confidence,evidence,authority_verdict,authority_detail,status,idempotency_key,created_at,updated_at)
      VALUES($1,$2,'reorder_point','sku',$3,$3,$4,$5,$6,$7,$8,$9,'needs_approval',$10,'OPEN',$11,$12,$12)
      ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`, [newId('plan'), workspaceId, row.sku_id,
      row.reorderPoint, recommended, `Reorder ${row.displayName} at ${recommended}`,
      `${row.available} available, ${row.incoming} incoming, and ${row.sold90} issued in the last 90 days.`,
      row.sold90 >= 30 ? 'high' : 'moderate', JSON.stringify({ dailyRate:row.dailyRate,leadTimeDays:row.leadTimeDays }),
      JSON.stringify({ reason:'A person must approve a replenishment-policy change.' }), key, at]);
  }
}

async function openRecommendations(database, workspaceId) {
  return (await database.query(`SELECT recommendation.*,item.name,sku.code FROM planning_recommendations recommendation
    LEFT JOIN skus sku ON sku.id=recommendation.sku_id LEFT JOIN items item ON item.id=sku.item_id
    WHERE recommendation.workspace_id=$1 AND recommendation.status='OPEN'
    ORDER BY recommendation.created_at DESC,recommendation.id DESC LIMIT 100`, [workspaceId])).rows.map(row => ({
      ...row,currentValue:number(row.current_value),recommendedValue:number(row.recommended_value),
      evidence:object(row.evidence),authorityDetail:object(row.authority_detail),
  }));
}

async function accuracy(database, workspaceId) {
  const row = (await database.query(`SELECT COUNT(*) FILTER(WHERE comparable=1) AS comparable,
    AVG(absolute_error) FILTER(WHERE comparable=1) AS mean_absolute_error,
    AVG(error_units) FILTER(WHERE comparable=1) AS bias FROM forecast_outcomes WHERE workspace_id=$1`, [workspaceId])).rows[0];
  const comparable = Number(row.comparable || 0);
  return { comparable, meanAbsoluteError:row.mean_absolute_error === null ? null : Number(row.mean_absolute_error).toFixed(1),
    bias:row.bias === null ? null : Number(Number(row.bias).toFixed(1)),
    summary:comparable ? `${comparable} forecasts have reached a measurable outcome.` : 'No forecast has reached its outcome date yet.' };
}

function transfers(rows) {
  const suggestions = [];
  const bySku = new Map();
  for (const row of rows) { if (!bySku.has(row.sku_id)) bySku.set(row.sku_id, []); bySku.get(row.sku_id).push(row); }
  for (const locations of bySku.values()) {
    for (const shortage of locations.filter(row => row.shortage)) {
      const source = locations.filter(row => row.location_id !== shortage.location_id && row.available > row.effectiveReorder)
        .sort((left, right) => right.available - left.available)[0];
      if (!source) continue;
      const units = Math.min(source.available - source.effectiveReorder, Math.max(1, shortage.effectiveReorder - shortage.projected));
      if (units > 0) suggestions.push({ skuId:shortage.sku_id,displayName:shortage.displayName,units,
        fromLocationName:source.location_name,toLocationName:shortage.location_name,
        why:`Uses stock already owned before buying more. ${source.location_name} retains ${source.available - units} available.` });
    }
  }
  return suggestions;
}

async function overview(database, workspaceId) {
  const goal = await goals(database, workspaceId); const rows = await position(database, workspaceId);
  await ensureRecommendations(database, workspaceId, rows);
  const maxDays = goal.maxDaysOfSupply || 90;
  const shortages = rows.filter(row => row.shortage).sort((a, b) => (a.daysOfSupply ?? 999999) - (b.daysOfSupply ?? 999999));
  const excess = rows.filter(row => row.onHand > 0 && ((row.targetStock !== null && row.onHand > row.targetStock)
    || (row.daysOfSupply !== null && row.daysOfSupply > maxDays))).map(row => {
      const keep = row.targetStock ?? Math.ceil(row.dailyRate * maxDays); const units = Math.max(0, row.onHand - keep);
      return { ...row,excessUnits:units,excessValueMinor:row.costMinor === null ? null : units * row.costMinor };
    }).sort((a, b) => (b.excessValueMinor || 0) - (a.excessValueMinor || 0));
  const heldMinor = rows.reduce((sum, row) => sum + (row.costMinor === null ? 0 : row.onHand * row.costMinor), 0);
  return { scanned:new Set(rows.map(row => row.sku_id)).size,rows,shortages,excess,transfers:transfers(rows),
    recommendations:await openRecommendations(database,workspaceId),goals:goal,accuracy:await accuracy(database,workspaceId),
    heldMinor,inventoryCapMinor:goal.inventoryCapMinor };
}

async function decide(database, ctx, id, decision) {
  return database.transaction(async client => {
    const row = (await client.query(`SELECT * FROM planning_recommendations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [ctx.workspaceId,id])).rows[0];
    if (!row) throw new NotFoundError('That planning recommendation is not in this inventory.');
    if (row.status !== 'OPEN') return { ...row,replayed:true };
    const at = nowIso();
    if (decision === 'decline') {
      const changed = (await client.query(`UPDATE planning_recommendations SET status='DECLINED',decided_by_user_id=$3,
        decided_at=$4,updated_at=$4,resulting_detail=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
      [ctx.workspaceId,id,ctx.actorId,at,JSON.stringify({ reason:'Kept current policy.' })])).rows[0];
      return { ...changed,replayed:false };
    }
    if (!['reorder_point','target_stock','safety_stock'].includes(row.kind) || !row.sku_id) {
      throw new ValidationError('This recommendation cannot be applied as a replenishment policy.');
    }
    const value = Number(row.recommended_value);
    if (!Number.isSafeInteger(value) || value < 0) throw new ValidationError('The recommended policy value is invalid.');
    const current = (await client.query(`SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2
      AND location_id IS NULL FOR UPDATE`, [ctx.workspaceId,row.sku_id])).rows[0];
    const fields = { reorder_point:'reorder_point',target_stock:'target_stock',safety_stock:'safety_stock' };
    const next = { reorder_point:current?.reorder_point ?? null,target_stock:current?.target_stock ?? null,
      safety_stock:current?.safety_stock ?? null,[fields[row.kind]]:value };
    const policyId = current?.id || newId('rpol');
    const values = [policyId,ctx.workspaceId,row.sku_id,next.reorder_point,next.target_stock,next.safety_stock,
      `Approved planning recommendation ${row.id}`,at];
    if (current) await client.query(`UPDATE reorder_policies SET reorder_point=$4,target_stock=$5,safety_stock=$6,
      source='foundry',notes=$7,updated_at=$8 WHERE workspace_id=$2 AND id=$1`, values);
    else await client.query(`INSERT INTO reorder_policies
      (id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,notes,created_at,updated_at)
      VALUES($1,$2,$3,NULL,$4,$5,$6,'foundry',$7,$8,$8)`, values);
    const changed = (await client.query(`UPDATE planning_recommendations SET status='APPLIED',decided_by_user_id=$3,
      decided_at=$4,updated_at=$4,resulting_action=$5,resulting_detail=$6 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,id,ctx.actorId,at,policyId,JSON.stringify({ field:fields[row.kind],value })])).rows[0];
    return { ...changed,replayed:false };
  }, { isolation:'SERIALIZABLE',retrySafe:true });
}

module.exports = { goals,saveGoals,position,overview,openRecommendations,decide };
