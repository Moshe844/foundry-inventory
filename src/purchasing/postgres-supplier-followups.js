'use strict';
const {ValidationError}=require('../domain/errors'),autonomy=require('../autopilot/postgres-service'),outbound=require('../connections/postgres-outbound-mail'),permissions=require('../actions/permissions');
const json=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value||'{}');}catch{return {};}};
const agent=require('../commercial/agent-plan');
const chases=require('./agent-supplier-delivery-chases');
const confirmations=require('./agent-supplier-ship-promises');
const {hash}=require('../pricing/postgres-promotions');
const followUpJob=phase=>phase==='supplier_delivery_late'?30:29;
const scoped=c=>({query:(sql,values)=>c.query(sql,values),transaction:f=>f(c)});

async function manualApproval(client,workspaceId,scope,owned){
 const accepted=(await client.query(`SELECT p.payload,p.result,p.actor_user_id FROM stockchief_runtime.assistant_action_proposals p
  JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.actor_user_id AND u.role='owner'
  JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id AND w.deletion_requested_at IS NULL
  WHERE p.workspace_id=$1 AND p.id=$2 AND p.action_type='communication.send_email' AND p.status='EXECUTED'
   AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,
 [workspaceId,owned.proposalId])).rows[0];
 const payload=accepted&&json(accepted.payload),result=accepted&&json(accepted.result);
 if(!accepted||accepted.actor_user_id!==scope.actorId||!payload.standingAuthority||hash(payload.standingAuthority)!==hash(scope)||!result.communicationId)
  throw new ValidationError('Review and approve the exact current supplier reminder before sending.');
 const message=(await client.query('SELECT * FROM supplier_communications WHERE workspace_id=$1 AND id=$2 AND purchase_order_id=$3',
  [workspaceId,result.communicationId,scope.purchaseOrderId])).rows[0];
 if(!message||message.subject!==payload.subject||message.recipient!==scope.recipientEmail||message.connector_id!==scope.connectorId||
  !await outbound.approvedBodyMatches(client,{workspaceId},message,payload))throw new ValidationError('The approved reminder text or recipient changed.');
}

async function authority(client,workspaceId,workId,scope){
 const work=(await client.query('SELECT * FROM work_items WHERE workspace_id=$1 AND id=$2',[workspaceId,workId])).rows[0];if(!work)throw new ValidationError('The supplier follow-up work is not in this business.');
 const order=(await client.query(`SELECT id,supplier_id,status,ordered_at,coalesce(to_jsonb(p)->>'delivery_kind','WAREHOUSE') AS delivery_kind
   FROM purchase_orders p WHERE workspace_id=$1 AND id=$2`,[workspaceId,scope.purchaseOrderId])).rows[0];
 const action=json(work.recommended_action),outcome=json(work.outcome),followUps=outcome.followUps||[];
 const owned=followUps.find(f=>f.key===scope.key);
 if((outcome.purchaseOrderId||action.recordId)!==scope.purchaseOrderId||!owned||!order||!['APPROVED','ORDERED','PARTIALLY_RECEIVED'].includes(order.status))
  throw new ValidationError('The follow-up no longer matches this exact placed purchase and saved communication.');
 let options,policy,delivery;
 if(scope.manual){
  await manualApproval(client,workspaceId,scope,owned);
  delivery=scope.mailboxAccount?await chases.contact(client,workspaceId,order.supplier_id,scope.connectorId):
   await autonomy.supplierDeliveryReadiness(client,workspaceId,order.supplier_id);
  if(scope.mailboxAccount&&delivery.mailbox?.provider_account_id!==scope.mailboxAccount)
   throw new ValidationError('The authorized sending mailbox changed. Review the exact reminder again.');
 }else if(scope.ruleId){
  if(owned.ruleId!==scope.ruleId)throw new ValidationError('The saved supplier rule changed. Review the exact follow-up.');
  ({options,delivery}=owned.phase===confirmations.phase?await confirmations.sendAuthority(client,workspaceId,scope,order):
    await chases.authority(client,workspaceId,scope,order));
 }else{
  policy=(await autonomy.listPolicies(client,workspaceId)).find(p=>p.id===scope.policyId);
  const permission=await autonomy.capabilityMay(client,workspaceId,'supplier_emails');
  options=policy?.thresholds?.supplierFollowUps;
  if(!permission.allowed||!policy?.active||work.policy_id!==scope.policyId||policy.integrityHash!==scope.policyHash||!options||options.version!==1||
    !Number.isSafeInteger(options.maximum)||options.maximum<1||options.maximum>5||!Number.isSafeInteger(options.intervalHours)||options.intervalHours<24||options.intervalHours>720||
    !policy.supplierScope.includes(order.supplier_id)||policy.itemScope.length&&!policy.itemScope.includes(action.skuId))
   throw new ValidationError('The exact supplier follow-up authority is paused, expired, revoked or outside its approved limits.');
  delivery=await autonomy.supplierDeliveryReadiness(client,workspaceId,order.supplier_id);
 }
 if(!scope.manual){
  const state=await autonomy.getState(client,workspaceId);
  if(!state.canAutomate)throw new ValidationError('The exact supplier follow-up authority is paused or unavailable.');
  const communicationCount=scope.ruleId?followUps.filter(f=>f.phase===owned.phase).length:followUps.length;
  if(communicationCount>options.maximum)throw new ValidationError('This supplier follow-up exceeds the authorized communication count.');
 }
 const account=await agent.accountState(client,workspaceId);
 if(agent.usesAgentTerms(account))agent.requireJob(account.plan,followUpJob(owned.phase),scope.manual?'draft':'automatic',
   {trained:owned.phase!==confirmations.phase||Boolean(scope.ruleId)});
 if(agent.usesAgentTerms(account)){const stop=await agent.stopped(client,workspaceId,account,'communication.send_email',!scope.manual,{recipientKind:'supplier',purchaseOrderId:scope.purchaseOrderId,followUpPhase:owned.phase});if(stop)throw new ValidationError(stop);}
 const clock=await require('../lib/business-time').forWorkspace(client,workspaceId);
 const current=await require('../operations/postgres-workflow-ownership').purchaseSnapshot(client,workspaceId,order.id,outcome,clock);
 if(current.decision?.code!==owned.phase||owned.sourceHash&&owned.sourceHash!==current.followUpSourceHash)
  throw new ValidationError('The delivery date, receipt or supplier evidence changed after this message was prepared. Review the current order.');
 if(!delivery.ready||delivery.mailbox.id!==scope.connectorId||delivery.supplier.email!==scope.recipientEmail)throw new ValidationError('The supplier email or mailbox changed after the follow-up was prepared.');
 if(owned.messageHash){
  const message=(await client.query('SELECT subject,body FROM supplier_communications WHERE workspace_id=$1 AND id=$2 AND purchase_order_id=$3',
   [workspaceId,owned.communicationId,order.id])).rows[0];
  if(!message||hash(message)!==owned.messageHash)throw new ValidationError('The queued reminder text changed. Review the exact supplier message before sending.');
 }
 return {policy,options};
}
async function prepare(client,workspaceId,work,snapshot,prior,clock){
 if(!['supplier_confirmation_due','supplier_delivery_late'].includes(snapshot.decision?.code))return {snapshot,followUps:prior.followUps||[]};
 const followUps=[...(prior.followUps||[])],at=clock.instant;
 const account=await agent.accountState(client,workspaceId);
 if(agent.usesAgentTerms(account)&&!agent.permits(account.plan,followUpJob(snapshot.decision.code),'draft'))return {snapshot,followUps};
 const state=await autonomy.getState(client,workspaceId);if(state.paused||state.suspended||state.mode==='OBSERVE')return {snapshot,followUps};
 const po=(await client.query('SELECT p.*,s.name AS supplier_name,s.email,s.watched_connector_id,s.prepare_communications,s.follow_up_days FROM purchase_orders p JOIN suppliers s ON s.id=p.supplier_id AND s.workspace_id=p.workspace_id WHERE p.workspace_id=$1 AND p.id=$2',[workspaceId,snapshot.recordId])).rows[0];
 if(!po)return {snapshot,followUps};
 const late=snapshot.decision.code===chases.phase;
 const service=late?chases:confirmations;
 const standalone=agent.usesAgentTerms(account)&&po.delivery_kind==='WAREHOUSE'&&po.ordered_at&&['ORDERED','PARTIALLY_RECEIVED'].includes(po.status)
  ?await service.activeRule(client,workspaceId,po.supplier_id):null;
 const applicable=standalone?followUps.filter(f=>f.phase===snapshot.decision.code):followUps,last=applicable.at(-1);
 if(!standalone&&!Number(po.prepare_communications))return {snapshot,followUps};
 const owner=standalone?{id:standalone.authorized_by}:(await client.query("SELECT id FROM users WHERE workspace_id=$1 AND role='owner' ORDER BY created_at,id LIMIT 1",[workspaceId])).rows[0];if(!owner)return {snapshot,followUps};
 const ctx={workspaceId,actorId:owner.id},entitlements=require('../entitlements/postgres-service'),commercialScope=await entitlements.ownerScopeForWorkspace(client,workspaceId);
 if(!(await entitlements.capabilityState(client,commercialScope,'communications.ai_drafts')).enabled)return {snapshot,followUps};
 const policy=standalone?null:(await autonomy.listPolicies(client,workspaceId)).find(p=>p.active&&p.id===work.policy_id);
 const settings=standalone?{version:1,maximum:standalone.maximum_messages,intervalHours:standalone.interval_hours}:policy?.thresholds?.supplierFollowUps;
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
 if(applicable.length>=maximum)return {snapshot:{...snapshot,nextAction:'Review the supplier after the approved follow-ups were exhausted'},followUps};
 const delivery=standalone?await chases.contact(client,workspaceId,po.supplier_id,standalone.connector_id):await autonomy.supplierDeliveryReadiness(client,workspaceId,po.supplier_id);
 if(!delivery.ready)return {snapshot:{...snapshot,nextAction:delivery.reason},followUps};
 if(standalone&&(delivery.supplier.email!==standalone.recipient||delivery.mailbox.provider_account_id!==standalone.mailbox_account))
  return {snapshot:{...snapshot,nextAction:'Review the changed supplier contact or sending mailbox before sending a follow-up.'},followUps};
 const lines=(await client.query('SELECT l.quantity_units,l.quantity_received_units,l.supplier_sku,s.code FROM purchase_order_lines l JOIN skus s ON s.id=l.sku_id AND s.workspace_id=l.workspace_id WHERE l.workspace_id=$1 AND l.purchase_order_id=$2 ORDER BY l.line_number,l.id',[workspaceId,po.id])).rows;
 const subject=(late?'Delivery update for ':'Please confirm ')+po.po_number;
 const request=late?[`Please confirm the delivery status of ${po.po_number}. Our recorded expected date is ${po.expected_date}.`]:[
   `Please confirm acceptance of ${po.po_number}, its planned ship date and expected delivery date.`,
   ...(agent.usesAgentTerms(account)?['Use the private link below, or reply with Confirmed on one line and Planned ship date: YYYY-MM-DD on the next.']:[])];
 const body=[`Hello ${po.supplier_name},`,'',...request,
   ...lines.map(l=>`${l.supplier_sku||l.code}: ${l.quantity_units} ordered, ${l.quantity_received_units} received.`),'',
   'Please identify any change to quantities, prices or delivery terms so we can review it.'].join('\n');
 const key='supplier-follow-up:'+work.id+':'+snapshot.decision.code+':'+followUps.length,payload={recipientKind:'supplier',recipientId:po.supplier_id,recipientEmail:delivery.supplier.email,recipientName:po.supplier_name,connectorId:delivery.mailbox.id,mailboxName:delivery.mailbox.display_name||delivery.mailbox.provider_account_id,purchaseOrderId:po.id,followUpPhase:snapshot.decision.code,subject,body};
 const grant=standalone?{allowed:true}:await autonomy.capabilityMay(client,workspaceId,'supplier_emails');
 const automaticStop=agent.usesAgentTerms(account)?await agent.stopped(client,workspaceId,account,'communication.send_email',true,payload):null;
 const needsTeaching=!late&&account.plan==='growth'&&!standalone;
 if(!automaticStop&&!needsTeaching&&settings?.version===1&&state.canAutomate&&grant.allowed&&(standalone||policy?.active&&policy.supplierScope.includes(po.supplier_id))){
  const scope=standalone?{ruleId:standalone.id,ruleRevision:standalone.revision}:{policyId:policy.id,policyHash:policy.integrityHash};
  const standing={kind:'purchase_followup',workId:work.id,purchaseOrderId:po.id,...scope,key,connectorId:delivery.mailbox.id,recipientEmail:delivery.supplier.email};
  followUps.push({key,at,phase:snapshot.decision.code,...(standalone?{ruleId:standalone.id}:{}),
    ...(snapshot.followUpSourceHash?{sourceHash:snapshot.followUpSourceHash}:{})});
  await client.query('UPDATE work_items SET outcome=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,work.id,JSON.stringify({...prior,followUps})]);
  try{await authority(client,workspaceId,work.id,standing);}
  catch(error){
   if(![400,402,403,404,422].includes(error.status))throw error;
   followUps.pop();
   return {snapshot:{...snapshot,nextAction:error.message},followUps};
  }
  const queued=await outbound.queueInTransaction(client,ctx,{...payload,standingAuthority:standing},key,{agentRequested:true});Object.assign(followUps.at(-1),{effectId:queued.effectId,communicationId:queued.communicationId});
  if(standalone){
   const message=(await client.query('SELECT subject,body FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[workspaceId,queued.communicationId])).rows[0];
   followUps.at(-1).messageHash=hash(message);
  }
  return {snapshot:{...snapshot,phase:'AWAITING_FOLLOW_UP_RESPONSE',nextAction:'Verify the supplier follow-up and monitor its response.',decision:null},followUps};
 }
 const reviewed={...payload,standingAuthority:{kind:'purchase_followup',manual:true,actorId:ctx.actorId,workId:work.id,
   purchaseOrderId:po.id,key,connectorId:delivery.mailbox.id,recipientEmail:delivery.supplier.email,
   ...(standalone?{mailboxAccount:standalone.mailbox_account}:{})}};
 const proposal=await require('../assistant/postgres-service').createProposal(scoped(client),{...ctx,planStepKey:key},'Follow up on '+po.po_number,'communication.send_email',reviewed,`Ask ${po.supplier_name} to ${late?'update delivery':'confirm acceptance and delivery'} for ${po.po_number}. ${snapshot.decision.impact} Send only the reviewed message to ${delivery.supplier.email}.`);
 followUps.push({key,at,phase:snapshot.decision.code,proposalId:proposal.proposal.id,
   ...(snapshot.followUpSourceHash?{sourceHash:snapshot.followUpSourceHash}:{})});
 return {snapshot:{...snapshot,reviewHref:'/actions/'+proposal.proposal.id,nextAction:'Review the prepared supplier follow-up'},followUps};
}
async function assertSendAuthority(...args){
 try{return await authority(...args);}
 catch(error){
  if([400,402,403,404,422].includes(error.status)){
   error.code='supplier_followup_needs_review';
   error.retryable=false;
  }
  throw error;
 }
}
module.exports={prepare,assertSendAuthority};
