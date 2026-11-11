'use strict';

const policy = require('../commercial/agent-plan');
const { ValidationError, AuthorizationError } = require('../domain/errors');
const { newId, nowIso } = require('../lib/util');
const decision = require('../purchasing/replenishment-decision');
const audit = require('../operations/postgres-security-audit');
const source = require('./location-reorder-source');
const stock = require('../domain/stock-quantity');
const { hash } = require('../pricing/postgres-promotions');

const action = 'planning.location_reorder';
const jobKind = 'planning.location-reorder.v1';

async function owner(db, ctx, lock = false) {
  const row = (await db.query(`SELECT w.owner_account_id FROM users u JOIN workspaces w
    ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
    JOIN accounts account ON account.id=u.account_id
    WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
    ${lock ? 'FOR SHARE OF account,u,w' : ''}`, [ctx.workspaceId, ctx.actorId])).rows[0];
  if (!row) throw new AuthorizationError('Only the current inventory owner can authorize location reorder changes.');
  return row.owner_account_id;
}

async function lockAuthority(db, ctx) {
  const accountId = await owner(db, ctx, true);
  await db.query('SELECT id FROM account_subscriptions WHERE account_id=$1 FOR SHARE', [accountId]);
  await db.query('SELECT workspace_id FROM workspace_autopilot WHERE workspace_id=$1 FOR SHARE', [ctx.workspaceId]);
  await db.query('SELECT workspace_id FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=120 FOR SHARE', [ctx.workspaceId]);
}

async function ruleFor(db, workspaceId, skuId, locationId, lock = false) {
  return (await db.query(`SELECT r.*,r.ceiling::text FROM stockchief_runtime.location_reorder_rules r
    WHERE r.workspace_id=$1 AND r.sku_id=$2 AND r.location_id=$3${lock ? ' FOR UPDATE OF r' : ''}`,
    [workspaceId, skuId, locationId])).rows[0];
}

async function examples(db, ctx, skuId, locationId, profileKey, id = null) {
  return (await db.query(`SELECT p.id,p.evidence::jsonb,p.resulting_detail::jsonb FROM planning_recommendations p
    JOIN reorder_policies r ON r.workspace_id=p.workspace_id AND r.id=p.resulting_action AND r.sku_id=p.sku_id AND r.location_id=$3
    WHERE p.workspace_id=$1 AND p.sku_id=$2 AND p.status='APPLIED' AND p.decided_by_user_id=$4
      AND p.resulting_detail::jsonb->>'kind'='location_reorder_manual'
      AND p.evidence::jsonb->>'profileKey'=$5 AND ($6::text IS NULL OR p.id=$6)
    ORDER BY p.decided_at DESC,p.id LIMIT 25`, [ctx.workspaceId, skuId, locationId, ctx.actorId, profileKey, id])).rows;
}

async function configure(db, ctx, input) {
  const { skuId, locationId } = input;
  return db.transaction(async c => {
    await lockAuthority(c, ctx);
    const prior = await ruleFor(c, ctx.workspaceId, skuId, locationId, true);
    const revision = Number(input.revision ?? 0);
    if (!Number.isSafeInteger(revision) || revision < 0 || revision !== (prior?.revision || 0))
      throw new ValidationError('The location reorder rule changed. Reload it before saving or stopping it.');
    if (input.remove === '1') {
      if (prior) {
        await c.query('DELETE FROM stockchief_runtime.location_reorder_rules WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',
          [ctx.workspaceId, skuId, locationId]);
        await audit.record(c, ctx, { action: 'Removed automatic reorder rule', before: { skuId, locationId, ceiling: prior.ceiling } });
      }
      return;
    }
    const account = await policy.requireWorkspaceJob(c, ctx.workspaceId, 120, 'automatic', { trained: true });
    if (input.confirmed !== 'yes') throw new ValidationError('Confirm this exact product, location and maximum target.');
    const profile = await source.profile(c, ctx.workspaceId, skuId, locationId, true);
    const profileKey = source.profileKey(profile, locationId);
    const ceiling = stock.validate(profile, String(input.ceiling ?? ''), { label: 'Maximum target in stocking units', total: true });
    let taught = prior?.profile_key === profileKey && prior.authorized_by === ctx.actorId ? prior.taught_recommendation_id : null;
    if (account.plan === 'growth' || input.exampleId) {
      const [proof] = await examples(c, ctx, skuId, locationId, profileKey, input.exampleId || taught || 'missing-example');
      if (!proof || Number(proof.evidence.maximum) < ceiling)
        throw new ValidationError('Complete an individually approved matching reorder example at or above this maximum before teaching Growth.');
      taught = proof.id;
    } else if (taught && Number(prior.ceiling) < ceiling) taught = null;
    await require('../manager/postgres-operating-instructions').checkRuleLimit(c, ctx, [], prior ? 0 : 1);
    await require('../commercial/storage-capacity').reserve(c, ctx.workspaceId, 'location-reorder-rule:' + profileKey, 8192, { finished: true });
    await c.query(`INSERT INTO stockchief_runtime.location_reorder_rules(workspace_id,sku_id,location_id,authorized_by,ceiling,profile_key,taught_recommendation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(workspace_id,sku_id,location_id) DO UPDATE
      SET ceiling=EXCLUDED.ceiling,authorized_by=EXCLUDED.authorized_by,profile_key=EXCLUDED.profile_key,
        taught_recommendation_id=EXCLUDED.taught_recommendation_id,revision=location_reorder_rules.revision+1`,
    [ctx.workspaceId, skuId, locationId, ctx.actorId, ceiling, profileKey, taught]);
    await audit.record(c, ctx, { action: 'Authorized automatic reorder thresholds', after: { skuId, locationId, ceiling, unit: profile.unit_label, exampleId: taught } });
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function page(db, ctx, { skuId, locationId }) {
  await owner(db, ctx);
  const account = await policy.requireWorkspaceJob(db, ctx.workspaceId, 120, 'draft');
  const profile = await source.profile(db, ctx.workspaceId, skuId, locationId);
  const profileKey = source.profileKey(profile, locationId);
  const saved = await ruleFor(db, ctx.workspaceId, skuId, locationId);
  const completed = await examples(db, ctx, skuId, locationId, profileKey);
  let estimate = null, problem = null;
  try { estimate = await source.current(db, ctx.workspaceId, skuId, locationId); }
  catch (error) { if (!(error instanceof ValidationError)) throw error; problem = error.message; }
  return { profile, estimate, problem, saved, completed, tier: account.plan,
    blocked: await policy.stopped(db, ctx.workspaceId, account, action, false) };
}

async function lockPosition(c, workspaceId, skuId, locationId) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([workspaceId, skuId, locationId])]);
  await source.profile(c, workspaceId, skuId, locationId, true);
  await c.query('SELECT id FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3 FOR UPDATE', [workspaceId, skuId, locationId]);
  await c.query('SELECT sku_id FROM stockchief_runtime.replenishment_source_versions WHERE workspace_id=$1 AND sku_id=$2 FOR UPDATE', [workspaceId, skuId]);
}

async function apply(c, ctx, estimate, routine, ceiling = null) {
  const { skuId, locationId, minimum, maximum, current, digest, unit, issued, lead } = estimate;
  if (!estimate.changed) return { unchanged: true };
  const policyId = current.policyId || newId('rpol'), id = newId('plan'), at = nowIso();
  await require('../commercial/storage-capacity').reserve(c, ctx.workspaceId, 'location-reorder:' + digest, 16384, { finished: true });
  if (current.policyId) {
    await c.query(`UPDATE reorder_policies SET reorder_point=$3,target_stock=$4,source='foundry',notes=$5,updated_at=$6
      WHERE workspace_id=$1 AND id=$2`, [ctx.workspaceId, policyId, minimum, maximum, 'Location thresholds from recorded local sales', at]);
  } else {
    await c.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,notes,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'foundry',$7,$8,$8)`, [policyId, ctx.workspaceId, skuId, locationId, minimum, maximum, 'Location thresholds from recorded local sales', at]);
  }
  const kind = routine ? 'location_reorder_routine' : 'location_reorder_manual';
  await c.query(`INSERT INTO planning_recommendations(id,workspace_id,kind,subject_type,subject_id,sku_id,current_value,recommended_value,
    headline,why,evidence,status,decided_by_user_id,decided_at,resulting_action,resulting_detail,idempotency_key,created_at,updated_at)
    VALUES($1,$2,'reorder_point','sku',$3,$3,$4,$5,$6,$7,$8,'APPLIED',$9,$10,$11,$12,$13,$10,$10)`,
  [id, ctx.workspaceId, skuId, current.minimum, minimum, estimate.code + ' at ' + estimate.location,
    issued + ' ' + unit + ' sold in 90 days and ' + lead + ' recorded lead days.', JSON.stringify(estimate), ctx.actorId, at, policyId,
    JSON.stringify({ kind, skuId, locationId, minimum, maximum, ceiling, unit, digest }), kind + ':' + digest]);
  await audit.record(c, ctx, { action: 'Updated location reorder thresholds', reference: id, before: current,
    after: { skuId, locationId, minimum, maximum, unit, issued, lead, ceiling, digest, routine } });
  return { id, policyId, minimum, maximum };
}

async function approve(db, ctx, { skuId, locationId, digest }) {
  return db.transaction(async c => {
    await lockAuthority(c, ctx);
    const account = await policy.requireWorkspaceJob(c, ctx.workspaceId, 120, 'draft');
    const stopped = await policy.stopped(c, ctx.workspaceId, account, action, false);
    if (stopped) throw new ValidationError(stopped);
    await lockPosition(c, ctx.workspaceId, skuId, locationId);
    const prior = (await c.query(`SELECT id,resulting_action policy_id,resulting_detail::jsonb FROM planning_recommendations
      WHERE workspace_id=$1 AND sku_id=$2 AND decided_by_user_id=$3 AND status='APPLIED'
      AND idempotency_key=$4 AND evidence::jsonb->>'locationId'=$5`, [ctx.workspaceId, skuId, ctx.actorId, 'location_reorder_manual:' + digest, locationId])).rows[0];
    if (prior) return { id: prior.id, policyId: prior.policy_id, ...prior.resulting_detail, replayed: true };
    const estimate = await source.current(c, ctx.workspaceId, skuId, locationId);
    if (estimate.digest !== digest) throw new ValidationError('The local sales, product units, lead time or thresholds changed. Review a fresh recommendation.');
    return apply(c, ctx, estimate, false);
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function canRun(db, workspaceId, account) {
  return policy.usesAgentTerms(account) && policy.permits(account.plan, 120, 'automatic', { trained: true })
    && !(await policy.stopped(db, workspaceId, account, action, true))
    && (await require('../autopilot/postgres-service').getState(db, workspaceId)).canAutomate;
}

async function queuePage(db, workspaceId, skuIds, { cycleId = null } = {}) {
  if (!skuIds.length) return 0;
  const rules = (await db.query(`SELECT r.* FROM stockchief_runtime.location_reorder_rules r
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
    WHERE r.workspace_id=$1 AND r.sku_id=ANY($2::text[]) AND r.profile_key IS NOT NULL ORDER BY r.sku_id,r.location_id`,
  [workspaceId, skuIds])).rows;
  if (!rules.length) return 0;
  const account = await policy.accountState(db, workspaceId);
  if (!await canRun(db, workspaceId, account)) return 0;
  const estimates = await source.read(db, workspaceId, [...new Set(rules.map(r => r.sku_id))]);
  const entries = [];
  for (const rule of rules) {
    if (account.plan === 'growth' && !rule.taught_recommendation_id) continue;
    const estimate = estimates.get(source.key(rule.sku_id, rule.location_id));
    if (!estimate?.changed || estimate.profileKey !== rule.profile_key) continue;
    entries.push({ skuId: rule.sku_id, locationId: rule.location_id, actorId: rule.authorized_by, revision: rule.revision, digest: estimate.digest });
  }
  for (let offset = 0; offset < entries.length; offset += 10) {
    const part = entries.slice(offset, offset + 10);
    await require('../operations/postgres-job-queue').enqueue(db, { workspaceId, kind: jobKind,
      idempotencyKey: 'location-reorder:' + hash([cycleId || newId('local-reorder'), part]), payload: { entries: part }, priority: 70, maxAttempts: 3 });
  }
  return entries.length;
}

async function processBatch(c, workspaceId, { entries }) {
  if (!Array.isArray(entries) || entries.length > 10) throw new ValidationError('A queued reorder job needs exact product and location entries.');
  let updated = 0;
  const held = [];
  for (const entry of entries) {
    const { skuId, locationId, actorId, revision, digest } = entry;
    const ctx = { workspaceId, actorId };
    await c.query('SAVEPOINT location_reorder');
    try {
      await lockAuthority(c, ctx);
      const account = await policy.accountState(c, workspaceId);
      if (!await canRun(c, workspaceId, account)) throw new ValidationError('The current plan or owner mode holds routine reorder changes.');
      const rule = await ruleFor(c, workspaceId, skuId, locationId, true);
      if (!rule || rule.revision !== revision || rule.authorized_by !== actorId || account.plan === 'growth' && !rule.taught_recommendation_id)
        throw new ValidationError('The saved location rule or Growth example changed.');
      await lockPosition(c, workspaceId, skuId, locationId);
      const estimate = await source.current(c, workspaceId, skuId, locationId);
      if (estimate.changed && (estimate.digest !== digest || estimate.profileKey !== rule.profile_key))
        throw new ValidationError('The local sales, lead time, stocking unit or thresholds changed. Review a fresh run.');
      if (estimate.changed) {
        if (Number(estimate.maximum) > Number(rule.ceiling)) throw new ValidationError('The current target exceeds the owner’s saved maximum.');
        await apply(c, ctx, estimate, true, rule.ceiling);
        updated++;
      }
      await c.query('RELEASE SAVEPOINT location_reorder');
    } catch (error) {
      if (!['validation_error','forbidden','entitlement_required'].includes(error.code)) throw error;
      await c.query('ROLLBACK TO SAVEPOINT location_reorder');
      await c.query('RELEASE SAVEPOINT location_reorder');
      held.push({ skuId, locationId, reason: error.message });
    }
  }
  return { updated, held };
}
async function review(db,ctx,{filter,page}){
  const catalog=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*50])).rows;
  const {rows}=await db.query(`SELECT s.id,s.code,i.name,d.location_id,l.name AS location,sum(d.issued) AS sold,count(*) AS events FROM stockchief_runtime.replenishment_demand_events d
    JOIN movements m ON m.workspace_id=d.workspace_id AND m.id=d.movement_id AND m.reason_code IN ('sale','sold')
    JOIN skus s ON s.workspace_id=d.workspace_id AND s.id=d.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
    JOIN locations l ON l.workspace_id=d.workspace_id AND l.id=d.location_id AND l.is_active=1 AND l.custody_agreement_id IS NULL
    WHERE d.workspace_id=$1 AND d.occurred_at BETWEEN now()-interval '90 days' AND now() AND d.sku_id=ANY($2::text[])
    GROUP BY s.id,s.code,i.name,d.location_id,l.name HAVING count(*)>=2 ORDER BY s.code,s.id,l.name,d.location_id`,[ctx.workspaceId,catalog.slice(0,50).map(r=>r.id)]);
  const ids=[...new Set(rows.map(r=>r.id))],positions=ids.length?await require('../purchasing/postgres-replenishment-state').rows(db,ctx.workspaceId,{onlySkuIds:ids}):[];
  const details=[],bySku=new Map();
  for(const r of rows){
    const position=positions.find(p=>p.sku_id===r.id&&p.location_id===r.location_id);
    if(!position||position.planning_suppressed)continue;
    const demand=decision.derive({...position,issued:r.sold,issue_events:r.events});
    const item={SKU:r.code,Product:r.name,Location:r.location,'Sold in 90 days':Number(r.sold),'Reorder point':demand.inferredReorder};
    details.push(item);const total=bySku.get(r.id)||{SKU:r.code,'Sold in 90 days':0,'Reorder point':0};
    total['Sold in 90 days']+=Number(r.sold);total['Reorder point']+=demand.inferredReorder;bySku.set(r.id,total);
  }
  const state=await policy.accountState(db,ctx.workspaceId);
  return {rows:state.plan==='starter'?[...bySku.values()]:details,more:catalog.length>50,
    summary:'Reorder points use 90 days of physical sales, lead time and safety stock. Starter sees a product-level suggestion across eligible locations. A location needs at least two sales issues.'};
}
async function locationReview(db, ctx, { filter = '', page = 1 }) {
  const catalog = (await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id AND i.is_active=1
    WHERE s.workspace_id=$1 AND s.is_active=1 AND ($2='' OR lower(s.code)=lower($2)) ORDER BY s.code,s.id LIMIT 51 OFFSET $3`,
  [ctx.workspaceId, filter, (page - 1) * 50])).rows;
  const facts = await source.read(db, ctx.workspaceId, catalog.slice(0,50).map(row => row.id));
  return { more: catalog.length > 50, rows: [...facts.values()].map(p => ({
    SKU: p.code, Location: p.location, 'Actual local sales': p.issued ? p.issued + ' ' + p.unit : 'Needs review',
    'Reorder point': p.minimum || 'Review', Target: p.maximum || 'Review',
    ...(p.error ? { Review: p.error } : {}), link: '/planning/location-reorder?skuId=' + encodeURIComponent(p.skuId) + '&locationId=' + encodeURIComponent(p.locationId),
  })), summary: 'Review the reorder point and target for the selected product and location. StockChief uses distinct physical sales, recorded lead time and exact stocking increments. An owner sets the maximum target for routine work.' };
}
const definition={id:120,key:'location-reorder',label:'Set reorder points by location',filterLabel:'Exact SKU',readPage:locationReview};
module.exports={configure,page,approve,queuePage,processBatch,review,jobKind,definition};
