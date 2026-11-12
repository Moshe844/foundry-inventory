'use strict';

const balance = require('./agent-transfer-balance-source');
const exact = require('../domain/exact-quantity');
const { ValidationError, AuthorizationError } = require('../domain/errors');
const { hash } = require('../pricing/postgres-promotions');
const { MAX_QUANTITY } = require('../domain/physical-stock-input');

function unitLimit(value) {
  const limit = exact.safeNumber(String(value ?? ''), { positive: true, label: 'Transfer limit' });
  if (limit > MAX_QUANTITY) throw new ValidationError('The transfer limit exceeds the supported stocking quantity.');
  return limit;
}

function inScope(policy, skuId, sourceId, destinationId, kitSkuId = null) {
  const { sourceLocationId, destinationLocationId } = policy?.thresholds?.transferRoute || {};
  return !policy || (
    (!policy.itemScope.length || policy.itemScope.includes(skuId) || kitSkuId && policy.itemScope.includes(kitSkuId)) &&
    (!policy.locationScope.length || policy.locationScope.includes(sourceId) && policy.locationScope.includes(destinationId)) &&
    (!sourceLocationId || sourceLocationId === sourceId) && (!destinationLocationId || destinationLocationId === destinationId)
  );
}

async function profiles(db, workspaceId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`SELECT i.*,s.id sku_id,s.code,s.variant_label FROM skus s
    JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id WHERE s.workspace_id=$1
    AND s.id=ANY($2::text[]) AND s.is_active=1 AND i.is_active=1`, [workspaceId, ids]);
  return new Map(rows.map(row => [row.sku_id, row]));
}

async function recipes(db, workspaceId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await db.query(`SELECT DISTINCT kit_sku_id FROM kit_components
    WHERE workspace_id=$1 AND kit_sku_id=ANY($2::text[]) AND stock_basis='components'`, [workspaceId, ids]);
  const entries = [];
  for (const row of rows) {
    try {
      entries.push([row.kit_sku_id, { parts: await require('../domain/postgres-kit-service').explode(db, workspaceId, row.kit_sku_id) }]);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      entries.push([row.kit_sku_id, { reason: error.message }]);
    }
  }
  return new Map(entries);
}

function targetForPart(kit, part, component) {
  const kitTarget = exact.convert(kit.target, { numerator: part.quantity, precision: 6 });
  return balance.max(component.target ?? '0', kitTarget);
}

async function route(db, ctx, profile, from, to, data, maximum, previous, kit = null) {
  if (kit && (!Number.isSafeInteger(Number(kit.target)) || Number(kit.target) <= 0))
    throw new ValidationError('Record the destination stock target in whole kits before transferring their components.');
  // A recipe can establish demand at a destination before the component has
  // ever had a balance, sale or replenishment rule at that location.
  let positions = data.bySku.get(profile.sku_id) || [];
  let component = positions.find(p => p.id === to.id);
  if (kit && !component) {
    component = { id: to.id, name: to.name, target: null, stock: null, free: '0', reserve: '0', spare: '0',
      committed: '0', held: '0', datedIncoming: '0', projected: '0', draftUnits: '0', openProjection: '0',
      drafts: [], incoming: [], uncertainty: [] };
    positions = [...positions, component];
    data = { ...data, bySku: new Map(data.bySku).set(profile.sku_id, positions) };
  }
  const target = kit ? targetForPart(kit, kit.part, component) : null;
  const current = await balance.exactRoute(db, ctx, profile, from, to, maximum, data, previous, { routine: true, target });
  return { ...current, ...(kit ? { kitSkuId: kit.skuId, kitCode: kit.code, recipe: kit.parts, kitTarget: kit.target } : {}),
    fingerprint: hash([current.fingerprint, kit]) };
}

function describe(p) {
  return p.lines.map(line => [line.quantity + ' ' + p.unit, line.lot ? 'Batch ' + line.lot : null,
    line.serials?.length ? 'Serials ' + line.serials.join(', ') : null,
    line.secondaryQuantity != null ? line.secondaryQuantity + ' ' + p.secondaryUnit : null].filter(Boolean).join(' · '));
}

function candidate(p, raw, profile, maximum) {
  return {
    type: 'transfer', skuId: p.skuId, sourceVersion: p.source.sourceVersion || '0', code: p.code,
    displayName: p.name + (profile.variant_label ? ' — ' + profile.variant_label : ''), quantity: exact.safeNumber(p.quantity),
    sourceLocationId: p.source.id, sourceLocationName: p.source.name, destinationLocationId: p.destination.id,
    destinationLocationName: p.destination.name, destinationAvailable: exact.safeNumber(p.destination.free, { signed: true }),
    incoming: exact.safeNumber(balance.sub(p.destination.openProjection, p.destination.free)),
    reorderPoint: raw.reorder, targetStock: p.destination.target, sourceAvailable: exact.safeNumber(p.source.free),
    sourceSafety: exact.safeNumber(p.source.reserve), priority: 90, urgency: raw.available <= 0 ? 'immediate' : 'soon',
    unit: p.unit, secondaryUnit: p.secondaryUnit, exactSource: p.fingerprint, maximum,
    kitSkuId: p.kitSkuId || null, kitCode: p.kitCode || null, selections: describe(p),
    evidence: [{ fact: 'destination_available', value: p.destination.free }, { fact: 'destination_target', value: p.destination.target },
      { fact: 'source_available', value: p.source.free }, { fact: 'source_protected_stock', value: p.source.reserve },
      { fact: 'dated_incoming', value: p.destination.datedIncoming }, { fact: 'tracking', value: describe(p) }],
  };
}

async function choices(db, workspaceId, shortages, policy, { protect = null } = {}) {
  const ctx = { workspaceId };
  const ids = [...new Set(shortages.map(row => row.sku_id))];
  const kits = await recipes(db, workspaceId, ids);
  const all = await profiles(db, workspaceId, [...new Set([...ids, ...[...kits.values()].flatMap(k => k.parts || []).map(p => p.skuId)])]);
  const facts = await balance.snapshot(db, ctx, [...all.values()]);
  const result = new Map(), consumed = new Map();
  for (const raw of shortages) {
    const recipe = kits.get(raw.sku_id), kitParts = recipe?.parts, targetProfile = all.get(raw.sku_id);
    const positions = facts.bySku.get(raw.sku_id) || [];
    const destination = positions.find(p => p.id === raw.location_id);
    if (!destination || !targetProfile || destination.target == null) continue;
    const candidates = kitParts || [{ skuId: raw.sku_id }];
    const key = raw.sku_id + ':' + raw.location_id;
    if (recipe?.reason) {
      result.set(key, { reason: recipe.reason });
      continue;
    }
    if (kitParts) result.set(key, { reason: 'Balance the kit’s exact stocked components where the recipe, source and target support it.' });
    for (const part of candidates) {
      const profile = all.get(part.skuId);
      if (!profile) continue;
      const kit = kitParts ? { skuId: raw.sku_id, code: targetProfile.code, target: destination.target, parts: kitParts, part } : null;
      // A part the source warehouse needs for its own kits is not spare there.
      const donors = (facts.bySku.get(part.skuId) || []).filter(p => p.id !== destination.id && balance.cmp(p.spare, '0') > 0 &&
        !(protect && protect(part.skuId, p.id)));
      donors.sort((a, b) => Number(inScope(policy, part.skuId, b.id, destination.id, kit?.skuId)) -
        Number(inScope(policy, part.skuId, a.id, destination.id, kit?.skuId)) || balance.cmp(b.spare, a.spare) || a.id.localeCompare(b.id));
      for (const from of donors) {
        const sourceKey = JSON.stringify([part.skuId, from.id]);
        const prior = consumed.get(sourceKey) || [];
        const maximum = balance.sub(from.spare, balance.sum(prior.map(line => line.quantity)));
        if (balance.cmp(maximum, '0') <= 0) continue;
        try {
          const plan = await route(db, ctx, profile, from, destination, facts, maximum, prior, kit);
          consumed.set(sourceKey, [...prior, ...plan.lines]);
          result.set(key, candidate(plan, raw, profile, maximum));
          break;
        } catch (error) {
          if (!(error instanceof ValidationError)) throw error;
          if (!result.has(key) || result.get(key).reason) result.set(key, { reason: error.message });
        }
      }
      if (result.get(key)?.type === 'transfer') break;
    }
  }
  return result;
}

async function lockAuthority(db, ctx, policyId) {
  const grant = (await db.query(`SELECT w.owner_account_id FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=w.owner_account_id
    WHERE w.id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL AND NOT EXISTS(
      SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    FOR SHARE OF w,u`, [ctx.workspaceId, ctx.actorId])).rows[0];
  if (!grant) throw new AuthorizationError('Only the current active owner can use standing transfer authority.');
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE', [grant.owner_account_id]);
  await db.query('SELECT id FROM automation_policies WHERE workspace_id=$1 AND id=$2 FOR SHARE', [ctx.workspaceId, policyId]);
  await db.query("SELECT workspace_id FROM autopilot_capabilities WHERE workspace_id=$1 AND capability='inventory_transfers' FOR SHARE", [ctx.workspaceId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE', [ctx.workspaceId]);
  await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=119 FOR SHARE', [ctx.workspaceId]);
}

async function currentPlan(db, ctx, action) {
  const ids = [action.sourceLocationId, action.destinationLocationId];
  await db.query('SELECT id FROM locations WHERE workspace_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE', [ctx.workspaceId, ids]);
  const skuIds = [action.skuId, action.kitSkuId].filter(Boolean);
  await db.query('SELECT location_id FROM balances WHERE workspace_id=$1 AND sku_id=ANY($2::text[]) AND location_id=ANY($3::text[]) ORDER BY sku_id,location_id FOR UPDATE',
    [ctx.workspaceId, skuIds, ids]);
  const { from, to } = await balance.locations(db, ctx, ...ids);
  const all = await profiles(db, ctx.workspaceId, skuIds);
  const profile = all.get(action.skuId);
  if (!profile) throw new ValidationError('The approved product is unavailable.');
  const facts = await balance.snapshot(db, ctx, [...all.values()]);
  let kit = null;
  if (action.kitSkuId) {
    const parts = (await recipes(db, ctx.workspaceId, [action.kitSkuId])).get(action.kitSkuId)?.parts;
    const part = parts?.find(p => p.skuId === action.skuId);
    const target = facts.bySku.get(action.kitSkuId)?.find(p => p.id === to.id)?.target;
    if (!part || target == null) throw new ValidationError('The kit recipe or destination target changed. Review this transfer again.');
    kit = { skuId: action.kitSkuId, code: all.get(action.kitSkuId).code, target, parts, part };
  }
  const plan = await route(db, ctx, profile, from, to, facts, action.maximum, [], kit);
  if (plan.fingerprint !== action.exactSource || balance.cmp(plan.quantity, action.quantity) !== 0) {
    throw new ValidationError('The transfer’s stock, holds, cost, tracking, or target changed. Review a fresh transfer.');
  }
  return plan;
}

module.exports = { unitLimit, inScope, choices, lockAuthority, currentPlan };
