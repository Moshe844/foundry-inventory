'use strict';
// Job 60: once a parcel has physically left (a person records the carrier
// handoff, or the carrier scans a label bought here as moving), the customer
// is emailed that the order shipped, with the carrier, tracking number and
// link. Starter approves each email with one tap; Growth, Pro and Custom send
// on their own once the owner has chosen "StockChief sends it". Orders from a
// connected sales channel are left to that channel, which sends its own
// shipping email, unless the owner says StockChief tells those customers.
const policy=require('../commercial/agent-plan');
const audit=require('../operations/postgres-security-audit');
const {ValidationError,AuthorizationError}=require('../domain/errors');
const {newId,nowIso,requireText}=require('../lib/util');

const CHANNEL_TYPES=['shopify','woocommerce','bigcommerce','square','clover','reference_webhook'];
const channelTable='stockchief_runtime.agent_shipping_notice_channels';
const installed=db=>require('../db/schema-installed').has(db,channelTable);

async function facts(db,workspaceId,id){
  const {rows:[row]}=await db.query(`SELECT s.id,s.shipment_number,s.sales_order_id,s.tracking_number,s.tracking_url,s.carrier,s.shipped_at,
    COALESCE(s.shipped_at,s.tracked_at) handed_at,s.status,o.order_number,o.customer_id,
    o.contact_email,c.name customer_name,c.email customer_email,p.shipping_notice,p.connector_id,p.shipping_authorized_by,p.shipping_mailbox_account,p.signature,p.business_name,p.updated_at policy_revision,
    EXISTS(SELECT 1 FROM users u WHERE u.workspace_id=s.workspace_id AND u.id=p.shipping_authorized_by AND u.role='owner') owner_authority
    FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
    JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id AND c.record_state='ACTIVE'
    LEFT JOIN customer_communication_policy p ON p.workspace_id=s.workspace_id WHERE s.workspace_id=$1 AND s.id=$2
    AND s.handover='CARRIER' AND s.tracking_number IS NOT NULL AND s.customer_return_id IS NULL AND s.return_outbound_shipment_id IS NULL
    AND ((s.status IN ('SHIPPED','DELIVERED') AND s.shipped_at IS NOT NULL)
      OR (s.status='PACKED' AND s.label_status='PURCHASED' AND s.tracking_status IN ('IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED')))`,[workspaceId,id]);
  if(row)row.channel=await channelFor(db,workspaceId,row.sales_order_id);
  return row;
}

// The connected sales channel an order came from, and who tells its customers.
async function channelFor(db,workspaceId,orderId){
  const row=(await db.query(`SELECT c.id,c.display_name,c.provider_type FROM connection_mappings m
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE m.workspace_id=$1 AND m.entity_type='sales_order' AND m.foundry_record_id=$2 ORDER BY m.created_at,c.id LIMIT 1`,[workspaceId,orderId])).rows[0];
  if(!row)return null;
  const saved=await installed(db)?(await db.query(`SELECT sender FROM ${channelTable} WHERE workspace_id=$1 AND connector_id=$2`,[workspaceId,row.id])).rows[0]:null;
  return {id:row.id,name:row.display_name||require('../web/presentation/connections').name(row),sender:saved?.sender||'channel'};
}
const leftToChannel=row=>row.channel&&row.channel.sender!=='stockchief';

function compose(row){
  const carriers=require('../sales/carriers'),link=row.tracking_url||carriers.trackingUrlFor(row.carrier,row.tracking_number);
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
  if(leftToChannel(row))throw new ValidationError(row.channel.name+' tells its own customers that their order shipped. Change who tells them in Fulfilment settings before sending.');
  const sender=await mailbox(db,workspaceId,rule.connector);
  if(!sender||sender.provider_account_id!==rule.mailboxAccount)throw new ValidationError('Review the sending mailbox and its email permission before sending.');
  const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[workspaceId,rule.actorId])).rows[0],access=require('../actions/permissions');
  if(!actor||!access.can(actor,access.OPERATE)||await require('../operations/postgres-warehouse-access').scope(db,{workspaceId,actorId:rule.actorId})!==null)
    throw new ValidationError('The person who authorized this shipping notice no longer has access.');
  if(rule.automatic&&(!row.owner_authority||row.shipping_authorized_by!==rule.actorId||row.shipping_notice!=='send'||row.connector_id!==rule.connector
      ||row.policy_revision!==rule.revision||Date.parse(row.policy_revision)>Date.parse(row.handed_at)||row.shipping_mailbox_account!==rule.mailboxAccount
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
  const queued=await require('../operations/postgres-provider-effects').enqueueInTransaction(db,{workspaceId:ctx.workspaceId,kind:'mail.outbound.send',
    provider:connector.provider_type,aggregateType:'customer_communication',aggregateId:note.id,
    idempotencyKey:automatic?note.idempotency_key:note.idempotency_key+':approved:'+note.updated_at,requestedByUserId:ctx.actorId,
    payload:{communicationId:note.id,communicationKind:'customer',connectorId:connector.id,agentJob:60,standingAuthority:rule}});
  await audit.record(db,ctx,{action:automatic?'Sent a tracking email on its own':'Approved a tracking email',reference:row.shipment_number,
    before:{status:'PREPARED'},after:{status:'QUEUED',orderNumber:row.order_number,recipient:note.recipient,carrier:row.carrier,trackingNumber:row.tracking_number}});
  return queued;
}
async function processJob(db,job){
  const {workspaceId}=job,row=await facts(db,workspaceId,job.payload.shipmentId);
  const state=await policy.accountState(db,workspaceId);
  if(!row||row.shipping_notice==='off'||!policy.usesAgentTerms(state)||!policy.permits(state.plan,60,'draft'))return {skipped:'Not eligible'};
  // Marketplaces and online stores send their own shipping email; never a second one.
  if(leftToChannel(row))return {skipped:'channel',channel:row.channel.name};
  const words=compose(row),at=nowIso();
  const {rows:[note]}=await db.query(`INSERT INTO customer_communications(id,workspace_id,customer_id,sales_order_id,shipment_id,recipient,subject,body,
    message_kind,status,connector_id,idempotency_key,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'shipping_notice','PREPARED',$9,$10,$11,$11)
    ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING *`,[newId('shipmentmail'),workspaceId,row.customer_id,row.sales_order_id,row.id,row.contact_email,
    words.subject,words.body,row.connector_id,'shipment:'+row.id+':shipped',at]);
  if(!note)return {replayed:true};
  await audit.record(db,{workspaceId},{action:'Prepared a tracking email',reference:row.shipment_number,
    after:{orderNumber:row.order_number,recipient:row.contact_email||null,carrier:row.carrier,trackingNumber:row.tracking_number}});
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
    if(input.action==='cancel')await audit.record(c,ctx,{action:'Decided not to send a tracking email',reference:row.shipment_number,before:{status:'PREPARED'},after:{status:'CANCELLED'}});
    if(input.action==='send'){
      if(!note.recipient||note.recipient!==row.contact_email)throw new ValidationError('The recipient changed. Save and review the current address first.');
      const connector=await mailbox(c,ctx.workspaceId,input.connectorId);
      if(!connector)throw new ValidationError('Choose a connected mailbox before sending.');
      await queue(c,ctx,updated,row,connector,false);
    }
    return updated.id;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Connected sales channels and who tells their customers an order shipped.
async function channels(db,workspaceId){
  const rows=(await db.query(`SELECT id,display_name,provider_type FROM workspace_connectors WHERE workspace_id=$1 AND status='connected'
    AND provider_type=ANY($2::text[]) ORDER BY display_name,id LIMIT 50`,[workspaceId,CHANNEL_TYPES])).rows;
  if(!rows.length)return [];
  const saved=await installed(db)?new Map((await db.query(`SELECT connector_id,sender FROM ${channelTable} WHERE workspace_id=$1`,[workspaceId])).rows.map(r=>[r.connector_id,r.sender])):new Map();
  return rows.map(r=>({id:r.id,name:r.display_name||require('../web/presentation/connections').name(r),sender:saved.get(r.id)||'channel'}));
}
async function saveChannels(db,ctx,choices,user){
  const wanted=Object.entries(choices&&typeof choices==='object'?choices:{});
  if(!wanted.length)return 0;
  return db.transaction(async c=>{
    const known=new Map((await channels(c,ctx.workspaceId)).map(r=>[r.id,r]));let changed=0;
    for(const [id,sender] of wanted){
      const channel=known.get(id);
      if(!channel||!['channel','stockchief'].includes(sender))throw new ValidationError('Choose who tells each connected channel’s customers.');
      if(channel.sender===sender)continue;
      if(sender==='stockchief'&&user?.role!=='owner')throw new AuthorizationError('Only the inventory owner can let StockChief email a channel’s customers.');
      await c.query(`INSERT INTO ${channelTable}(workspace_id,connector_id,sender,updated_by) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,connector_id) DO UPDATE SET sender=EXCLUDED.sender,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[ctx.workspaceId,id,sender,ctx.actorId]);
      await audit.record(c,ctx,{action:'Changed who tells a channel’s customers their order shipped',reference:channel.name,before:{sender:channel.sender},after:{sender}});
      changed++;
    }
    return changed;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Needs you: tracking emails written and waiting for a person.
async function inbox(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,60,'draft'))return [];
  const {rows}=await db.query(`SELECT n.id,n.shipment_id,n.recipient,n.created_at,n.updated_at,o.order_number,c.name customer_name
    FROM customer_communications n JOIN sales_shipments s ON s.workspace_id=n.workspace_id AND s.id=n.shipment_id
    JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id LEFT JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
    WHERE n.workspace_id=$1 AND n.message_kind='shipping_notice' AND n.status='PREPARED' ORDER BY n.created_at,n.id LIMIT 25`,[workspaceId]);
  return rows.map(r=>({kind:'shipping',importance:'Needs You',priority:58,title:'Send the tracking email for order '+r.order_number,
    happened:r.recipient?'It is written and ready to send to '+r.recipient+'.':'There is no email address for '+(r.customer_name||'this customer')+'.',
    why:'Customers are told their order shipped, with the carrier, tracking number and link.',
    recommendation:r.recipient?'Read it and send it with one tap.':'Add the customer’s email to the order, then send it.',
    href:'/fulfilment/'+r.shipment_id+'#notice',actionLabel:'Send the tracking email',sourceId:'shipment-notice:'+r.id,at:r.updated_at,createdAt:r.created_at}));
}

module.exports={processJob,edit,authority,mailbox,channels,saveChannels,channelFor,inbox,CHANNEL_TYPES};
