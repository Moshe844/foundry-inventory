'use strict';

const {createHash}=require('node:crypto');
const config=require('../config');
const policy=require('../commercial/agent-plan');
const credentials=require('../connections/credentials');
const queue=require('../operations/postgres-job-queue');

async function recipient(database,workspaceId,ids){
  if(!ids.length)return null;
  const row=(await database.query(`SELECT a.id,a.email FROM workspaces w
    JOIN accounts a ON a.id=w.owner_account_id
    JOIN users u ON u.workspace_id=w.id AND u.account_id=a.id AND u.role='owner'
    JOIN notification_email_settings n ON n.workspace_id=w.id AND n.enabled=1
    JOIN workspace_autopilot control ON control.workspace_id=w.id AND control.paused=0 AND control.suspended=0 AND control.mode<>'OBSERVE'
    WHERE w.id=$1 AND w.deletion_requested_at IS NULL AND a.email IS NOT NULL
    AND (jsonb_array_length(n.recipients::jsonb)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(n.recipients::jsonb) r(address) WHERE lower(r.address)=lower(a.email)))
    AND EXISTS(SELECT 1 FROM work_items i WHERE i.workspace_id=w.id AND i.id=ANY($2::text[])
      AND i.source='postgres_autopilot' AND i.category='replenishment_plan'
      AND i.approval_requirement='REQUIRED' AND i.execution_status='WAITING_FOR_APPROVAL'
      AND (n.minimum_severity<>'critical' OR i.urgency='immediate'))`,[workspaceId,ids])).rows[0];
  if(!row)return null;
  const state=await policy.accountState(database,workspaceId);
  return !state.shadow&&policy.usesAgentTerms(state)&&policy.permits(state.plan,175,'draft')?row:null;
}

async function enqueue(database,workspaceId,created){
  if(!config.email.configured||!config.connections.publicOrigin)return;
  const ids=created.filter(i=>i.category==='replenishment_plan'&&i.execution_status==='WAITING_FOR_APPROVAL').map(i=>i.id).sort();
  const owner=await recipient(database,workspaceId,ids);
  if(!owner)return;
  const target=ids.length===1?ids[0]:'inbox';
  const url=new URL('/autopilot/approval-email/'+encodeURIComponent(workspaceId)+'/'+encodeURIComponent(target),config.connections.publicOrigin);
  const label=ids.length===1?'Review purchase order':'Review purchase orders';
  const message={to:owner.email,subject:'StockChief needs your purchase approval',text:label+' in StockChief: '+url.href,
    html:'<p>StockChief has prepared a purchase decision for your review.</p><p><a href="'+require('../commercial/notifications').escapeHtml(url.href)+'">'+label+'</a></p>'};
  await queue.enqueue(database,{workspaceId,kind:'system.email-send',
    idempotencyKey:'purchase-approval:'+createHash('sha256').update(JSON.stringify(ids)).digest('hex'),
    payload:{messageType:'purchase_approval',accountId:owner.id,workIds:ids,sealed:credentials.encrypt(message)},priority:10,maxAttempts:8});
}

async function stillWanted(database,job,address){
  const owner=await recipient(database,job.workspaceId,job.payload.workIds);
  return Boolean(owner&&owner.id===job.payload.accountId&&owner.email===address);
}

module.exports={enqueue,stillWanted};
