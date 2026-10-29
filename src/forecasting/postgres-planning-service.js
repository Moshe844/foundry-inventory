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

async function position(database,workspaceId,{recommendationsOnly=false}={}){
 const source=await require('../purchasing/postgres-replenishment-state').rows(database,workspaceId,{eligibleOnly:recommendationsOnly});
 return source.map(row=>{const p=require('../purchasing/replenishment-decision').derive(row);return {...row,...p,name:row.item_name,sold90:p.issued,dailyRate:p.rate,leadTimeDays:p.lead,reorderPoint:row.planning_suppressed?null:number(row.reorder_point),targetStock:p.target,safetyStock:p.safety,costMinor:number(row.cost_minor),effectiveReorder:p.reorder,displayName:row.item_name+(row.code?' · '+row.code:'')};}).sort((a,b)=>a.item_name.localeCompare(b.item_name)||Number(a.sku_position)-Number(b.sku_position)||a.location_name.localeCompare(b.location_name));
}

async function ensureRecommendations(database, workspaceId, rows) {
  for (const row of rows.filter(candidate => candidate.shortage && candidate.dailyRate > 0&&candidate.inferredReorder!==null)) {
    const recommended = Math.max(row.inferredReorder, row.safetyStock || 0);
    if (row.reorderPoint !== null && Math.abs(row.reorderPoint - recommended) < 2) continue;
    const key = `postgres-planning:reorder:${row.sku_id}:${row.location_id||'workspace'}:${recommended}`;
    const at = nowIso();
    await database.query(`INSERT INTO planning_recommendations
      (id,workspace_id,kind,subject_type,subject_id,sku_id,current_value,recommended_value,headline,why,
       confidence,evidence,authority_verdict,authority_detail,status,idempotency_key,created_at,updated_at)
      VALUES($1,$2,'reorder_point','sku',$3,$3,$4,$5,$6,$7,$8,$9,'needs_approval',$10,'OPEN',$11,$12,$12)
      ON CONFLICT(workspace_id,idempotency_key) DO NOTHING`, [newId('plan'), workspaceId, row.sku_id,
      row.reorderPoint, recommended, `Reorder ${row.displayName} in ${row.location_name} at ${recommended}`,
      `${row.location_name}: ${row.available} available, ${row.incoming} incoming, and ${row.sold90} issued in the last 90 days.`,
      row.sold90 >= 30 ? 'high' : 'moderate', JSON.stringify({ dailyRate:row.dailyRate,leadTimeDays:row.leadTimeDays,locationId:row.location_id }),
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
  return require('../purchasing/replenishment-decision').transferPlan(rows).map(({skuId,source,destination,quantity})=>({
    skuId,displayName:destination.displayName,units:quantity,fromLocationName:source.location_name,toLocationName:destination.location_name,
    why:`Uses stock already owned before buying more. ${source.location_name} retains ${source.available-quantity} available.`
  }));
}

async function overview(database, workspaceId) {
  await require('../commercial/enforcement').workspace(database,workspaceId,'planning.transfer_before_buy');
  const goal = await goals(database, workspaceId); const rows = await position(database, workspaceId);
  const maxDays = goal.maxDaysOfSupply || 90;
  const shortages = rows.filter(row => row.shortage).sort((a, b) => (a.daysOfSupply ?? 999999) - (b.daysOfSupply ?? 999999));
  const excess = rows.filter(row => row.scope!=='workspace'&&row.onHand > 0 && ((row.targetStock !== null && row.onHand > row.targetStock)
    || (row.daysOfSupply !== null && row.daysOfSupply > maxDays))).map(row => {
      const keep = row.targetStock ?? Math.ceil(row.dailyRate * maxDays); const units = Math.max(0, row.onHand - keep);
      return { ...row,excessUnits:units,excessValueMinor:row.costMinor === null ? null : units * row.costMinor };
    }).sort((a, b) => (b.excessValueMinor || 0) - (a.excessValueMinor || 0));
  const heldMinor = rows.filter(row=>row.scope!=='workspace').reduce((sum, row) => sum + (row.costMinor === null ? 0 : row.onHand * row.costMinor), 0);
  return { scanned:new Set(rows.map(row => row.sku_id)).size,rows,shortages,excess,transfers:transfers(rows),
    recommendations:await openRecommendations(database,workspaceId),goals:goal,accuracy:await accuracy(database,workspaceId),
    heldMinor,inventoryCapMinor:goal.inventoryCapMinor };
}

// Derived recommendation persistence belongs to an authorized background
// evaluation. Inspecting a forecast is a read, including for the agent browser.
async function refreshRecommendations(database,workspaceId){
  await require('../commercial/enforcement').workspace(database,workspaceId,'planning.transfer_before_buy');
  await ensureRecommendations(database,workspaceId,await position(database,workspaceId,{recommendationsOnly:true}));
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
    const locationId=object(row.evidence).locationId??null;
    if(locationId&&!(await client.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1 AND custody_agreement_id IS NULL',[ctx.workspaceId,locationId])).rows.length)throw new ValidationError('The recommended location is no longer active. Review the current plan.');
    const current = (await client.query(`SELECT * FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2
      AND location_id IS NOT DISTINCT FROM $3 FOR UPDATE`, [ctx.workspaceId,row.sku_id,locationId])).rows[0];
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
        VALUES($1,$2,$3,$9,$4,$5,$6,'foundry',$7,$8,$8)`, [...values,locationId]);
    const changed = (await client.query(`UPDATE planning_recommendations SET status='APPLIED',decided_by_user_id=$3,
      decided_at=$4,updated_at=$4,resulting_action=$5,resulting_detail=$6 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,id,ctx.actorId,at,policyId,JSON.stringify({ field:fields[row.kind],value })])).rows[0];
    return { ...changed,replayed:false };
  }, { isolation:'SERIALIZABLE',retrySafe:true });
}

module.exports = { goals,saveGoals,position,overview,openRecommendations,decide,refreshRecommendations };
require('../commercial/enforcement').guardExports(module.exports,0,1,{saveGoals:'planning.basic',decide:'planning.basic',overview:'planning.basic',refreshRecommendations:'planning.basic'});
