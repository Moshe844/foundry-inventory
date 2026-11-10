'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan'),{hash}=require('../pricing/postgres-promotions');
const action='customer_return.send_label',kind='return_label';

async function owner(db,ctx){
 const r=await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
 WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
 AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,[ctx.workspaceId,ctx.actorId]);
 if(!r.rowCount)throw new AuthorizationError('Only the current inventory owner can authorize customer return instructions.');
 await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
}

async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,112,'draft');
 const {rma,quantities}=await require('./postgres-return-parcels').outstanding(db,ctx.workspaceId,id);
 const row=(await db.query(`SELECT s.*,o.order_number,o.contact_email,o.customer_id,c.name customer_name,c.email customer_email,c.record_state,l.name return_location,l.address return_address
 FROM sales_shipments s JOIN sales_orders o ON o.workspace_id=s.workspace_id AND o.id=s.sales_order_id
 JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id
 JOIN locations l ON l.workspace_id=s.workspace_id AND l.id=s.ship_from_location_id AND l.is_active=1
 WHERE s.workspace_id=$1 AND s.customer_return_id=$2 AND s.status='PACKED' AND s.label_status='PURCHASED'
 ORDER BY s.created_at DESC,s.id LIMIT 2`,[ctx.workspaceId,id])).rows;
 if(row.length!==1)throw new ValidationError('Choose a return with one current, purchased carrier label. Quote and buy the label separately before sending it.');
 const s=row[0];await require('./postgres-return-parcels').assertCurrent(db,ctx.workspaceId,s);
 const boxes=await require('./postgres-service').packagesFor(db,ctx.workspaceId,s.id);if(boxes.length!==1)throw new ValidationError('Review and send every label for a multiple-parcel return through the parcel page. This instructions workflow covers one verified parcel.');
 if(s.record_state!=='ACTIVE'||!s.contact_email||s.contact_email.toLowerCase()!==s.customer_email?.toLowerCase())throw new ValidationError('Confirm the return customer’s exact current contact email before preparing instructions.');
 let url;try{url=new URL(s.label_url);}catch{throw new ValidationError('The carrier has not supplied a usable label link.');}
 if(url.protocol!=='https:'||url.username||url.password||url.hash||s.label_url.length>3000)throw new ValidationError('Review the carrier’s secure label link before sending it.');
 const receipt=(await db.query(`SELECT e.id FROM stockchief_runtime.provider_effects e JOIN shipping_label_transactions t ON t.workspace_id=e.workspace_id AND t.id=e.payload->>'transactionId' AND t.shipment_id=e.aggregate_id
 WHERE e.workspace_id=$1 AND e.kind='shipping.label.purchase' AND e.aggregate_id=$2 AND e.status='SUCCEEDED' AND t.status='SUCCEEDED' AND e.result->>'labelUrl'=$3 AND e.result->>'trackingNumber' IS NOT DISTINCT FROM $4 LIMIT 1`,[ctx.workspaceId,s.id,s.label_url,s.tracking_number])).rows[0];
 if(!receipt)throw new ValidationError('Verify the carrier’s actual label-purchase receipt before sending this return label.');
 const mailbox=await require('./agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);
 if(!mailbox)throw new ValidationError('Choose a connected Gmail or Microsoft 365 mailbox with sending permission.');
 const lines=(await db.query(`SELECT r.id,s.code,i.name,o.unit_price_minor FROM customer_return_lines r
 JOIN sales_order_lines o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_line_id
 JOIN skus s ON s.workspace_id=r.workspace_id AND s.id=r.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
 WHERE r.workspace_id=$1 AND r.customer_return_id=$2 ORDER BY r.id LIMIT 101`,[ctx.workspaceId,id])).rows;
 if(!lines.length||lines.length>100)throw new ValidationError('Review return instructions covering one to 100 product lines.');
 const products=quantities.map(q=>{const l=lines.find(l=>l.id===q.lineId);if(!l)throw new ValidationError('The authorized return products changed.');return {sku:l.code,name:l.name,quantity:q.quantity,unitPriceMinor:String(l.unit_price_minor)};});
 const goodsValueMinor=products.reduce((n,p)=>n+require('../domain/exact-quantity').costMinor(p.quantity,Number(p.unitPriceMinor)),0);require('../domain/currency').integer(goodsValueMinor);
 if(goodsValueMinor<=0)throw new ValidationError('Review free or missing-value returned goods individually outside this bounded return-instructions workflow.');
 const evidence={recordId:id,returnNumber:rma.return_number,customerId:s.customer_id,customerName:s.customer_name,recipient:s.contact_email,
  orderNumber:s.order_number,shipmentId:s.id,labelUrl:s.label_url,labelReceipt:receipt.id,tracking:s.tracking_number,carrier:s.carrier,service:s.service,
  returnLocationId:s.ship_from_location_id,returnLocation:s.return_location,returnAddress:s.return_address,origin:s.return_origin,boxes,quantities,products,currency:s.currency,goodsValueMinor,
  connectorId:mailbox.id,mailboxAccount:mailbox.provider_account_id};
 const training=require('../autopilot/draft-authority').scope(s.customer_id,s.currency,goodsValueMinor,[action,evidence.recipient,evidence.returnLocationId,evidence.returnAddress,evidence.origin,evidence.connectorId,evidence.mailboxAccount,products.map(({quantity,...p})=>p)],s.customer_name+' · '+s.return_location+' · '+products.map(p=>p.sku).join(', ')+' · same return route and mailbox');
 const known=(await db.query(`SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_id=$2 AND lower(recipient)=lower($3)
 AND status='SENT' AND external_message_id IS NOT NULL LIMIT 1`,[ctx.workspaceId,s.customer_id,s.contact_email])).rowCount>0;
 return {...evidence,sourceFingerprint:hash(evidence),training,needsRecipientConfirmation:!known};
}

function compose(p){return {subject:'Return label and instructions · '+p.returnNumber,body:[
 'Hello '+p.customerName+',','', 'Your authorized return '+p.returnNumber+' for order '+p.orderNumber+' covers:',
 ...p.products.map(l=>l.quantity+' × '+l.name+' ('+l.sku+')'),'',
 'Print the purchased carrier label from this link:',p.labelUrl,'',
 'Pack only the authorized goods securely, cover any old shipping labels, and attach the printed label to the parcel.',
 'Return destination: '+p.returnLocation+' · '+p.returnAddress,
 p.tracking?'Return tracking number: '+p.tracking:null,'',
 'This email provides return instructions. Receipt, inspection and any credit or refund are separate steps; this message does not confirm them.',
 'If the carrier link no longer opens, contact us before buying another label.','', 'Thank you.'
 ].filter(x=>x!==null).join('\n')};}

async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);
 const state=await policy.requireWorkspaceJob(db,workspaceId,112,'draft'),stopped=await policy.stopped(db,workspaceId,state,action,p.automatic,p);
 if(stopped)throw new ValidationError(stopped);
 const cfg=(await db.query('SELECT paused,suspended FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];if(Number(cfg?.paused)||Number(cfg?.suspended))throw new ValidationError('Return-label mail is paused. Review the inventory’s automation settings before sending.');
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);
 if(fresh.sourceFingerprint!==p.sourceFingerprint||hash(fresh.training)!==hash(p.training))throw new ValidationError('The return, goods, label, route, customer or sending mailbox changed. Review fresh instructions.');
 if(p.automatic){
  if(fresh.needsRecipientConfirmation)throw new ValidationError('Approve the first email to this customer’s current address individually.');
  const trained=state.plan!=='growth'||await require('../autopilot/draft-authority').trained(db,workspaceId,action,fresh);
  policy.requireJob(state.plan,112,'automatic',{trained});
  const rule=(await db.query('SELECT maximum_minor,authorized_by FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[workspaceId,action,fresh.training.key,fresh.currency])).rows[0];
  if(rule&&(rule.authorized_by!==p.actorId||Number(rule.maximum_minor)<fresh.goodsValueMinor))throw new ValidationError('These returned goods exceed the current owner’s saved instructions authority. Review this message individually.');
 }
 const saved=(await db.query("SELECT recipient,subject,body,connector_id FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2",[workspaceId,'return-label:'+fresh.shipmentId])).rows[0],words=compose(fresh);
 if(saved&&(saved.recipient!==fresh.recipient||saved.connector_id!==fresh.connectorId||saved.subject!==words.subject||saved.body!==words.body))throw new ValidationError('Review the earlier return-label delivery before replacing its message.');
 return fresh;
}

async function build(db,ctx,row,args){
 const mailbox=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);
 if(!mailbox.row)throw new ValidationError('Choose the exact connected sending mailbox.');
 const p=await facts(db,ctx,row.id,mailbox.row.id),words=compose(p);
 return {payload:{...p,...words},summary:'Email '+p.customerName+' their already-purchased label and exact authorized goods for '+p.returnNumber+'. No postage purchase, physical receipt, stock, credit or refund change.'};
}
async function execute(db,ctx,p){
 const automatic=ctx.agentReturnLabelScope==='automatic',fresh=await authority(db,ctx.workspaceId,{...p,actorId:ctx.actorId,automatic}),grant={...fresh,kind,actorId:ctx.actorId,automatic};
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['return-label-send:'+ctx.workspaceId+':'+fresh.shipmentId]);
 let key='return-label:'+fresh.shipmentId;
 const existing=(await db.query(`SELECT m.*,e.id effect_id,e.status effect_status,e.result effect_result,e.error_code effect_error,e.payload FROM customer_communications m
 JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
 WHERE m.workspace_id=$1 AND e.payload->'standingAuthority'->>'kind'='return_label' AND e.payload->'standingAuthority'->>'shipmentId'=$2
 ORDER BY e.created_at DESC,e.id DESC LIMIT 1 FOR UPDATE OF m,e`,[ctx.workspaceId,fresh.shipmentId])).rows[0];
 if(existing){
  if(existing.payload?.standingAuthority?.sourceFingerprint!==fresh.sourceFingerprint)throw new ValidationError('Review the existing label message and its source before sending another.');
  const unsent=['FAILED','PENDING'].includes(existing.effect_status)&&existing.effect_error&&existing.effect_result?.providerNotCalled===true;
  if(unsent){
   if(automatic)throw new ValidationError('This return email was held before the mailbox was called. Review and approve this exact retry individually.');
   await db.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',error_message='Replaced by an individually approved retry; the mailbox was never called.',updated_at=now() WHERE workspace_id=$1 AND id=$2 AND status IN('FAILED','PENDING')",[ctx.workspaceId,existing.effect_id]);
   await db.query("UPDATE customer_communications SET status='CANCELLED',updated_at=now()::text WHERE workspace_id=$1 AND id=$2 AND status IN('FAILED','QUEUED')",[ctx.workspaceId,existing.id]);
   key+=':after:'+existing.effect_id;
   await require('../operations/postgres-security-audit').record(db,ctx,{action:'Unsent return-label email replaced after individual review',reference:p.recordId,after:{previousMessage:existing.id,previousEffect:existing.effect_id,providerNotCalled:true}});
  }else{
   if(['FAILED','AMBIGUOUS','CANCELLED'].includes(existing.effect_status))throw new ValidationError('Review the existing label message and its delivery before sending another.');
   return {communicationId:existing.id,communicationKind:'customer',customerReturnId:p.recordId,effectId:existing.effect_id,status:existing.status,automatic,replayed:true};
  }
 }
 const r=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'customer',recipientId:fresh.customerId,recipientEmail:fresh.recipient,connectorId:fresh.connectorId,...compose(fresh),standingAuthority:grant},key,{agentRequested:true,agentJob:112});
 return {...r,customerReturnId:p.recordId,automatic};
}
async function confirmedExample(db,workspaceId,p){return p.result?.automatic===false&&p.result?.replayed!==true&&Boolean((await db.query(`SELECT 1 FROM customer_communications m
 JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
 WHERE m.workspace_id=$1 AND m.id=$2 AND m.customer_id=$3 AND m.status='SENT' AND m.external_message_id IS NOT NULL
 AND e.payload->'standingAuthority'->>'kind'=$4 AND e.payload->'standingAuthority'->>'automatic'='false'
 AND e.payload->'standingAuthority'->>'sourceFingerprint'=$5`,[workspaceId,p.result.communicationId,p.payload.customerId,kind,p.payload.sourceFingerprint])).rowCount);}

async function review(db,ctx){const rows=(await db.query(`SELECT r.return_number "Return",c.name "Customer",s.tracking_number "Return tracking",'/warehouse/returns/customer/'||r.id link
 FROM customer_returns r JOIN sales_orders o ON o.workspace_id=r.workspace_id AND o.id=r.sales_order_id JOIN customers c ON c.workspace_id=o.workspace_id AND c.id=o.customer_id JOIN sales_shipments s ON s.workspace_id=r.workspace_id AND s.customer_return_id=r.id
 WHERE r.workspace_id=$1 AND r.status IN('AUTHORIZED','PARTIALLY_RECEIVED') AND s.status='PACKED' AND s.label_status='PURCHASED'
 ORDER BY r.created_at,r.id LIMIT 101`,[ctx.workspaceId])).rows;const state=await policy.accountState(db,ctx.workspaceId);return {returnLabelForm:{mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),blocked:await policy.stopped(db,ctx.workspaceId,state,action,false)},rows:rows.slice(0,100),more:rows.length>100,summary:'Ask StockChief to send an exact authorized return’s purchased label link and recorded goods through a connected mailbox. Quote and buy postage separately. Growth learns from a provider-confirmed individual send; Pro and Custom do not require teaching. Physical receipt, inspection and refunds remain separate.'};}

module.exports={action,kind,facts,compose,authority,confirmedExample,definition:{id:112,key:'return-labels',label:'Send purchased return labels and instructions',readPage:review},spec:{name:action,agentJob:112,record:'customer_return',fields:['recordReference','mailbox'],permission:require('../actions/permissions').FULFILL_SALES,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultReference:'customerReturnId',resultRecordKind:'customer_return',resultingRecords:['customer_communications','stockchief_runtime.provider_effects'],description:'Send one authorized customer return’s already-purchased carrier label link and exact return instructions. Use the current customer email, original return route and exact mailbox. No label purchase, receipt, stock, credit or refund change. Growth requires a confirmed taught email scope; Pro and Custom can use exact requested known-customer sends without training. A first email address requires individual approval.',build,execute,verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND id=$2 AND customer_id=$3 AND status IN('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.customerId])).rowCount)}};
