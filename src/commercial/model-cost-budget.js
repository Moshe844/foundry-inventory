'use strict';
const {newId}=require('../lib/util');const entitlements=require('./entitlements');
const {ValidationError,RateLimitError}=require('../domain/errors');
const paidBudget=require('./paid-model-budget');
const VERSION={anthropic:'2023-06-01',openai:'responses-2026-10-11'};
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
function estimateMaximumMinor(request,policy,inputRateMinor,outputRateMinor,providerExecutions=MAX_PROVIDER_EXECUTIONS){
 if(!Number.isInteger(providerExecutions)||providerExecutions<1||providerExecutions>MAX_PROVIDER_EXECUTIONS)throw new ValidationError('Invalid trusted provider execution bound.');
 const bytes=Buffer.byteLength(String(request.system||''))+Buffer.byteLength(String(request.prompt||''))+
  Buffer.byteLength(JSON.stringify(request.schema||{}));
 const inputTokens=bytes+INPUT_OVERHEAD_TOKENS;
 const outputTokens=Number.isSafeInteger(request.maxOutputTokens)&&request.maxOutputTokens>0
   ?Math.min(request.maxOutputTokens,policy.maxOutputTokens):policy.maxOutputTokens;
 return {maximumMinor:Math.ceil((inputTokens*inputRateMinor+outputTokens*outputRateMinor)*
  providerExecutions*1e6)/1e6,inputTokens,outputTokens,providerExecutions};}
async function rate(database,provider,model,operation,version){return (await database.query(`SELECT cost_per_unit_minor,
 pricing_basis,confidence,source FROM commercial_cost_rates WHERE provider=$1 AND model=$2 AND provider_version=$3
 AND operation=$4 AND unit='token' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
 ORDER BY effective_from DESC LIMIT 1`,[provider,model,version,operation])).rows[0]||null;}
async function pricedBound(database,provider,request,policy,operation,nativeBound=null){
 const name=String(provider.name||'').toLowerCase();const model=String(provider.model||'');
 // A native host profile may select another verified processing price version.
 // Legacy wrappers keep their original version; no rate can be supplied by a
 // model or inferred from a cheaper tier. Every selected rate is read fresh.
 const version=nativeBound?String(provider.providerVersion||VERSION[name]||''):VERSION[name];
 if(!VERSION[name]||!version||!model)throw new ValidationError('This model has no approved cost-bound pricing version.');
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
 const bound=nativeBound?{
  maximumMinor:Math.ceil((nativeBound.inputTokens*inputRate+nativeBound.outputTokens*outputRate)*1e6)/1e6,
  inputTokens:nativeBound.inputTokens,outputTokens:nativeBound.outputTokens,providerExecutions:1
 }:estimateMaximumMinor(request,policy,inputRate,outputRate,require('./provider-call-contract').executions(provider));
 return {...bound,provider:name,model,providerVersion:version,inputRateMinor:inputRate,rateSources:prices.map(row=>row.source)};}
async function promptByteAllowance(database,provider,request,operation='ask'){
 const policy=require('./model').POLICIES[operation];
 const empty=await pricedBound(database,provider,{...request,prompt:''},policy,operation);
 return Math.max(0,Math.floor((operationLimit(operation)*100-empty.maximumMinor)/
  (empty.inputRateMinor*empty.providerExecutions)));
}
async function nativeInputTokenAllowance(database,provider,outputTokens,operation='ask'){
 const empty=await pricedBound(database,provider,{},require('./model').POLICIES[operation],operation,{inputTokens:0,outputTokens});
 return Math.max(0,Math.floor((operationLimit(operation)*100-empty.maximumMinor)/empty.inputRateMinor));
}
async function reserve(database,scope,provider,request,policy,operation,idempotencyKey,fundingUsageKey=idempotencyKey,goalScope={}){
 const bound=await pricedBound(database,provider,request,policy,operation);
 return reserveBound(database,scope,bound,operation,idempotencyKey,fundingUsageKey,goalScope);
}
// A trusted transport reserves each actual SDK HTTP request separately, including
// retries. Unregistered complete() transports retain the conservative
// three-execution allowance; verified commercial transports can reserve one.
// Token bounds come from the validated native wire protocol, never model text.
async function reserveNative(database,scope,provider,{inputTokens,outputTokens},operation,idempotencyKey,fundingUsageKey,goalScope={}){
 if(!Number.isSafeInteger(inputTokens)||inputTokens<1||inputTokens>1100000||
   !Number.isSafeInteger(outputTokens)||outputTokens<1||outputTokens>3000)
   throw new ValidationError('Invalid native model request bound.');
 const policy=require('./model').POLICIES[operation];if(!policy)throw new ValidationError('Unregistered model operation.');
 const bound=await pricedBound(database,provider,{},policy,operation,{inputTokens,outputTokens});
 return reserveBound(database,scope,bound,operation,idempotencyKey,fundingUsageKey,goalScope,true);
}
async function reserveBound(database,scope,bound,operation,idempotencyKey,fundingUsageKey,goalScope,nativeTransport=false){
 const operationCap=operationLimit(operation)*100;
 if(bound.maximumMinor>operationCap)throw Object.assign(new RateLimitError(
  'This request exceeds the approved per-operation model-cost bound. Shorten its context or use a smaller batch; no model call was made.'),{limitKind:'operation_cost'});
 // A native relay may pass the subscription checked at this same HTTP
 // admission. No snapshot is retained for a later request or resumption.
 const subscription=goalScope.subscription||await entitlements.subscriptionFor(database,scope.accountId);
 const plan=subscription?.plan_id||'starter';const normalAccountCap=periodLimit(plan)*100;
 const normalWorkspaceCap=configuredUsd('STOCKCHIEF_AI_WORKSPACE_PERIOD_COST_CAP_USD',normalAccountCap/100)*100;
 const bounds=entitlements.periodBounds(subscription);
 const transaction=async client=>{
  let accountCap=normalAccountCap,workspaceCap=normalWorkspaceCap,temporaryCostApproval=null,temporaryGoalApproval=null;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
   [`commercial-model-cost:${scope.accountId}:${bounds.start.toISOString()}`]);
  const ownerLimits=await require('./ai-spending-limits').effective(client,scope.accountId,bounds,{accountCapMinor:accountCap,workspaceCapMinor:workspaceCap},scope.workspaceId);accountCap=ownerLimits.accountCapMinor;workspaceCap=ownerLimits.workspaceCapMinor;
  if(goalScope.goalId){
   // The account-period lock is already held. Read the goal and its exposure
   // in the same serializable snapshot, preserving the goal row lock without
   // another network round trip for an independently changing balance.
   const goal=(await client.query(`SELECT g.budget_minor,g.status,g.expires_at,g.checkpoint->>'runtime' AS runtime,
    (SELECT COALESCE(SUM(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN h.maximum_minor
      WHEN h.status='SETTLED' THEN h.actual_minor ELSE 0 END),0)
      FROM commercial_model_cost_holds h WHERE h.goal_id=g.id) AS exposure
    FROM stockchief_runtime.assistant_goals g
    WHERE g.id=$1 AND g.workspace_id=$2 AND g.actor_user_id=$3 FOR UPDATE OF g`,
    [goalScope.goalId,scope.workspaceId,goalScope.actorId])).rows[0];
   if(!goal||['CANCELLED','COMPLETED','BLOCKED'].includes(goal.status)||new Date(goal.expires_at)<=new Date())
    throw new ValidationError('This goal is no longer authorized to use a model.');
   const goalLimit=await require('./staging-native-goal-cost-approval').effective(client,scope,
    {id:goalScope.goalId,actorId:goalScope.actorId,runtime:goal.runtime,budgetMinor:goal.budget_minor},{nativeTransport});
   temporaryGoalApproval=goalLimit.approval;
   if(Number(goal.exposure)+bound.maximumMinor>goalLimit.maximumMinor)
    throw Object.assign(new RateLimitError('This goal reached its cumulative model-cost ceiling. No model call was made.'),{limitKind:'goal_cost'});
   if(nativeTransport&&process.env.STOCKCHIEF_STAGING_NATIVE_COST_APPROVALS){
    const funding=(await client.query(`SELECT funding_workspace_id,pilot FROM stockchief_runtime.codex_pilot_workspace_access
     WHERE workspace_id=$1 AND owner_account_id=$2`,[scope.workspaceId,scope.accountId])).rows[0],pilot=funding?.pilot;
    temporaryCostApproval=require('./staging-native-cost-approval').approved({accountId:scope.accountId,
     fundingWorkspaceId:funding?.funding_workspace_id,nativeTransport:true,goalRuntime:goal.runtime,
     fundingActive:Boolean(pilot?.enabled&&!pilot.stopped&&Date.parse(pilot.period_ends_at)>Date.now())});
    if(temporaryCostApproval){accountCap=Math.max(accountCap,temporaryCostApproval.maximumMinor);workspaceCap=Math.max(workspaceCap,temporaryCostApproval.maximumMinor);}
   }
  }
  const fundedRequest=(await client.query(`SELECT e.id,ARRAY(
    SELECT DISTINCT a.grant_id FROM commercial_usage_allocations a
    WHERE a.event_id=e.id AND a.grant_id IS NOT NULL) AS grant_ids
    FROM commercial_usage_events e WHERE e.account_id=$1 AND e.workspace_id=$2
      AND e.meter='ai_work_credits' AND e.idempotency_key=$3 AND e.status IN ('RESERVED','COMMITTED')`,
   [scope.accountId,scope.workspaceId,fundingUsageKey])).rows[0];
  const grantIds=fundedRequest?.grant_ids||[];
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
      AND e.idempotency_key=$3 AND e.status IN ('RESERVED','COMMITTED') ORDER BY a.grant_id NULLS FIRST`,
   [scope.accountId,scope.workspaceId,fundingUsageKey])).rows;
  if(fundingUsageKey!==idempotencyKey&&!fundedRequest)
   throw new ValidationError('This internal model call has no funded Ask request. No provider call was made.');
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
  if(baseMaximum>0&&Number(current.account_exposure)+baseMaximum>accountCap)
   throw Object.assign(new RateLimitError('AI spending protection has paused included file reading and Ask work for this billing period. Review AI spending in Settings. Your saved file and records remain available; no model call was made.'),{limitKind:'account_period_cost'});
  if(baseMaximum>0&&Number(current.workspace_exposure)+baseMaximum>workspaceCap)
   throw Object.assign(new RateLimitError('AI spending protection has paused included file reading and Ask work for this billing period. Review AI spending in Settings. Your saved file and records remain available; no model call was made.'),{limitKind:'workspace_period_cost'});
  for(const source of sources.filter(row=>row.source==='PURCHASED')){
   const exposure=(await client.query(`SELECT COALESCE(SUM(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor
     WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END),0) AS amount
     FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
     WHERE a.grant_id=$1`,[source.grantId])).rows[0];
   const effective=paidBudget.effectiveLimit({budget_minor:source.budgetMinor},{units:source.grantUnits,
    revoked_units:source.revokedUnits,dispute_hold_units:source.disputeHoldUnits});
   if(Number(exposure.amount)+source.maximumMinor>effective+1e-6)
    throw Object.assign(new RateLimitError('This purchased AI pack reached its provider-cost safety budget. No model call was made.'),{limitKind:'purchased_pack_cost'});
  }
  // Calculations and rounding remain in the canonical engine above. Persist
  // the exact hold and all of its allocations atomically in one statement.
  const hold=(await client.query(`WITH held AS (INSERT INTO commercial_model_cost_holds
   (id,account_id,workspace_id,idempotency_key,period_start,period_end,provider,model,operation,maximum_minor,detail,goal_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12) RETURNING *),
   allocated AS (INSERT INTO commercial_model_cost_hold_allocations(id,hold_id,source,grant_id,maximum_minor)
    SELECT entry.id,held.id,entry.source,entry.grant_id,entry.maximum_minor
    FROM held CROSS JOIN jsonb_to_recordset($13::jsonb)
      AS entry(id text,source text,grant_id text,maximum_minor numeric)
    RETURNING id)
   SELECT held.* FROM held CROSS JOIN (SELECT count(*) FROM allocated) saved`,
   [newId('modelhold'),scope.accountId,scope.workspaceId,idempotencyKey,bounds.start.toISOString(),bounds.end.toISOString(),
    bound.provider,bound.model,operation,bound.maximumMinor,
    JSON.stringify({inputTokenUpperBound:bound.inputTokens,outputTokenLimit:bound.outputTokens,
      providerExecutions:bound.providerExecutions,providerVersion:bound.providerVersion,rateSources:bound.rateSources,
      operationCapMinor:operationCap,accountPeriodCapMinor:accountCap,workspacePeriodCapMinor:workspaceCap,
      ...(temporaryGoalApproval?{temporaryGoalApproval:{approvalReference:temporaryGoalApproval.approvalReference,
       goalId:temporaryGoalApproval.goalId,maximumMinor:temporaryGoalApproval.maximumMinor,expiresAt:temporaryGoalApproval.expiresAt}}:{}),
      ...(temporaryCostApproval?{temporaryCostApproval:{approvalReference:temporaryCostApproval.approvalReference,
       fundingWorkspaceId:temporaryCostApproval.fundingWorkspaceId,maximumMinor:temporaryCostApproval.maximumMinor,expiresAt:temporaryCostApproval.expiresAt}}:{}),
      funding:sources.map(row=>({source:row.source,grantId:row.grantId,maximumMinor:row.maximumMinor}))}),goalScope.goalId||null,
    JSON.stringify(sources.map(source=>({id:newId('modelallocation'),source:source.source,
      grant_id:source.grantId,maximum_minor:source.maximumMinor})))])).rows[0];
 return {...hold,outputTokenLimit:bound.outputTokens};};
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
async function status(database,workspaceId){
 const owner=(await database.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];
 if(!owner)return null;
 const subscription=await entitlements.subscriptionFor(database,owner.owner_account_id),bounds=entitlements.periodBounds(subscription);
 const cap=periodLimit(subscription?.plan_id||'starter')*100,workspaceCap=configuredUsd('STOCKCHIEF_AI_WORKSPACE_PERIOD_COST_CAP_USD',cap/100)*100;
 const row=(await database.query(`SELECT coalesce(sum(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END),0) AS account,
 coalesce(sum(CASE WHEN h.workspace_id=$3 THEN CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END ELSE 0 END),0) AS workspace
 FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
 WHERE h.account_id=$1 AND h.period_start=$2 AND a.source='INCLUDED'`,[owner.owner_account_id,bounds.start.toISOString(),workspaceId])).rows[0];
 const limits=await require('./ai-spending-limits').effective(database,owner.owner_account_id,bounds,{accountCapMinor:cap,workspaceCapMinor:workspaceCap},workspaceId);
 const usage={accountMinor:Number(row.account),workspaceMinor:Number(row.workspace),...limits,
  importRequestCapMinor:operationLimit('import_mapping')*100,periodEndsAt:bounds.end.toISOString()};
 return {...usage,warning:usage.accountMinor>=usage.accountCapMinor*.8||usage.workspaceMinor>=usage.workspaceCapMinor*.8,
  blocked:usage.accountMinor>=usage.accountCapMinor||usage.workspaceMinor>=usage.workspaceCapMinor};
}
module.exports={reserve,reserveNative,release,settle,estimateMaximumMinor,promptByteAllowance,nativeInputTokenAllowance,operationLimit,periodLimit,DEFAULTS,status};
