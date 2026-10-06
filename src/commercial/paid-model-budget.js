'use strict';
const {newId}=require('../lib/util');
const {ValidationError}=require('../domain/errors');
const config=require('../config');
const MODEL_VERSION='2023-06-01';
const DEFAULT_MAX_REVENUE_SHARE=.30;
function round(value){return Math.round(Number(value)*1e6)/1e6;}
function effectiveLimit(budget,grant){return round(Number(budget.budget_minor)*
 Math.max(0,Number(grant.units)-Number(grant.revoked_units)-Number(grant.dispute_hold_units))/Number(grant.units));}
function validateEconomics(pack,{requireActiveModel=true}={}){
 if(pack.category!=='ai_work_credits'||Number(pack.version)<2)return;
 const budget=Number(pack.provider_cost_budget_minor),perCredit=Number(pack.conservative_cost_per_credit_minor);
 const share=process.env.STOCKCHIEF_AI_PACK_MAX_PROVIDER_COST_SHARE===undefined?DEFAULT_MAX_REVENUE_SHARE:
  Number(process.env.STOCKCHIEF_AI_PACK_MAX_PROVIDER_COST_SHARE);
 if(!Number.isFinite(share)||share<=0||share>=1)throw new ValidationError('Invalid AI pack provider-cost share configuration.');
 if(!Number.isFinite(budget)||!Number.isFinite(perCredit)||budget<=0||perCredit<=0||
  budget+1e-6<Number(pack.units)*perCredit||budget>Number(pack.amount_minor)*share+1e-6||
  !pack.cost_budget_source||!pack.cost_model_key||!pack.approved_model_rate_ceiling)
  throw new ValidationError('This AI pack is not economically funded and cannot be sold.');
 const ceilings=pack.approved_model_rate_ceiling||{};
 if(!Object.keys(ceilings).length||Object.values(ceilings).some(rates=>
  ['model_input','cache_write_1h','model_output'].some(key=>
   !Number.isFinite(Number(rates?.[key]))||Number(rates[key])<=0)))
  throw new ValidationError('This AI pack has no auditable model-rate ceiling.');
 if(requireActiveModel&&['fast','standard'].some(tier=>
  !ceilings[`${config.ai.provider}/${config.ai.tier(tier).model}/${MODEL_VERSION}`]))
  throw new ValidationError('This AI pack has no approved budget for the active model version.');
}
async function assertSafePack(database,pack){
 validateEconomics(pack);
 if(pack.category!=='ai_work_credits'||Number(pack.version)<2)return;
 for(const tier of ['fast','standard']){
  const model=config.ai.tier(tier).model;const key=`anthropic/${model}/${MODEL_VERSION}`;
  const rows=(await database.query(`SELECT DISTINCT ON (operation) operation,pricing_basis,cost_per_unit_minor FROM commercial_cost_rates
  WHERE provider='anthropic' AND model=$1 AND provider_version=$2 AND unit='token'
  AND operation IN ('model_input','cache_write_1h','model_output')
  AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now())
  ORDER BY operation,effective_from DESC`,
   [model,MODEL_VERSION])).rows;
  if(new Set(rows.filter(row=>['VERIFIED_PUBLIC','VERIFIED_CONTRACT'].includes(row.pricing_basis))
   .map(row=>row.operation)).size!==3)
   throw new ValidationError('This AI pack has an unverified provider/model price and cannot be sold.');
  if(rows.some(row=>Number(row.cost_per_unit_minor)>Number(pack.approved_model_rate_ceiling[key][row.operation])+1e-12))
   throw new ValidationError('This AI pack pricing is unsafe under the current provider rate and cannot be sold.');
 }
}
async function createGrantBudget(client,purchase,grant){
 if(purchase.category!=='ai_work_credits'||purchase.provider_cost_budget_minor===null)return;
 // A price/model change after Checkout must not strand a customer who already
 // paid. The immutable purchase snapshot governs its grant; new sales stop.
 validateEconomics({...purchase,version:2},{requireActiveModel:false});
 await client.query(`INSERT INTO commercial_model_grant_budgets
  (grant_id,purchase_id,account_id,workspace_id,budget_minor,pack_units,purchase_amount_minor,cost_model_key,source,approved_model_rate_ceiling)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(purchase_id) DO NOTHING`,
  [grant.id,purchase.id,purchase.account_id,purchase.workspace_id,purchase.provider_cost_budget_minor,
   purchase.units,purchase.amount_minor,purchase.cost_model_key,purchase.cost_budget_source,
   JSON.stringify(purchase.approved_model_rate_ceiling)]);
 const saved=(await client.query('SELECT * FROM commercial_model_grant_budgets WHERE purchase_id=$1',[purchase.id])).rows[0];
 if(saved?.grant_id!==grant.id||Number(saved?.budget_minor)!==Number(purchase.provider_cost_budget_minor))
  throw new ValidationError('Paid AI grant budget conflicts with its original purchase.');
}
async function reconcileFunding(client,purchase,grant){
 const budget=(await client.query('SELECT * FROM commercial_model_grant_budgets WHERE grant_id=$1',[grant.id])).rows[0];
 if(!budget)return;
 const exposure=(await client.query(`SELECT COALESCE(SUM(CASE WHEN h.status IN ('RESERVED','UNKNOWN') THEN a.maximum_minor
  WHEN h.status='SETTLED' THEN a.actual_minor ELSE 0 END),0) AS amount
  FROM commercial_model_cost_hold_allocations a JOIN commercial_model_cost_holds h ON h.id=a.hold_id
  WHERE a.grant_id=$1`,[grant.id])).rows[0];
 const limit=effectiveLimit(budget,grant);const fingerprint=`paid-ai-unfunded:${purchase.id}`;
 if(Number(exposure.amount)>limit+1e-6)await client.query(`INSERT INTO commercial_critical_warnings
  (id,account_id,fingerprint,code,detail) VALUES($1,$2,$3,'PAID_AI_BUDGET_UNFUNDED_SPEND',$4::jsonb)
  ON CONFLICT(fingerprint) DO UPDATE SET status='OPEN',detail=EXCLUDED.detail`,
  [newId('critical'),purchase.account_id,fingerprint,JSON.stringify({purchaseId:purchase.id,grantId:grant.id,
   exposureMinor:Number(exposure.amount),effectiveBudgetMinor:limit,reason:'refund_or_dispute'})]);
 else await client.query("UPDATE commercial_critical_warnings SET status='RESOLVED' WHERE fingerprint=$1",[fingerprint]);
}
module.exports={assertSafePack,createGrantBudget,reconcileFunding,effectiveLimit,round};
