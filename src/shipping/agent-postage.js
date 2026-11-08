'use strict';
const plan=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {createHash}=require('node:crypto');
function addressFingerprint(view){
  return createHash('sha256').update(JSON.stringify([view.to,view.from])).digest('hex');
}
async function assertPurchase(db,workspaceId,scope,rate){
  if(!scope)return;
  if(!['automatic','individual'].includes(scope))throw new ValidationError('Review this label individually before purchase.');
  const state=await plan.accountState(db,workspaceId);
  if(!plan.usesAgentTerms(state)||!state.plan)throw new ValidationError('This agent label purchase needs a current Agent plan and approval.');
  const automatic=scope==='automatic';
  plan.requireJob(state.plan,59,automatic?'automatic':'draft');
  const stopped=await plan.stopped(db,workspaceId,state,'shipping.label',automatic);
  if(stopped)throw new ValidationError(stopped);
  if(!automatic||state.plan!=='growth')return;
  const total=Number(rate.amount_minor),breakdown=rate.package_amounts_minor;
  // With no breakdown, a total under the ceiling also bounds every label.
  const covered=Number.isSafeInteger(total)&&total>=0&&(total<=2500||Array.isArray(breakdown)&&breakdown.length>0&&
    breakdown.length===String(rate.provider_rate_id).split(',').length&&breakdown.every(amount=>Number.isSafeInteger(amount)&&amount>=0&&amount<=2500)&&breakdown.reduce((sum,n)=>sum+n,0)===total);
  if(rate.currency!=='USD'||!covered)throw new ValidationError('Growth can buy labels automatically up to $25 USD per label. Individually approve this quote.');
}
async function previousScope(db,workspaceId,effect){
  // Older queued events did not record the approval kind. Use the actual
  // proposal and mission, including orders queued inside an approved batch.
  const {rows:[p]}=await db.query(`SELECT EXISTS(SELECT 1 FROM stockchief_runtime.assistant_capability_plans m WHERE m.workspace_id=p.workspace_id
    AND m.authorization_mode='MISSION' AND m.approval_status='APPROVED' AND m.steps @> jsonb_build_array(jsonb_build_object('proposalId',p.id))) automatic
    FROM stockchief_runtime.assistant_action_proposals p WHERE p.workspace_id=$1 AND p.action_type IN ('shipping.label','shipping.batch_purchase')
    AND (p.idempotency_key=$2 OR EXISTS(SELECT 1 FROM shipping_label_batch_items i JOIN shipping_label_batches b ON b.workspace_id=i.workspace_id AND b.id=i.batch_id
      WHERE i.workspace_id=p.workspace_id AND i.effect_id=$3 AND (b.idempotency_key=p.idempotency_key OR b.idempotency_key=p.payload->>'idempotencyKey'))) LIMIT 1`,[workspaceId,effect.idempotencyKey,effect.id]);
  if(!p||!plan.usesAgentTerms(await plan.accountState(db,workspaceId)))return null;
  return p.automatic?'automatic':'individual';
}
module.exports={addressFingerprint,assertPurchase,previousScope};
