'use strict';

const { newId } = require('../lib/util');
const { ValidationError } = require('../domain/errors');
const catalog = require('./catalog');
const entitlements = require('../entitlements/postgres-service');

function nonNegativeNumber(value,label){
  // Form fields may be numeric strings. Empty strings, booleans and containers
  // are not rates or measurements: Number(null/''/false/[]) would hide them as 0.
  if((typeof value!=='number'&&typeof value!=='string')||
    (typeof value==='string'&&!value.trim())||!Number.isFinite(Number(value))||Number(value)<0)
    throw new ValidationError(`${label} requires an explicit non-negative number.`);
  return Number(value);
}

async function audit(database,input){
  await database.query(`INSERT INTO commercial_change_audit
    (id,actor_account_id,subject_type,subject_id,action,before_state,after_state,reason,source_ip)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,[newId('comaudit'),input.actorAccountId||null,
    input.subjectType,input.subjectId,input.action,JSON.stringify(input.beforeState??null),JSON.stringify(input.afterState??null),
    input.reason||null,input.sourceIp||null]);
}

async function recordCost(database,scope,input){
  if(scope.accountId)await require('./wallet').assertScope(database,scope);
  if(!input.idempotencyKey)throw new ValidationError('A cost event requires its stable idempotency key.');
  const provider=String(input.provider||'').trim().toLowerCase();
  const operation=String(input.operation||'').trim().toLowerCase();
  const unit=String(input.unit||'operation').trim().toLowerCase();
  const quantity=nonNegativeNumber(input.quantity,'Cost quantity');
  const explicit=input.amountMinor===undefined||input.amountMinor===null?null:nonNegativeNumber(input.amountMinor,'Cost amount');
  if(!provider||!operation||!unit||!Number.isFinite(quantity))throw new ValidationError('Cost events need a provider, operation, unit and quantity.');
  const occurredAt=input.occurredAt||new Date().toISOString();
  const model=String(input.model||input.detail?.model||'');const providerVersion=String(input.providerVersion||'');
  const rate=(await database.query(`SELECT * FROM commercial_cost_rates WHERE provider=$1 AND operation=$2 AND unit=$3
    AND effective_from<=$4::timestamptz AND (effective_until IS NULL OR effective_until>$4::timestamptz)
    AND model=$5 AND provider_version=$6 ORDER BY effective_from DESC LIMIT 1`,[provider,operation,unit,occurredAt,model,providerVersion])).rows[0]||null;
  const amount=explicit===null?(rate?quantity*Number(rate.cost_per_unit_minor):null):explicit;
  if(amount!==null&&(!Number.isFinite(amount)||amount<0))throw new ValidationError('Variable cost must be zero or greater.');
  const result=await database.query(`INSERT INTO commercial_cost_events
    (id,account_id,workspace_id,provider,operation,unit,quantity,amount_minor,currency,idempotency_key,rate_id,detail,occurred_at,model,provider_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::timestamptz,$14,$15)
    ON CONFLICT DO NOTHING RETURNING *`,[input.id||newId('cost'),scope.accountId||null,
    scope.workspaceId||null,provider,operation,unit,quantity,amount,input.currency||rate?.currency||'USD',input.idempotencyKey,
    rate?.id||null,JSON.stringify({...input.detail,costRateMissing:explicit===null&&!rate}),occurredAt,model,providerVersion]);
  if(amount===null)await database.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
    VALUES($1,$2,$3,'MISSING_COST_RATE',$4::jsonb) ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,
    [newId('critical'),scope.accountId||null,`cost-rate:${scope.accountId||'platform'}:${provider}:${operation}:${unit}:${model}:${providerVersion}`,
      JSON.stringify({provider,operation,unit,model,providerVersion,quantity,severity:'CRITICAL'})]);
  return {created:Boolean(result.rows.length),event:result.rows[0]||null,rate};
}

async function saveCostRate(database,input){
  const provider=String(input.provider||'').trim().toLowerCase();
  const operation=String(input.operation||'').trim().toLowerCase();
  const unit=String(input.unit||'').trim().toLowerCase();
  const costPerUnitMinor=nonNegativeNumber(input.costPerUnitMinor,'Cost rate');
  if(!provider||!operation||!unit||!Number.isFinite(costPerUnitMinor)||costPerUnitMinor<0)
    throw new ValidationError('Enter a provider, operation, unit and non-negative cost per unit.');
  const row=(await database.query(`INSERT INTO commercial_cost_rates
    (id,provider,operation,unit,cost_per_unit_minor,currency,effective_from,effective_until,source,created_by_account_id,model,provider_version)
    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,now()),NULLIF($8,'')::timestamptz,$9,$10,$11,$12) RETURNING *`,
  [newId('costrate'),provider,operation,unit,costPerUnitMinor,input.currency||'USD',input.effectiveFrom||null,
    input.effectiveUntil||'',input.source||'ADMIN',input.actorAccountId||null,input.model||'',input.providerVersion||''])).rows[0];
  return row;
}

async function economics(database,scope,options={}){
  const subscription=options.subscription||await entitlements.subscriptionFor(database,scope.accountId);
  if(!subscription)return {subscription:null,revenueMinor:0,overageRevenueMinor:0,estimatedCostMinor:null,contributionMinor:null,
    contributionMarginPercent:null,costCoverage:'NO_SUBSCRIPTION'};
  const bounds=entitlements.periodBounds(subscription,options.now?new Date(options.now):new Date());
  const plan=(await database.query('SELECT * FROM commercial_plans WHERE id=$1',[subscription.plan_id])).rows[0];
  const receipts=(await database.query(`SELECT COALESCE(SUM(amount_minor) FILTER(WHERE kind='SUBSCRIPTION' AND currency=$4),0) AS subscriptions,
    COALESCE(SUM(amount_minor) FILTER(WHERE kind='ADDON' AND currency=$4),0) AS addons,
    COALESCE(SUM(amount_minor) FILTER(WHERE kind IN ('REFUND','DISPUTE','FEE') AND currency=$4),0) AS adjustments,
    COUNT(*) FILTER(WHERE currency<>$4) AS unsupported_currencies
    FROM commercial_revenue_events WHERE account_id=$1 AND occurred_at>=$2 AND occurred_at<$3`,
    [scope.accountId,bounds.start,bounds.end,plan.currency])).rows[0];
  const revenueMinor=Number(receipts.subscriptions);const addonRevenueMinor=Number(receipts.addons);
  const revenueAdjustmentsMinor=Number(receipts.adjustments);
  const overageRevenueMinor=Number((await database.query(`SELECT COALESCE(SUM(amount_minor),0) AS amount
    FROM commercial_overage_charges WHERE account_id=$1 AND period_start=$2 AND period_end=$3 AND status='BILLED'`,
  [scope.accountId,bounds.start.toISOString(),bounds.end.toISOString()])).rows[0].amount);
  // Invoice-backed resource costs cover a service period, not just their ledger
  // posting date. Accrue the immutable account allocation over its exact overlap
  // with the usage period; do not add a second copy of the invoice to the ledger.
  const costs=(await database.query(`SELECT COALESCE(SUM(CASE WHEN statement.id IS NULL THEN cost.amount_minor
      ELSE cost.amount_minor*EXTRACT(EPOCH FROM (LEAST(statement.period_end,$3::timestamptz)
        -GREATEST(statement.period_start,$2::timestamptz)))
        /EXTRACT(EPOCH FROM (statement.period_end-statement.period_start)) END)
      FILTER(WHERE cost.currency=$4),0) AS amount,COUNT(*) AS events,
    COUNT(*) FILTER(WHERE cost.amount_minor IS NULL OR cost.currency<>$4) AS missing_rates
    FROM commercial_cost_events cost LEFT JOIN commercial_provider_cost_statements statement
      ON cost.provider_version='provider-invoice-v1' AND cost.detail->>'statementId'=statement.id
    WHERE cost.account_id=$1 AND ((statement.id IS NULL AND cost.occurred_at>=$2 AND cost.occurred_at<$3)
      OR (statement.id IS NOT NULL AND statement.period_start<$3 AND statement.period_end>$2))`,
  [scope.accountId,bounds.start.toISOString(),bounds.end.toISOString(),plan.currency])).rows[0];
  const criticalWarningCount=Number((await database.query(`SELECT COUNT(*) AS count FROM commercial_critical_warnings
    WHERE status='OPEN' AND (account_id=$1 OR account_id IS NULL)`,[scope.accountId])).rows[0].count);
  const unsupportedRevenueCurrencyCount=Number(receipts.unsupported_currencies);
  const estimatedCostMinor=Number(costs.missing_rates)||criticalWarningCount||unsupportedRevenueCurrencyCount||!Number(costs.events)?null:Number(costs.amount);const totalRevenue=revenueMinor+addonRevenueMinor+revenueAdjustmentsMinor;
  const contributionMinor=estimatedCostMinor===null?null:totalRevenue-estimatedCostMinor;
  return {subscription,periodStart:bounds.start,periodEnd:bounds.end,revenueMinor,overageRevenueMinor:0,addonRevenueMinor,revenueAdjustmentsMinor,estimatedCostMinor,
    contributionMinor,contributionMarginPercent:totalRevenue&&contributionMinor!==null?Math.round(contributionMinor/totalRevenue*10000)/100:null,
    targetContributionMarginPercent:Number(plan.target_contribution_margin_bps||0)/100,costEventCount:Number(costs.events),
    missingCostRateCount:Number(costs.missing_rates),criticalWarningCount,unsupportedRevenueCurrencyCount,accountingBasis:'STRIPE_CASH_RECEIPTS_NOT_ACCRUAL',
    knownCostSubtotalMinor:Number(costs.amount),costPeriodBasis:'DIRECT_EVENT_TIME_AND_PROVIDER_STATEMENT_OVERLAP',
    costCoverage:Number(costs.events)>0&&Number(costs.missing_rates)===0&&criticalWarningCount===0&&unsupportedRevenueCurrencyCount===0?'MEASURED':'MISSING'};
}

async function usageWarnings(database,scope,options={}){
  const summary=options.summary||await entitlements.summary(database,scope);const warnings=[];
  for(const meter of summary.meters){
    if(!meter.definition?.customerVisible||meter.included===null||meter.included<=0)continue;
    const percent=Math.floor((meter.includedUsed??meter.used)/meter.included*100);const threshold=percent>=100?100:percent>=95?95:percent>=80?80:null;
    if(!threshold)continue;
    warnings.push({meter:meter.meter,label:meter.label,percent,threshold,used:meter.used,included:meter.included,
      overageAmountMinor:meter.overageAmountMinor,overageMode:meter.overageMode});
    // Displaying a reservation-inclusive warning must not consume the durable
    // notification key. Only committed usage queues and records notifications.
  }
  return warnings;
}

async function resourceExcess(database,scope,targetPlanId){
  const rows=(await database.query(`SELECT policy.meter,policy.hard_limit FROM commercial_plan_meters policy
    JOIN commercial_meter_definitions definition ON definition.meter=policy.meter
    WHERE policy.plan_id=$1 AND policy.hard_limit IS NOT NULL AND definition.kind='STRUCTURAL'`,
    [targetPlanId])).rows;const excess={};
  for(const row of rows){catalog.assertMeterKey(row.meter);const current=await entitlements.meterState(database,scope,row.meter);
    if(current.used>Number(row.hard_limit))excess[row.meter]={used:current.used,allowed:Number(row.hard_limit),label:current.label};}
  return excess;
}

async function snapshotPlanVersion(database,planId,input={}){
  return (typeof database.transaction==='function'?database.transaction.bind(database):async(operation)=>operation(database))
    (async(client)=>{
      const plan=(await client.query('SELECT * FROM commercial_plans WHERE id=$1 FOR UPDATE',[planId])).rows[0];
      if(!plan)throw new ValidationError('That commercial plan does not exist.');
      const prior=(await client.query(`SELECT * FROM commercial_plan_versions WHERE plan_id=$1 AND status='ACTIVE'
        ORDER BY version_number DESC LIMIT 1 FOR UPDATE`,[planId])).rows[0];
      const entitlements=(await client.query(`SELECT capability,enabled,configuration FROM commercial_plan_entitlements
        WHERE plan_id=$1 ORDER BY capability`,[planId])).rows;
      const meters=(await client.query('SELECT * FROM commercial_plan_meters WHERE plan_id=$1 ORDER BY meter',[planId])).rows;
      const versionNumber=Number(prior?.version_number||0)+1;const at=new Date().toISOString();
      if(prior)await client.query(`UPDATE commercial_plan_versions SET status='RETIRED',effective_until=$2
        WHERE id=$1`,[prior.id,at]);
      const created=(await client.query(`INSERT INTO commercial_plan_versions
        (id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters,effective_from,
         approved_by_account_id) VALUES($1,$2,$3,'ACTIVE',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10) RETURNING *`,
      [newId('planver'),planId,versionNumber,plan.currency,plan.monthly_amount_minor,plan.annual_amount_minor,
        JSON.stringify(entitlements),JSON.stringify(meters),at,input.actorAccountId||null])).rows[0];
      await audit(client,{actorAccountId:input.actorAccountId,subjectType:'plan_version',subjectId:created.id,
        action:'created',beforeState:prior,afterState:created,reason:input.reason,sourceIp:input.sourceIp});
      return created;
    },{isolation:'SERIALIZABLE'});
}

async function portfolioEconomics(database){
  const subscriptions=(await database.query(`SELECT account_id FROM account_subscriptions
    WHERE status IN ('ACTIVE','TRIALING','GRACE','COMP') ORDER BY updated_at DESC LIMIT 250`)).rows;
  const rows=[];for(const subscription of subscriptions)rows.push(await economics(database,{accountId:subscription.account_id,workspaceId:null}));
  return rows.sort((left,right)=>left.contributionMarginPercent-right.contributionMarginPercent);
}

module.exports={audit,recordCost,saveCostRate,economics,usageWarnings,resourceExcess,snapshotPlanVersion,portfolioEconomics};
