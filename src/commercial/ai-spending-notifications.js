'use strict';
const notifications=require('./notifications'),config=require('../config');
async function check(db,workspaceId){
 const state=await require('./ai-spending-limits').availability(db,workspaceId);if(!state)return {queued:0};
 const owner=(await db.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];let queued=0;
 const creditMode=state.creditsOnly,used=creditMode?state.credits.used+state.credits.reserved:state.accountMinor,capacity=creditMode?state.credits.included:state.accountCapMinor;
 if(!capacity)return {queued:0};
 for(const threshold of [80,100]){if(used<capacity*threshold/100)continue;
  const url=String(config.connections.publicOrigin||'').replace(/\/$/,'')+'/billing',message=creditMode?(used.toLocaleString()+' of '+capacity.toLocaleString()+' included AI credits are used or reserved. '+state.credits.remaining.toLocaleString()+' credits remain available. Ask and AI file reading share this balance.'):('Your configured AI spending protection has reached '+threshold+'%.');
  const result=await notifications.queueAccountEmail(db,{accountId:owner.owner_account_id,idempotencyKey:(creditMode?'ai-credit-warning:':'ai-cost-warning:')+owner.owner_account_id+':'+state.periodEndsAt+':'+capacity+':'+threshold,messageType:'ai_spending_warning',subject:'StockChief AI usage: '+threshold+'% reached',text:()=>message+' Review Plan & Usage: '+url,html:()=>'<p>'+notifications.escapeHtml(message)+'</p><p><a href="'+notifications.escapeHtml(url)+'">Review Plan & Usage</a></p>'});if(result.created)queued++;
 }return {queued};
}
async function sweep(db){const rows=(await db.query(`SELECT DISTINCT ON(w.owner_account_id) w.id FROM workspaces w WHERE EXISTS(SELECT 1 FROM commercial_usage_events e WHERE e.account_id=w.owner_account_id AND e.meter='ai_work_credits' AND e.occurred_at>now()-interval '10 minutes') ORDER BY w.owner_account_id,w.id`)).rows;let queued=0;for(const row of rows)queued+=(await check(db,row.id)).queued;return {queued};}
module.exports={check,sweep};
