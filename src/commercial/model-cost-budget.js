'use strict';
const {newId}=require('../lib/util');const entitlements=require('./entitlements');
const {ValidationError,RateLimitError}=require('../domain/errors');
const paidBudget=require('./paid-model-budget');
const VERSION={anthropic:'2023-06-01'};
const DEFAULTS={operation:{ask:.30,instruction:1.50,import_mapping:.30},
 period:{starter:25,growth:75,pro:100,enterprise:250}};
const MAX_PROVIDER_EXECUTIONS=3; // Initial request plus SDK's two transport retries.
const INPUT_OVERHEAD_TOKENS=8192; // Conservative protocol/tool overhead on top of UTF-8 bytes.
function configuredUsd(name,fallback){const raw=process.env[name];const value=raw===undefined?fallback:Number(raw);
 if(!Number.isFinite(value)||value<=0)throw new ValidationError(`${name} must be a positive dollar amount.`);
 return value;}
function operationLimit(operation){return configuredUsd(`STOCKCHIEF_AI_MAX_COST_USD_${operation.toUpperCase()}`,
 DEFAULTS.operation[operation]);}
function periodLimit(plan){return configuredUsd(`STOCKCHIEF_AI_PERIOD_COST_CAP_USD_${String(plan||'').toUpperCase()}`,
 DEFAULTS.period[plan]);}
function estimateMaximumMinor(request,policy,inputRateMinor,outputRateMinor){
 const bytes=Buffer.byteLength(String(request.system||''))+Buffer.byteLength(String(request.prompt||''))+
  Buffer.byteLength(JSON.stringify(request.schema||{}));
 const inputTokens=bytes+INPUT_OVERHEAD_TOKENS;
 return {maximumMinor:Math.ceil((inputTokens*inputRateMinor+policy.maxOutputTokens*outputRateMinor)*
  MAX_PROVIDER_EXECUTIONS*1e6)/1e6,inputTokens,outputTokens:policy.maxOutputTokens,
  providerExecutions:MAX_PROVIDER_EXECUTIONS};}
async function rate(database,provider,model,operation,version){return (await database.query(`SELECT cost_per_unit_minor,
 pricing_basis,confidence,source FROM commercial_cost_rates WHERE provider=$1 AND model=$2 AND provider_version=$3
 AND operation=$4 AND unit='token' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
 ORDER BY effective_from DESC LIMIT 1`,[provider,model,version,operation])).rows[0]||null;}
async function pricedBound(database,provider,request,policy,operation){
 const name=String(provider.name||'').toLowerCase();const model=String(provider.model||'');const version=VERSION[name];
 if(!version||!model)throw new ValidationError('This model has no approved cost-bound pricing version.');
 const prices=await Promise.all(['model_input','cache_write_1h','model_output']
  .map(operationName=>rate(database,name,model,operationName,version)));
 if(prices.some(row=>!row||!['VERIFIED_PUBLIC','VERIFIED_CONTRACT'].includes(row.pricing_basis))){
  await database.query(`INSERT INTO commercial_critical_warnings(id,fingerprint,code,detail)
   VALUES($1,$2,'UNBOUNDED_MODEL_PRICE',$3::jsonb) ON CONFLICT(fingerprint)
   DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,[newId('critical'),`model-price-bound:${name}:${model}:${version}`,
   JSON.stringify({provider:name,model,version,required:['model_input','cache_write_1h','model_output']})]);
  throw new ValidationError('This model version has no verified price bound. No provider call was made.');}
 const inputRate=Math.max(Number(prices[0].cost_per_unit_minor),Number(prices[1].cost_per_unit_minor));
 const outputRate=Number(prices[2].cost_per_unit_minor);
 const bound=estimateMaximumMinor(request,policy,inputRate,outputRate);
 return {...bound,provider:name,model,providerVersion:version,rateSources:prices.map(row=>row.source)};}
async function reserve(database,scope,provider,request,policy,operation,idempotencyKey){
 const bound=await pricedBound(database,provider,request,policy,operation);
 const operationCap=operationLimit(operation)*100;
 if(bound.maximumMinor>operationCap)throw new RateLimitError(
  'This request exceeds the approved per-operation model-cost bound. Shorten its context or use a smaller batch; no model call was made.');
 const subscription=await entitlements.subscriptionFor(database,scope.accountId);
 const plan=subscription?.plan_id||'starter';const accountCap=periodLimit(plan)*100;
 const workspaceCap=configuredUsd('STOCKCHIEF_AI_WORKSPACE_PERIOD_COST_CAP_USD',accountCap/100)*100;
 const bounds=entitlements.periodBounds(subscription);
 const transaction=async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
   [`commercial-model-cost:${scope.accountId}:${bounds.start.toISOString()}`]);
  const grantIds=(await client.query(`SELECT DISTINCT a.grant_id FROM commercial_usage_events e
    JOIN commercial_usage_allocations a ON a.event_id=e.id WHERE e.account_id=$1 AND e.workspace_id=$2
    AND e.meter='ai_work_credits' AND e.idempotency_key=$3 AND e.status='RESERVED' AND a.grant_id IS NOT NULL`,
   [scope.accountId,scope.workspaceId,idempotencyKey])).rows.map(row=>row.grant_id);
  if(grantIds.length)await client.query('SELECT id FROM commercial_usage_grants WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[grantIds]);
  const usage=(await client.query(`SELECT a.grant_id,a.units,k.version AS pack_version,b.budget_minor,b.cost_model_key,
    b.approved_model_rate_ceiling,
    g.revoked_units,g.dispute_hold_units,g.units AS grant_units,b.account_id AS budget_account_id,
    b.workspace_id AS budget_workspace_id
    FROM commercial_usage_events e JOIN commercial_usage_allocations a ON a.event_id=e.id
    LEFT JOIN commercial_usage_grants g ON g.id=a.grant_id
    LEFT JOIN commercial_usage_purchases p ON p.id=g.purchase_id
    LEFT JOIN commercial_usage_packs k ON k.id=p.pack_id
    LEFT JOIN commercial_model_grant_budgets b ON b.grant_id=g.id
    WHERE e.account_id=$1 AND e.workspace_id=$2 AND e.meter='ai_work_credits'
      AND e.idempotency_key=$3 AND e.status='RESERVED' ORDER BY a.grant_id NULLS FIRST`,
   [scope.accountId,scope.workspaceId,idempotencyKey])).rows;
  const totalUnits=usage.reduce((sum,row)=>sum+Number(row.units),0);
  if(usage.some(row=>row.grant_id&&Number(row.pack_version)>=2&&!row.budget_minor))
   throw new RateLimitError('Purchased AI funding is not reconciled. No model call was made.');
  const funded=usage.filter(row=>row.grant_id&&row.budget_minor);
  if(funded.some(row=>row.budget_account_id!==scope.accountId||row.budget_workspace_id!==scope.workspaceId))
   throw new ValidationError('The purchased AI budget belongs to another inventory.');
  for(const row of funded.filter(row=>!row.approved_model_rate_ceiling?.[`${bound.provider}/${bound.model}/${bound.providerVersion}`]))
   await client.query(`INSERT INTO commercial_critical_warnings(id,account_id,fingerprint,code,detail)
    VALUES($1,$2,$3,'PAID_AI_MODEL_CHANGED',$4::jsonb) ON CONFLICT(fingerprint)
    DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,[newId('critical'),scope.accountId,
     `paid-ai-model-changed:${row.grant_id}`,JSON.stringify({grantId:row.grant_id,
      purchasedFor:row.cost_model_key,executingWith:`${bound.provider}/${bound.model}/${bound.providerVersion}`,
      action:'Existing grant remains dollar-bounded; review usability before selling new packs.'})]);
  const fundedUnits=funded.reduce((sum,row)=>sum+Number(row.units),0);
  const sources=[];const baseUnits=totalUnits?totalUnits-fundedUnits:1;
  if(baseUnits>0)sources.push({source:'INCLUDED',grantId:null,units:baseUnits});
  for(const row of funded)sources.push({source:'PURCHASED',grantId:row.grant_id,units:Number(row.units),
   budgetMinor:Number(row.budget_minor),grantUnits:Number(row.grant_units),
   revokedUnits:Number(row.revoked_units),disputeHoldUnits:Number(row.dispute_hold_units)});
  let assigned=0;for(let i=0;i<sources.length;i++){
   sources[i].maximumMinor=i===sources.length-1?paidBudget.round(bound.maximumMinor-assigned):
    paidBudget.round(bound.maximumMinor*sources[i].units/(totalUnits||1));
   assigned+=sources[i].maximumMinor;
  }
  const current=(await client.query(`SELECT
    COALESCE(SUM(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor
      WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END),0) AS account_exposure,
    COALESCE(SUM(CASE WHEN h.workspace_id=$3 THEN CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor
      WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END ELSE 0 END),0) AS workspace_exposure
    FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
    WHERE h.account_id=$1 AND h.period_start=$2 AND a.source='INCLUDED'`,
   [scope.accountId,bounds.start.toISOString(),scope.workspaceId])).rows[0];
  const baseMaximum=sources.filter(row=>row.source==='INCLUDED').reduce((sum,row)=>sum+row.maximumMinor,0);
  if(Number(current.account_exposure)+baseMaximum>accountCap||
    Number(current.workspace_exposure)+baseMaximum>workspaceCap)
   throw new RateLimitError('This inventory reached its billing-period model-cost safety ceiling. No model call was made.');
  for(const source of sources.filter(row=>row.source==='PURCHASED')){
   const exposure=(await client.query(`SELECT COALESCE(SUM(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor
     WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END),0) AS amount
     FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
     WHERE a.grant_id=$1`,[source.grantId])).rows[0];
   const effective=paidBudget.effectiveLimit({budget_minor:source.budgetMinor},{units:source.grantUnits,
    revoked_units:source.revokedUnits,dispute_hold_units:source.disputeHoldUnits});
   if(Number(exposure.amount)+source.maximumMinor>effective+1e-6)
    throw new RateLimitError('This purchased AI pack reached its provider-cost safety budget. No model call was made.');
  }
  const hold=(await client.query(`INSERT INTO commercial_model_cost_holds
   (id,account_id,workspace_id,idempotency_key,period_start,period_end,provider,model,operation,maximum_minor,detail)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) RETURNING *`,
   [newId('modelhold'),scope.accountId,scope.workspaceId,idempotencyKey,bounds.start.toISOString(),bounds.end.toISOString(),
    bound.provider,bound.model,operation,bound.maximumMinor,
    JSON.stringify({inputTokenUpperBound:bound.inputTokens,outputTokenLimit:bound.outputTokens,
      providerExecutions:bound.providerExecutions,providerVersion:bound.providerVersion,rateSources:bound.rateSources,
      operationCapMinor:operationCap,accountPeriodCapMinor:accountCap,workspacePeriodCapMinor:workspaceCap,
      funding:sources.map(row=>({source:row.source,grantId:row.grantId,maximumMinor:row.maximumMinor}))})])).rows[0];
  for(const source of sources)await client.query(`INSERT INTO commercial_model_cost_hold_allocations
   (id,hold_id,source,grant_id,maximum_minor) VALUES($1,$2,$3,$4,$5)`,
   [newId('modelallocation'),hold.id,source.source,source.grantId,source.maximumMinor]);
  return hold;};
 return typeof database.transaction==='function'?database.transaction(transaction,{isolation:'SERIALIZABLE',retrySafe:true}):transaction(database);
}
async function release(database,scope,idempotencyKey){await database.query(`UPDATE commercial_model_cost_holds SET status='RELEASED',settled_at=now()
 WHERE account_id=$1 AND workspace_id=$2 AND idempotency_key=$3 AND status='RESERVED'`,
 [scope.accountId,scope.workspaceId,idempotencyKey]);}
async function settle(database,scope,idempotencyKey,{failed=false}={}){
 const rows=(await database.query(`SELECT amount_minor FROM commercial_cost_events WHERE account_id=$1 AND workspace_id=$2
 AND left(idempotency_key,length($3))=$3`,[scope.accountId,scope.workspaceId,`${idempotencyKey}:`])).rows;
 const known=rows.length>0&&rows.every(row=>row.amount_minor!==null);
 const actual=known?rows.reduce((sum,row)=>sum+Number(row.amount_minor),0):null;
 const update=async client=>{const row=(await client.query(`UPDATE commercial_model_cost_holds SET status=$4,actual_minor=$5,settled_at=now(),
 detail=detail||$6::jsonb WHERE account_id=$1 AND workspace_id=$2 AND idempotency_key=$3
 AND status IN ('RESERVED','UNKNOWN') RETURNING maximum_minor`,
 [scope.accountId,scope.workspaceId,idempotencyKey,known?'SETTLED':'UNKNOWN',actual,
  JSON.stringify({recordedCostEventCount:rows.length,actualCostVerified:known,
    customerCreditsConsumed:!failed})])).rows[0];
 if(!row)return null;
 if(known){const allocations=(await client.query(`SELECT a.id,a.maximum_minor FROM commercial_model_cost_hold_allocations a
  JOIN commercial_model_cost_holds h ON h.id=a.hold_id WHERE h.account_id=$1 AND h.workspace_id=$2
  AND h.idempotency_key=$3 ORDER BY a.id`,[scope.accountId,scope.workspaceId,idempotencyKey])).rows;
  let assigned=0;for(let i=0;i<allocations.length;i++){
   const portion=i===allocations.length-1?paidBudget.round(actual-assigned):
    paidBudget.round(actual*Number(allocations[i].maximum_minor)/Number(row.maximum_minor));
   assigned+=portion;await client.query('UPDATE commercial_model_cost_hold_allocations SET actual_minor=$2 WHERE id=$1',
    [allocations[i].id,portion]);
  }
 }
 return row;};
 const row=typeof database.transaction==='function'?await database.transaction(update,{isolation:'SERIALIZABLE',retrySafe:true}):await update(database);
 if(!row)return {known,actualMinor:actual,replayed:true};
 if(!known||actual>Number(row.maximum_minor))await database.query(`INSERT INTO commercial_critical_warnings
  (id,account_id,fingerprint,code,detail) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(fingerprint)
  DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,[newId('critical'),scope.accountId,
   `model-cost-bound:${scope.accountId}:${idempotencyKey}`,known?'MODEL_COST_BOUND_EXCEEDED':'UNVERIFIED_MODEL_COST',
   JSON.stringify({idempotencyKey,actualMinor:actual,maximumMinor:Number(row.maximum_minor),costEventCount:rows.length})]);
 if(failed&&known&&actual>0){
  const threshold=configuredUsd('STOCKCHIEF_AI_FAILED_COST_ALERT_USD',.25)*100;
  const today=(await database.query(`SELECT COALESCE(SUM(actual_minor),0) AS cost_minor,
    COUNT(*) AS failed_attempts FROM commercial_model_cost_holds WHERE account_id=$1
    AND settled_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    AND status='SETTLED' AND detail->>'customerCreditsConsumed'='false'`,[scope.accountId])).rows[0];
  if(Number(today.cost_minor)>=threshold)await database.query(`INSERT INTO commercial_critical_warnings
    (id,account_id,fingerprint,code,detail) VALUES($1,$2,$3,'FAILED_AI_PROVIDER_SPEND',$4::jsonb)
    ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,
   [newId('critical'),scope.accountId,`failed-ai-cost:${scope.accountId}:${new Date().toISOString().slice(0,10)}`,
    JSON.stringify({failedAttempts:Number(today.failed_attempts),actualCostMinor:Number(today.cost_minor),
      alertThresholdMinor:threshold,customerCreditsConsumed:0})]);
 }
 return {known,actualMinor:actual,maximumMinor:Number(row.maximum_minor)};
}
module.exports={reserve,release,settle,estimateMaximumMinor,operationLimit,periodLimit,DEFAULTS};
