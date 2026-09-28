'use strict';

const { DomainError } = require('../domain/errors');
const config = require('../config');

class EntitlementError extends DomainError {
  constructor(message, details = {}) {
    super(message, { code:'entitlement_required', status:402 });
    this.details = details;
  }
}

const ACCESSIBLE = new Set(['ACTIVE','TRIALING','GRACE','COMP']);

async function subscriptionFor(database, accountId) {
  if (!accountId) return null;
  const subscription = (await database.query(`SELECT subscription.*,plan.public_name AS plan_name,plan.outcome AS plan_outcome,
      plan.grace_days FROM account_subscriptions subscription JOIN commercial_plans plan ON plan.id=subscription.plan_id
      WHERE subscription.account_id=$1`, [accountId])).rows[0] || null;
  return subscription ? {...subscription,cancel_at_period_end:Boolean(Number(subscription.cancel_at_period_end))} : null;
}

function operationalAccess(subscription, now = new Date()) {
  if (!subscription) return {mode:'UNSUBSCRIBED',canOperate:false,canRead:true};
  if(subscription.status==='GRACE'&&subscription.grace_ends_at&&new Date(subscription.grace_ends_at)<=now)
    return {mode:'SUSPENDED',canOperate:false,canRead:true};
  if(subscription.status==='TRIALING'&&subscription.trial_ends_at&&new Date(subscription.trial_ends_at)<=now)
    return {mode:'SUSPENDED',canOperate:false,canRead:true};
  if (ACCESSIBLE.has(subscription.status)) return {mode:subscription.status,canOperate:true,canRead:true};
  if (subscription.status === 'CANCELLED' && subscription.current_period_end
      && new Date(subscription.current_period_end) > now) return {mode:'CANCELLED_TERM',canOperate:true,canRead:true};
  return {mode:subscription.status,canOperate:false,canRead:true};
}

async function capabilityState(database, scope, capability, options = {}) {
  const subscription = options.subscription || await subscriptionFor(database, scope.accountId);
  const access = operationalAccess(subscription, options.now);
  if (!subscription && !config.commercial.requirePaidWorkspace) {
    return {capability,enabled:true,source:'development',subscription:null,access:{mode:'DEVELOPMENT',canOperate:true,canRead:true}};
  }
  if (!access.canOperate) return {capability,enabled:false,source:'subscription',subscription,access};
  const override = (await database.query(`SELECT * FROM commercial_entitlement_overrides
    WHERE (account_id=$1 OR workspace_id=$2) AND capability=$3 AND starts_at<=COALESCE($4::timestamptz,now())
      AND (ends_at IS NULL OR ends_at>COALESCE($4::timestamptz,now()))
    ORDER BY CASE WHEN workspace_id IS NOT NULL THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
  [scope.accountId,scope.workspaceId || null,capability,options.now || null])).rows[0];
  if (override) return {capability,enabled:Boolean(Number(override.enabled)),source:'override',override,subscription,access};
  const row = (await database.query(`SELECT enabled,configuration FROM commercial_plan_entitlements
    WHERE plan_id=$1 AND capability=$2`, [subscription.plan_id,capability])).rows[0];
  return {capability,enabled:Boolean(row && Number(row.enabled)),configuration:row?.configuration || {},
    source:'plan',subscription,access};
}

async function assertCapability(database, scope, capability, options = {}) {
  const state = await capabilityState(database, scope, capability, options);
  if (state.enabled) return state;
  const minimum = (await database.query(`SELECT plan.public_name,plan.id FROM commercial_plan_entitlements entitlement
    JOIN commercial_plans plan ON plan.id=entitlement.plan_id
    WHERE entitlement.capability=$1 AND entitlement.enabled=1 AND plan.is_public=1 AND plan.status='ACTIVE'
    ORDER BY plan.display_order LIMIT 1`, [capability])).rows[0];
  throw new EntitlementError(options.message || 'Your current plan does not include this capability.', {
    capability,currentPlan:state.subscription?.plan_id || null,recommendedPlan:minimum || null,
  });
}

function periodBounds(subscription, now = new Date()) {
  const start = subscription?.current_period_start ? new Date(subscription.current_period_start) : new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1));
  const end = subscription?.current_period_end ? new Date(subscription.current_period_end) : new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
  return {start,end};
}

async function meterState(database, scope, meter, options = {}) {
  const subscription = options.subscription || await subscriptionFor(database,scope.accountId);
  if (!subscription && !config.commercial.requirePaidWorkspace) return {meter,label:meter,used:0,included:null,hardLimit:null,
    remaining:null,overageUnits:0,overageAmountMinor:0,periodStart:null,periodEnd:null};
  if (!subscription) return {meter,used:0,included:0,hardLimit:0,remaining:0,overageUnits:0,overageAmountMinor:0};
  const policy = (await database.query(`SELECT * FROM commercial_plan_meters WHERE plan_id=$1 AND meter=$2`,
    [subscription.plan_id,meter])).rows[0] || {};
  const override = (await database.query(`SELECT * FROM commercial_entitlement_overrides
    WHERE (account_id=$1 OR workspace_id=$2) AND meter=$3 AND starts_at<=COALESCE($4::timestamptz,now())
      AND (ends_at IS NULL OR ends_at>COALESCE($4::timestamptz,now()))
    ORDER BY CASE WHEN workspace_id IS NOT NULL THEN 0 ELSE 1 END,created_at DESC LIMIT 1`,
  [scope.accountId,scope.workspaceId || null,meter,options.now || null])).rows[0];
  const {start,end} = periodBounds(subscription,options.now ? new Date(options.now) : new Date());
  const liveQueries={
    workspaces:`SELECT COUNT(*) AS used FROM workspaces WHERE owner_account_id=$1 AND deletion_requested_at IS NULL`,
    members:`SELECT COUNT(*) AS used FROM users member JOIN workspaces workspace ON workspace.id=member.workspace_id
      WHERE workspace.owner_account_id=$1 AND workspace.deletion_requested_at IS NULL`,
    locations:`SELECT COUNT(*) AS used FROM locations location JOIN workspaces workspace ON workspace.id=location.workspace_id
      WHERE workspace.owner_account_id=$1 AND workspace.deletion_requested_at IS NULL AND location.is_active=1`,
    connections:`SELECT COUNT(*) AS used FROM workspace_connectors connector JOIN workspaces workspace ON workspace.id=connector.workspace_id
      WHERE workspace.owner_account_id=$1 AND workspace.deletion_requested_at IS NULL AND connector.status<>'disconnected'`,
  };
  const used=liveQueries[meter]
    ?Number((await database.query(liveQueries[meter],[scope.accountId])).rows[0].used)
    :Number((await database.query(`SELECT COALESCE(SUM(units),0) AS used FROM commercial_usage_events
      WHERE account_id=$1 AND meter=$2 AND occurred_at>=$3 AND occurred_at<$4`,
    [scope.accountId,meter,start.toISOString(),end.toISOString()])).rows[0].used);
  const included = override?.limit_units === null || override?.limit_units === undefined
    ? (policy.included_units === null || policy.included_units === undefined ? null : Number(policy.included_units))
    : Number(override.limit_units);
  const structural=new Set(['workspaces','members','locations','connections']);
  const hardLimit = override&&structural.has(meter)?Number(override.limit_units):
    policy.hard_limit === null || policy.hard_limit === undefined ? null : Number(policy.hard_limit);
  const overageUnits = included === null ? 0 : Math.max(0,used-included);
  const block = Number(policy.overage_block_units || 0);const blockCost = Number(policy.overage_amount_minor || 0);
  return {meter,label:policy.label || meter,used,included,hardLimit,remaining:hardLimit===null?null:Math.max(0,hardLimit-used),
    overageUnits,overageAmountMinor:block&&blockCost?Math.ceil(overageUnits/block)*blockCost:0,periodStart:start,periodEnd:end};
}

async function ownerScopeForWorkspace(database,workspaceId){
  const workspace=(await database.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
  if(!workspace)throw new EntitlementError('This inventory does not have a commercial owner.',{workspaceId});
  return {accountId:workspace.owner_account_id,workspaceId};
}

async function operationalAccessForWorkspace(database,workspaceId,options={}){
  const scope=await ownerScopeForWorkspace(database,workspaceId);
  const subscription=await subscriptionFor(database,scope.accountId);
  const access=!subscription&&!config.commercial.requirePaidWorkspace
    ?{mode:'DEVELOPMENT',canOperate:true,canRead:true}
    :operationalAccess(subscription,options.now ? new Date(options.now) : new Date());
  return {scope,subscription,access};
}

async function assertWorkspaceOperational(database,workspaceId,options={}){
  const state=await operationalAccessForWorkspace(database,workspaceId,options);
  if(state.access.canOperate)return state;
  throw new EntitlementError('This StockChief subscription is read-only. Update billing or restore the plan before changing business records.',
    {workspaceId,subscriptionStatus:state.subscription?.status||'UNSUBSCRIBED',accessMode:state.access.mode});
}

async function assertMeterCapacity(database,scope,meter,additional=1,options={}){
  const state=await meterState(database,scope,meter,options);const amount=Math.max(0,Math.round(Number(additional||0)));
  if(state.hardLimit!==null&&state.used+amount>state.hardLimit)throw new EntitlementError(
    `${state.label} has reached the current plan limit. Upgrade before adding another.`,{meter,...state,additional:amount});
  return state;
}

async function recordUsage(database, scope, input) {
  const subscription=await subscriptionFor(database,scope.accountId);
  const access=operationalAccess(subscription,input.occurredAt?new Date(input.occurredAt):new Date());
  if(subscription&&!access.canOperate)throw new EntitlementError('This subscription is currently read-only. No billable processing was performed.',
    {meter:input.meter,subscriptionStatus:subscription.status});
  const state = await meterState(database,scope,input.meter,{now:input.occurredAt});
  const units = Math.max(1,Math.round(Number(input.units || 1)));
  if (state.hardLimit !== null && state.used + units > state.hardLimit) {
    throw new EntitlementError(`${state.label} has reached the current plan limit.`, {meter:input.meter,...state});
  }
  const result = await database.query(`INSERT INTO commercial_usage_events
    (id,account_id,workspace_id,meter,units,idempotency_key,occurred_at,detail)
    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),$8::jsonb)
    ON CONFLICT(account_id,meter,idempotency_key) DO NOTHING RETURNING *`,
  [input.id,scope.accountId,scope.workspaceId || null,input.meter,units,input.idempotencyKey,input.occurredAt || null,
    JSON.stringify(input.detail || {})]);
  return {created:Boolean(result.rows.length),event:result.rows[0] || null,state:await meterState(database,scope,input.meter,{now:input.occurredAt})};
}

async function summary(database, scope) {
  const subscription = await subscriptionFor(database,scope.accountId);
  if (!subscription) return {subscription:null,
    access:config.commercial.requirePaidWorkspace?operationalAccess(null):{mode:'DEVELOPMENT',canOperate:true,canRead:true},
    capabilities:[],meters:[]};
  const capabilities = (await database.query(`SELECT capability FROM commercial_plan_entitlements
    WHERE plan_id=$1 AND enabled=1 ORDER BY capability`,[subscription.plan_id])).rows.map((row)=>row.capability);
  const meters = (await database.query('SELECT meter FROM commercial_plan_meters WHERE plan_id=$1 ORDER BY meter',[subscription.plan_id])).rows;
  return {subscription,access:operationalAccess(subscription),capabilities,
    meters:await Promise.all(meters.map((row)=>meterState(database,scope,row.meter,{subscription})))};
}

module.exports = { EntitlementError,subscriptionFor,operationalAccess,capabilityState,assertCapability,meterState,
  ownerScopeForWorkspace,operationalAccessForWorkspace,assertWorkspaceOperational,assertMeterCapacity,recordUsage,summary,periodBounds };
