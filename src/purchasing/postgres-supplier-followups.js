'use strict';
const {ValidationError}=require('../domain/errors'),autonomy=require('../autopilot/postgres-service'),outbound=require('../connections/postgres-outbound-mail'),permissions=require('../actions/permissions');
const json=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}');}catch{return {};}};
const scoped=c=>({query:(sql,values)=>c.query(sql,values),transaction:f=>f(c)});
async function authority(client,workspaceId,workId,scope){
 const work=(await client.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2',[workspaceId,workId])).rows[0];if(!work)throw new ValidationError('The supplier follow-up work is not in this business.');
 const policy=(await autonomy.listPolicies(client,workspaceId)).find(p=>p.id===scope.policyId),state=await autonomy.getState(client,workspaceId),permission=await autonomy.capabilityMay(client,workspaceId,'supplier_emails');
 const options=policy?.thresholds?.supplierFollowUps;
 if(!state.canAutomate||!permission.allowed||!policy?.active||policy.integrityHash!==scope.policyHash||!options||options.version!==1||!Number.isSafeInteger(options.maximum)||options.maximum<1||options.maximum>5||!Number.isSafeInteger(options.intervalHours)||options.intervalHours<24||options.intervalHours>720)throw new ValidationError('The exact supplier follow-up authority is paused, expired, revoked or outside its approved limits.');
 const order=(await client.query('SELECT id,supplier_id,status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[workspaceId,scope.purchaseOrderId])).rows[0];
 const action=json(work.recommended_action),outcome=json(work.outcome),followUps=outcome.followUps||[];
 if((outcome.purchaseOrderId||action.recordId)!==scope.purchaseOrderId||work.policy_id!==scope.policyId)throw new ValidationError('The follow-up must belong to this exact delegated purchase order and policy.');
 if(!order||!['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(order.status)||!policy.supplierScope.includes(order.supplier_id)||policy.itemScope.length&&!policy.itemScope.includes(action.skuId)||followUps.length>options.maximum||!followUps.some(f=>f.key===scope.key))throw new ValidationError('This supplier follow-up no longer matches the approved order and communication count.');
 const owned=followUps.find(f=>f.key===scope.key);
 if(owned.phase==='supplier_confirmation_due'&&(await client.query("SELECT 1 FROM supplier_documents WHERE workspace_id=$1 AND purchase_order_id=$2 AND document_type='order_acknowledgement' AND status='MATCHED' AND processed_at::timestamptz>$3::timestamptz LIMIT 1",[workspaceId,order.id,owned.at])).rows.length)throw new ValidationError('The supplier has already confirmed this order. The old confirmation request was stopped before sending.');
 const delivery=await autonomy.supplierDeliveryReadiness(client,workspaceId,order.supplier_id);if(!delivery.ready||delivery.mailbox.id!==scope.connectorId||delivery.supplier.email!==scope.recipientEmail)throw new ValidationError('The supplier email or mailbox changed after the follow-up was prepared.');
 return {policy,options};
}
async function prepare(client,workspaceId,work,snapshot,prior,clock){
 if(!['supplier_confirmation_due','supplier_delivery_late'].includes(snapshot.decision?.code))return {snapshot,followUps:prior.followUps||[]};
 const followUps=[...(prior.followUps||[])],last=followUps.at(-1),at=clock.instant;
 const state=await autonomy.getState(client,workspaceId);if(state.paused||state.suspended||state.mode==='OBSERVE')return {snapshot,followUps};
 const po=(await client.query('SELECT p.*,s.name AS supplier_name,s.email,s.watched_connector_id,s.prepare_communications,s.follow_up_days FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id AND s.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=$2',[workspaceId,snapshot.recordId])).rows[0];if(!po||!Number(po.prepare_communications))return {snapshot,followUps};
 const owner=(await client.query("SELECT id FROM users WHERE workspace_id=$1 AND role='owner' ORDER BY created_at,id LIMIT 1",[workspaceId])).rows[0];if(!owner)return {snapshot,followUps};
 const ctx={workspaceId,actorId:owner.id},entitlements=require('../entitlements/postgres-service'),commercialScope=await entitlements.ownerScopeForWorkspace(client,workspaceId);
 if(!(await entitlements.capabilityState(client,commercialScope,'communications.ai_drafts')).enabled)return {snapshot,followUps};
 const policies=await autonomy.listPolicies(client,workspaceId),policy=policies.find(p=>p.active&&p.id===work.policy_id),settings=policy?.thresholds?.supplierFollowUps;
 const options=settings?.version===1?settings:{maximum:1,intervalHours:Math.max(24,Number(po.follow_up_days||2)*24)},maximum=Math.min(5,Math.max(1,Number(options.maximum)||1)),interval=Math.max(24,Number(options.intervalHours)||48)*3600000;
 if(last){
  if(last.effectId){const effect=(await client.query('SELECT status,completed_at FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND id=$2',[workspaceId,last.effectId])).rows[0];
   if(!effect||['FAILED','AMBIGUOUS','CANCELLED'].includes(effect.status))return {snapshot:{...snapshot,nextAction:'Verify the existing supplier follow-up before any resend',decision:{...snapshot.decision,required:'Review the existing provider outcome; StockChief will not resend an uncertain message.'}},followUps};
   if(effect.status!=='SUCCEEDED'||Date.parse(effect.completed_at||last.at)+interval>Date.parse(at))return {snapshot:{...snapshot,phase:'AWAITING_FOLLOW_UP_RESPONSE',nextAction:effect.status==='SUCCEEDED'?'The follow-up was sent; monitor the supplier response.':'Verify the queued follow-up delivery.',decision:null},followUps};
  }else if(last.proposalId){const proposal=(await client.query('SELECT status,result FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[workspaceId,last.proposalId])).rows[0];
   if(proposal?.status==='EXECUTED'&&proposal.result?.effectId){last.effectId=proposal.result.effectId;last.at=at;return {snapshot:{...snapshot,nextAction:'Verify the approved follow-up delivery.',decision:null},followUps};}
   if(proposal?.status==='PENDING')return {snapshot:{...snapshot,reviewHref:'/actions/'+last.proposalId,nextAction:'Review the prepared supplier follow-up'},followUps};
   return {snapshot:{...snapshot,nextAction:'Review the supplier follow-up that was declined or stopped'},followUps};
  }
 }
 if(followUps.length>=maximum)return {snapshot:{...snapshot,nextAction:'Review the supplier after the approved follow-ups were exhausted'},followUps};
 const delivery=await autonomy.supplierDeliveryReadiness(client,workspaceId,po.supplier_id);if(!delivery.ready)return {snapshot:{...snapshot,nextAction:delivery.reason},followUps};
 const lines=(await client.query('SELECT l.quantity_units,l.quantity_received_units,l.supplier_sku,s.code FROM purchase_order_lines l JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.line_number,l.id',[workspaceId,po.id])).rows;
 const late=snapshot.decision.code==='supplier_delivery_late',subject=(late?'Delivery update for ':'Please confirm ')+po.po_number,
 body=[`Hello ${po.supplier_name},`,'',late?`Please confirm the delivery status of ${po.po_number}. Our recorded expected date is ${po.expected_date}.`:`Please confirm acceptance of ${po.po_number} and its expected delivery date.`,...lines.map(l=>`${l.supplier_sku||l.code}: ${l.quantity_units} ordered, ${l.quantity_received_units} received.`),'','Please identify any change to quantities, prices or delivery terms so we can review it.'].join('\n');
 const key='supplier-follow-up:'+work.id+':'+snapshot.decision.code+':'+followUps.length,payload={recipientKind:'supplier',recipientId:po.supplier_id,recipientEmail:delivery.supplier.email,recipientName:po.supplier_name,connectorId:delivery.mailbox.id,mailboxName:delivery.mailbox.display_name,purchaseOrderId:po.id,subject,body};
 const grant=await autonomy.capabilityMay(client,workspaceId,'supplier_emails');
 if(settings?.version===1&&policy?.active&&state.canAutomate&&grant.allowed&&policy.supplierScope.includes(po.supplier_id)){
  const standing={kind:'purchase_followup',workId:work.id,purchaseOrderId:po.id,policyId:policy.id,policyHash:policy.integrityHash,key,connectorId:delivery.mailbox.id,recipientEmail:delivery.supplier.email};
  followUps.push({key,at,phase:snapshot.decision.code});
  await client.query('UPDATE work_items SET outcome=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,work.id,JSON.stringify({...prior,followUps})]);
  await authority(client,workspaceId,work.id,standing);
  const queued=await outbound.queueInTransaction(client,ctx,{...payload,standingAuthority:standing},key);Object.assign(followUps.at(-1),{effectId:queued.effectId,communicationId:queued.communicationId});
  return {snapshot:{...snapshot,phase:'AWAITING_FOLLOW_UP_RESPONSE',nextAction:'Verify the supplier follow-up and monitor its response.',decision:null},followUps};
 }
 const proposal=await require('../assistant/postgres-service').createProposal(scoped(client),{...ctx,planStepKey:key},'Follow up on '+po.po_number,'communication.send_email',payload,`Ask ${po.supplier_name} to ${late?'update delivery':'confirm acceptance and delivery'} for ${po.po_number}. ${snapshot.decision.impact} Send only the reviewed message to ${delivery.supplier.email}.`);
 followUps.push({key,at,phase:snapshot.decision.code,proposalId:proposal.proposal.id});
 return {snapshot:{...snapshot,reviewHref:'/actions/'+proposal.proposal.id,nextAction:'Review the prepared supplier follow-up'},followUps};
}
module.exports={prepare,assertSendAuthority:authority};
