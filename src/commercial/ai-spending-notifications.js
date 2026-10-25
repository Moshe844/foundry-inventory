'use strict';
const notifications=require('./notifications'),config=require('../config');
async function check(db,workspaceId){
 const state=await require('./model-cost-budget').status(db,workspaceId);if(!state)return {queued:0};
 const owner=(await db.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];let queued=0;
 for(const threshold of [80,100]){
  if(state.accountMinor<state.accountCapMinor*threshold/100)continue;
  const url=String(config.connections.publicOrigin||'').replace(/\/$/,'')+'/settings#ai-spending',amount='$'+(state.accountMinor/100).toFixed(2),limit='$'+(state.accountCapMinor/100).toFixed(2);
  const result=await notifications.queueAccountEmail(db,{accountId:owner.owner_account_id,idempotencyKey:`ai-cost-warning:${owner.owner_account_id}:${state.periodEndsAt}:${state.accountCapMinor}:${threshold}`,messageType:'ai_spending_warning',subject:`StockChief AI spending limit: ${threshold}% reached`,text:()=>`Account AI cost is ${amount} against your ${limit} limit this billing period. This includes conservative reservations for unverified provider costs. ${threshold===100?'New included AI work pauses at the limit.':'Review your limit before new included AI work pauses.'} Credits and spending limits are separate protections; unused credits remain available. Review or raise your limit: ${url}`,html:()=>`<p>Account AI cost is <strong>${amount}</strong> against your <strong>${limit}</strong> limit this billing period.</p><p>Unverified provider costs retain their conservative reservations. ${threshold===100?'New included AI work pauses at the limit.':'Review your limit before new included AI work pauses.'} Unused credits remain available.</p><p><a href="${notifications.escapeHtml(url)}">Review or raise your AI spending limit</a></p>`});
  if(result.created)queued++;
 }return {queued};
}
async function sweep(db){const rows=(await db.query(`SELECT DISTINCT ON(w.owner_account_id) w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM commercial_model_cost_holds h WHERE h.account_id=w.owner_account_id AND greatest(h.created_at,coalesce(h.settled_at,h.created_at))>now()-interval '10 minutes') OR EXISTS(SELECT 1 FROM commercial_ai_spending_limits l WHERE l.account_id=w.owner_account_id AND l.updated_at>now()-interval '10 minutes') ORDER BY w.owner_account_id,w.id`)).rows;let queued=0;for(const row of rows)queued+=(await check(db,row.id)).queued;return {queued};}
module.exports={check,sweep};
