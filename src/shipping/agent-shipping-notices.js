'use strict';
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const {newId,nowIso,requireText}=require('../lib/util');

async function facts(db,workspaceId,id){
  const {rows:[row]}=await db.query(`SELECT s.id,s.shipment_number,s.sales_order_id,s.tracking_number,s.carrier,s.shipped_at,o.order_number,o.customer_id,
    o.contact_email,c.name customer_name,c.email customer_email,p.shipping_notice,p.connector_id,p.shipping_authorized_by,p.shipping_mailbox_account,p.signature,p.business_name,p.updated_at policy_revision,
    EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=s.workspace_id AND u.id=p.shipping_authorized_by AND u.role='owner') owner_authority
    FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id AND c.record_state='ACTIVE'
    LEFT JOIN customer_communication_policy p ON p.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.id=$2
    AND s.status IN ('SHIPPED','DELIVERED') AND s.shipped_at IS NOT NULL AND s.handover='CARRIER' AND s.tracking_number IS NOT NULL
    AND s.customer_return_id IS NULL AND s.return_outbound_shipment_id IS NULL`,[workspaceId,id]);
  return row;
}
function compose(row){
  const carriers=require('../sales/carriers'),link=carriers.trackingUrlFor(row.carrier,row.tracking_number);
  return {subject:'Shipment '+row.shipment_number+' for order '+row.order_number,
    body:['Hello '+row.customer_name+',','','Shipment '+row.shipment_number+' for order '+row.order_number+' has been handed to the carrier.',
      (row.carrier?carriers.displayName(row.carrier)+' tracking number ':'Tracking number ')+row.tracking_number,link,'',row.signature||row.business_name].filter(x=>x!=null).join('\n')};
}
async function mailbox(db,workspaceId,id){
  return (await db.query(`SELECT id,provider_type,provider_account_id FROM workspace_connectors WHERE workspace_id=$1 AND id=$2 AND status='connected' AND paused_at IS NULL
    AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED' AND provider_type IN ('gmail','microsoft365') AND provider_account_id IS NOT NULL
    AND capabilities::jsonb ?| array['MAIL_SEND','mail:send']`,[workspaceId,id||null])).rows[0];
}
async function authority(db,workspaceId,rule){
  const state=await policy.requireWorkspaceJob(db,workspaceId,60,'draft');
  const cfg=(await db.query('SELECT mode,paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  const stop=await require('../autopilot/job-modes').restriction(db,workspaceId,60,rule.automatic);
  if(state.shadow||cfg?.mode==='OBSERVE'||Number(cfg?.paused)||Number(cfg?.suspended)||stop)
    throw new ValidationError(stop||'Shipping notices are paused or in the initial watch period.');
  if(rule.automatic&&(!policy.permits(state.plan,60,'automatic')||cfg?.mode!=='POLICY_AUTOMATED'))
    throw Object.assign(new ValidationError('Approve this tracking email for this shipment. Automatic notices require Growth or higher and routine work enabled.'),{code:'shipment_needs_approval'});
  const row=await facts(db,workspaceId,rule.shipmentId);
  if(!row||row.shipping_notice==='off'||!row.contact_email||row.contact_email.toLowerCase()!==rule.recipient.toLowerCase()
     ||row.customer_id!==rule.customerId||row.tracking_number!==rule.tracking||row.carrier!==rule.carrier)
    throw new ValidationError('The customer, shipment, tracking or notice setting changed. Review the shipment before sending.');
  const sender=await mailbox(db,workspaceId,rule.connector);
  if(!sender||sender.provider_account_id!==rule.mailboxAccount)throw new ValidationError('Review the sending mailbox and its email permission before sending.');
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[workspaceId,rule.actorId])).rows[0],access=require('../actions/permissions');
  if(!actor||!access.can(actor,access.OPERATE)||await require('../operations/postgres-warehouse-access').scope(db,{workspaceId,actorId:rule.actorId})!==null)
    throw new ValidationError('The person who authorized this shipping notice no longer has access.');
  if(rule.automatic&&(!row.owner_authority||row.shipping_authorized_by!==rule.actorId||row.shipping_notice!=='send'||row.connector_id!==rule.connector
      ||row.policy_revision!==rule.revision||Date.parse(row.policy_revision)>Date.parse(row.shipped_at)||row.shipping_mailbox_account!==rule.mailboxAccount
      ||row.customer_email?.toLowerCase()!==row.contact_email.toLowerCase()))
    throw new ValidationError('The shipping notice needs individual approval under the current customer or mailbox settings.');
}
async function queue(db,ctx,note,row,connector,automatic){
  const rule={kind:'shipment_notice',shipmentId:row.id,customerId:row.customer_id,recipient:note.recipient,tracking:row.tracking_number,
    carrier:row.carrier,connector:connector.id,mailboxAccount:connector.provider_account_id,revision:row.policy_revision,actorId:ctx.actorId,automatic};
  try{await authority(db,ctx.workspaceId,rule);}
  catch(error){if(automatic&&error instanceof ValidationError)return {prepared:note.id,reason:error.message};throw error;}
  const at=nowIso();
  await db.query(`UPDATE customer_communications SET status='QUEUED',connector_id=$3,transport=$4,approved_by_user_id=$5,
    approved_at=$6,queued_at=$6,updated_at=$6 WHERE workspace_id=$1 AND id=$2 AND status='PREPARED'`,[ctx.workspaceId,note.id,connector.id,connector.provider_type,ctx.actorId,at]);
  return require('../operations/postgres-provider-effects').enqueueInTransaction(db,{workspaceId:ctx.workspaceId,kind:'mail.outbound.send',
    provider:connector.provider_type,aggregateType:'customer_communication',aggregateId:note.id,
    idempotencyKey:automatic?note.idempotency_key:note.idempotency_key+':approved:'+note.updated_at,requestedByUserId:ctx.actorId,
    payload:{communicationId:note.id,communicationKind:'customer',connectorId:connector.id,agentJob:60,standingAuthority:rule}});
}
async function processJob(db,job){
  const {workspaceId}=job,row=await facts(db,workspaceId,job.payload.shipmentId);
  const state=await policy.accountState(db,workspaceId);
  if(!row||row.shipping_notice==='off'||!policy.usesAgentTerms(state)||!policy.permits(state.plan,60,'draft'))return {skipped:'Not eligible'};
  const words=compose(row),at=nowIso();
  const {rows:[note]}=await db.query(`INSERT INTO customer_communications(id,workspace_id,customer_id,sales_order_id,shipment_id,recipient,subject,body,
    message_kind,status,connector_id,idempotency_key,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'shipping_notice','PREPARED',$9,$10,$11,$11)
    ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,[newId('shipmentmail'),workspaceId,row.customer_id,row.sales_order_id,row.id,row.contact_email,
    words.subject,words.body,row.connector_id,'shipment:'+row.id+':shipped',at]);
  if(!note)return {replayed:true};
  if(row.shipping_notice==='send'&&row.owner_authority&&note.recipient&&policy.permits(state.plan,60,'automatic')){
    const connector=await mailbox(db,workspaceId,row.connector_id);
    if(connector){
      await queue(db,{workspaceId,actorId:row.shipping_authorized_by},note,row,connector,true);
    }
  }
  return {notice:note.id};
}
async function edit(db,ctx,shipmentId,input){
  return db.transaction(async c=>{
    const user=(await c.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
    require('../actions/permissions').assertCan(user,require('../actions/permissions').OPERATE,'review shipment notices');
    await require('../operations/postgres-warehouse-access').assertInventoryWide(c,ctx);
    await policy.requireWorkspaceJob(c,ctx.workspaceId,60,'draft');
    const row=await facts(c,ctx.workspaceId,shipmentId);
    const {rows:[note]}=await c.query("SELECT * FROM customer_communications WHERE workspace_id=$1 AND shipment_id=$2 AND id=$3 AND message_kind='shipping_notice' FOR UPDATE",[ctx.workspaceId,shipmentId,input.messageId]);
    if(!note||!row||note.status!=='PREPARED'||note.updated_at!==input.version)throw new ValidationError('This shipment notice changed. Open the current notice before editing or sending.');
    if(!['save','rewrite','cancel','send'].includes(input.action))throw new ValidationError('Choose how to handle this notice.');
    const words=input.action==='rewrite'?compose(row):input.action==='cancel'?note:{subject:requireText(input.subject,'Subject',{max:250}),body:requireText(input.body,'Message',{max:20000})};
    const updated=(await c.query(`UPDATE customer_communications SET subject=$3,body=$4,status=$5,recipient=$6,updated_at=$7
      WHERE workspace_id=$1 AND id=$2 RETURNING *`,[ctx.workspaceId,note.id,words.subject,words.body,input.action==='cancel'?'CANCELLED':'PREPARED',row.contact_email,nowIso()])).rows[0];
    if(input.action==='send'){
      if(!note.recipient||note.recipient!==row.contact_email)throw new ValidationError('The recipient changed. Save and review the current address first.');
      const connector=await mailbox(c,ctx.workspaceId,input.connectorId);
      if(!connector)throw new ValidationError('Choose a connected mailbox before sending.');
      await queue(c,ctx,updated,row,connector,false);
    }
    return updated.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={processJob,edit,authority,mailbox};
