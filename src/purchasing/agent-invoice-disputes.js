'use strict';
const {ValidationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions');
const action='supplier_invoice.dispute',kind='invoice_dispute';
const {owner,source:loadIntakeSource,prepareInput,economic}=require('./agent-supplier-invoice-intake');
const delivery=require('./invoice-dispute-delivery');
async function facts(db,ctx,id,connectorId){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,100,'draft');
 const scoped=typeof db.transaction==='function'?db:{query:(...args)=>db.query(...args),transaction:fn=>fn(db)};
 const preview=await require('./postgres-invoice-review').preview(scoped,ctx,id),b=preview.bill;
 if(b.status!=='DISPUTED'||b.journal_entry_id||preview.status!=='DISPUTED'||!preview.differences.length||!b.purchase_order_id||!b.supplier_invoice_number)throw new ValidationError('Use an unposted supplier invoice with its supplier invoice number and a current purchase-order or receipt difference.');
 if([...b.supplier_invoice_number].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new ValidationError('Record a single-line supplier invoice number without control characters before preparing its message.');
 const supplier=(await db.query('SELECT * FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,b.supplier_id])).rows[0];
 if(supplier?.status!=='active'||!/^\S+@\S+\.\S+$/.test(supplier.email||''))throw new ValidationError('Confirm the active supplier and its email before preparing a dispute.');
 const box=await require('../shipping/agent-shipping-notices').mailbox(db,ctx.workspaceId,connectorId);if(!box)throw new ValidationError('Choose a connected Gmail or Microsoft 365 sending mailbox.');
 let source;
 if(b.invoice_input.sourceUploadId) {
  const uploaded=await loadIntakeSource(db,ctx.workspaceId,{uploadId:b.invoice_input.sourceUploadId});
  source={s:uploaded,row:uploaded,evidence:{uploadId:uploaded.id,sourceHash:uploaded.content_hash,
   textHash:require('node:crypto').createHash('sha256').update(uploaded.extracted_text).digest('hex'),filename:uploaded.filename}};
 }else source=await require('./agent-invoice-source').readOriginal(db,ctx,b.invoice_input);
 let exactDocument=false;
 try{
  const document=require('./agent-invoice-source').parse(source.s.extracted_text);
  const original=await prepareInput(db,ctx,source.s,document);
  const sender=(String(source.s.sender||'').match(/<([^<>]+)>/)?.[1]||String(source.s.sender||'')).trim().toLowerCase();
  const factual=new Set(['invoice_ahead_of_receipt','invoice_weight_ahead_of_receipt','invoice_measure_mismatch',
   'price_outside_approved_cost','invoice_currency_differs','additional_charges_require_review','invoice_tracking_not_received',
   'invoice_tracking_already_billed','invoice_serial_count_differs','invoice_serial_weight_differs','invoice_exceeds_receipt_value',
   'invoice_receipt_value_differs','document_total_differs','line_total_differs','invoice_tax_differs']);
  exactDocument=document.documentType==='invoice'&&source.s.supplier_id===b.supplier_id&&source.s.trust_status==='TRUSTED'
   &&(source.s.source_upload_id ? Boolean(source.s.supplier_submission_id)
    : source.row.status==='connected'&&!source.row.paused_at&&Boolean(source.row.provider_account_id)&&sender===supplier.email.toLowerCase())
   &&economic(original)===economic(b.invoice_input)&&b.issue_date<=await require('../lib/business-time').today(db,ctx.workspaceId)
   &&preview.differences.every(d=>d.approved||factual.has(d.kind)&&
    (d.kind!=='price_outside_approved_cost'||Number.isSafeInteger(d.approvedUnitCostMinor)));
 }catch(error){exactDocument=false;if(!(error instanceof ValidationError))throw error;}
 const explained=await require('./invoice-dispute-evidence').explain(db,ctx,b,preview),differences=explained.differences;
 const training=require('../autopilot/draft-authority').scope(supplier.id,b.currency,Number(b.total_minor),['invoice-dispute',box.id,box.provider_account_id,box.provider_type,supplier.email,...[...new Set(differences.map(d=>d.kind))].sort(),...preview.lines.map(l=>l.skuId).sort()],supplier.name+' · invoice difference review');
 const p={recordId:b.id,billNumber:b.bill_number,invoiceNumber:b.supplier_invoice_number,supplierId:supplier.id,supplierName:supplier.name,recipient:supplier.email,currency:b.currency,totalMinor:Number(b.total_minor),billRevision:preview.billRevision,matchFingerprint:preview.matchFingerprint,sourceEvidence:source.evidence,sourceSender:source.s.sender,connectorId:box.id,mailboxAccount:box.provider_account_id,providerType:box.provider_type,differences,purchaseOrderNumber:explained.purchaseOrderNumber,disputedMinor:explained.disputedMinor,needsDisputeConfirmation:!exactDocument,training};
 return {...p,sourceFingerprint:hash(p)};
}
const inQuestion=p=>p.disputedMinor==null?'':'Amount in question: '+money.format(p.disputedMinor,p.currency)+'.\n\n';
const order=p=>p.purchaseOrderNumber?', purchase order '+p.purchaseOrderNumber:'';
function compose(p){return {subject:'Please review invoice '+p.invoiceNumber,body:'Hello '+p.supplierName+',\n\nPlease help us reconcile invoice '+p.invoiceNumber+' (recorded total '+money.format(p.totalMinor,p.currency)+order(p)+') with our purchase-order and receipt records:\n\n'+p.differences.map(d=>d.text).join('\n')+'\n\n'+inQuestion(p)+'Please confirm these details or send a corrected invoice or a credit note if needed. This message does not agree to a changed price or payment term.\n\nThank you.'};}
// Job 100: a reminder repeats the same differences when the supplier has not answered.
function composeReminder(p){return {subject:'Reminder: please review invoice '+p.invoiceNumber,body:'Hello '+p.supplierName+',\n\nWe wrote on '+p.firstSentOn+' about invoice '+p.invoiceNumber+' (recorded total '+money.format(p.totalMinor,p.currency)+order(p)+') and have not had a reply yet. The differences are:\n\n'+p.differences.map(d=>d.text).join('\n')+'\n\n'+inQuestion(p)+'Please confirm these details or send a corrected invoice or a credit note. This message does not agree to a changed price or payment term.\n\nThank you.'};}
async function authority(db,workspaceId,p){
 const ctx={workspaceId,actorId:p.actorId};await owner(db,ctx);const state=await policy.requireWorkspaceJob(db,workspaceId,100,'draft'),stop=await policy.stopped(db,workspaceId,state,action,p.automatic,p);if(stop)throw new ValidationError(stop);
 const fresh=await facts(db,ctx,p.recordId,p.connectorId);if(fresh.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('The original invoice, purchase order, receipt, supplier or mailbox changed. Review a fresh dispute.');
 if(p.reminder!=null)await require('./invoice-dispute-follow-through').reminderDue(db,ctx,p.recordId,p.reminder,{automatic:p.automatic});
 if(!p.automatic)return fresh;
 if(p.discoveryRevision!=null){
  const source=(await db.query(`SELECT q.status,a.message_id,q.source_upload_id FROM stockchief_runtime.agent_invoice_dispute_work w
    JOIN stockchief_runtime.agent_supplier_invoice_intakes q ON q.workspace_id=w.workspace_id AND q.id=w.intake_id
    LEFT JOIN connection_email_attachments a ON a.workspace_id=q.workspace_id AND a.id=q.attachment_id
    WHERE w.workspace_id=$1 AND w.bill_id=$2`,[workspaceId,p.recordId])).rows[0];
  if(source?.status==='STOPPED')throw new ValidationError('The owner stopped the supplier original.');
  if(source?.message_id&&!(await db.query(`SELECT 1 FROM connection_email_messages m
    JOIN stockchief_runtime.agent_supplier_invoice_settings s ON s.workspace_id=m.workspace_id
    WHERE m.workspace_id=$1 AND m.id=$2 AND s.enabled AND s.authorized_by=$3 AND m.connector_id=ANY(s.connector_ids)`,
  [workspaceId,source.message_id,p.actorId])).rowCount)throw new ValidationError('The original mailbox is no longer authorized for supplier invoice matching.');
  const current=await require('./invoice-dispute-follow-through').grant(db,ctx,{automatic:true,lock:typeof db.transaction!=='function'});
  if(current.revision!==p.discoveryRevision)throw new ValidationError('The invoice dispute routine authority changed. Review this invoice again.');
 }
 if(fresh.needsDisputeConfirmation)throw new ValidationError('Review this invoice and original document individually before sending its dispute.');
 // Pro learns from an approved example (its scope and limit) or from the owner's saved dispute limit (job 100).
 const saved=await require('./invoice-dispute-follow-through').rule(db,workspaceId);
 const trained=state.plan!=='pro'||saved?.authorized_by===p.actorId||await require('../autopilot/draft-authority').trained(db,workspaceId,action,fresh);policy.requireJob(state.plan,100,'automatic',{trained});
 const rule=(await db.query('SELECT maximum_minor FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1 AND action_type=$2 AND scope_key=$3 AND currency=$4',[workspaceId,action,fresh.training.key,fresh.currency])).rows[0];
 if(rule&&Number(rule.maximum_minor)<fresh.totalMinor)throw new ValidationError('This invoice is above the owner’s taught dispute limit. Review it individually.');
 if(saved){
  const amount=fresh.disputedMinor??fresh.totalMinor,format=minor=>money.format(minor,fresh.currency);
  if(saved.currency!==fresh.currency)throw new ValidationError('Your dispute limit is in '+saved.currency+'. A dispute in '+fresh.currency+' waits for you.');
  if(amount>Number(saved.maximum_minor))throw new ValidationError((fresh.disputedMinor==null?'The amount in question is unclear, so the whole invoice ('+format(amount)+') counts. ':'The amount in question is '+format(amount)+'. ')
   +'That is over your '+format(Number(saved.maximum_minor))+' dispute limit, so this dispute waits for you.');
 }
 return fresh;
}
async function build(db,ctx,row,args){const box=await require('../connections/postgres-outbound-mail').resolveMailbox(db,ctx.workspaceId,args.mailbox);if(!box.row)throw new ValidationError('Choose the exact connected sending mailbox.');const p=await facts(db,ctx,row.id,box.row.id);return {payload:p,summary:'Ask '+p.supplierName+' ('+p.recipient+') to review invoice '+p.invoiceNumber+': '+p.differences.map(d=>d.text).join(' ')+' This leaves the invoice, stock and money records in place.'};}
async function execute(db,ctx,p){
 const reminder=p.reminder!=null;
 if(reminder&&(!Number.isSafeInteger(p.reminder)||p.reminder<1||!/^\d{4}-\d{2}-\d{2}$/.test(String(p.firstSentOn||''))))throw new ValidationError('Reload the dispute before sending a reminder.');
 const authorityPayload={...p,kind,actorId:ctx.actorId,automatic:ctx.agentInvoiceDisputeScope==='automatic',
  ...(ctx.invoiceDisputeRoutineRevision==null?{}:{discoveryRevision:ctx.invoiceDisputeRoutineRevision})};await authority(db,ctx.workspaceId,authorityPayload);const key=reminder?'invoice-dispute-reminder:'+p.recordId+':'+p.reminder:'invoice-dispute:'+p.recordId,words=reminder?composeReminder(p):compose(p),existing=(await db.query(`SELECT m.*,e.id effect_id,e.payload FROM supplier_communications m LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND m.idempotency_key=$2`,[ctx.workspaceId,key])).rows[0];
 if(existing&&(existing.recipient!==p.recipient||existing.subject!==words.subject||existing.body!==words.body||existing.connector_id!==p.connectorId))throw new ValidationError('An earlier dispute already uses this invoice. Review its delivery before sending changed details.');
 if(existing?.status==='FAILED')throw new ValidationError('Review the earlier dispute and its delivery before trying again.');
 if(existing?.status==='SENT')return {communicationId:existing.id,billId:p.recordId,status:'SENT',alreadySent:true,replayed:true,effectId:existing.effect_id};
 if(existing){
  const previous=existing.payload?.standingAuthority;
  if(!existing.effect_id||previous?.kind!==kind||previous.sourceFingerprint!==p.sourceFingerprint)throw new ValidationError('Review the earlier dispute and its delivery before trying again.');
  if(existing.status==='QUEUED')await authority(db,ctx.workspaceId,previous);
  return {communicationId:existing.id,billId:p.recordId,status:existing.status,effectId:existing.effect_id,replayed:true};
 }
 const r=await require('../connections/postgres-outbound-mail').queueInTransaction(db,ctx,{recipientKind:'supplier',recipientId:p.supplierId,recipientEmail:p.recipient,connectorId:p.connectorId,...words,standingAuthority:authorityPayload},key,{agentRequested:true,agentJob:100});
 await db.query('UPDATE supplier_communications SET invoice_dispute_bill_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.communicationId,p.recordId]);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:reminder?'Supplier invoice dispute reminder queued':'Supplier invoice dispute queued',reference:p.invoiceNumber,
  after:{billId:p.recordId,communicationId:r.communicationId,automatic:authorityPayload.automatic,currency:p.currency,amountInQuestionMinor:p.disputedMinor??null,...(reminder?{reminder:p.reminder}:{})}});
 return {...r,billId:p.recordId,replayed:Boolean(existing)};
}
async function confirmedExample(db,workspaceId,p){if(p.payload.needsDisputeConfirmation!==false)return false;return Boolean((await db.query(`SELECT 1 FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'
 WHERE m.workspace_id=$1 AND m.id=$2 AND m.invoice_dispute_bill_id=$3 AND ${delivery.confirmedSql()} AND e.payload->'standingAuthority'->>'kind'='invoice_dispute'
  AND e.payload->'standingAuthority'->>'automatic'='false' AND e.payload->'standingAuthority'->>'sourceFingerprint'=$4`,[workspaceId,p.result?.communicationId||'',p.payload.recordId,p.payload.sourceFingerprint])).rows.length);}
async function review(db,ctx,{page=1,filter=''}){
 const rows=(await db.query(`SELECT b.bill_number "Bill",b.supplier_invoice_number "Supplier invoice",s.name "Supplier",b.total_minor,b.currency,'/autopilot/supplier-disputes/'||b.id link,
  CASE WHEN w.replacement_bill_id IS NOT NULL THEN 'Corrected invoice posted' WHEN w.credit_intake_id IS NOT NULL THEN 'Settled by credit note' WHEN b.status='OPEN' THEN 'Invoice matched and posted'
    WHEN b.status='DISPUTED' AND w.attention IS NOT NULL THEN w.attention
    WHEN m.status='SENT' AND NOT coalesce(m.verified,false) THEN 'Verify mailbox delivery'
    ELSE CASE m.status WHEN 'SENT' THEN 'Sent' WHEN 'QUEUED' THEN 'Queued' WHEN 'FAILED' THEN 'Needs review: '||coalesce(m.error_message,'Delivery could not be confirmed') ELSE coalesce(w.result->>'problem','Review the invoice difference') END END "Supplier message"
  FROM accounting_supplier_bills b JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id
  LEFT JOIN stockchief_runtime.agent_invoice_dispute_work w ON w.bill_id=b.id AND w.workspace_id=b.workspace_id
  LEFT JOIN LATERAL(SELECT m.status,m.error_message,(${delivery.confirmedSql()}) verified FROM supplier_communications m
    LEFT JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=b.workspace_id AND m.invoice_dispute_bill_id=b.id ORDER BY m.created_at DESC LIMIT 1)m ON true
  WHERE b.workspace_id=$1 AND (b.status='DISPUTED' OR w.replacement_bill_id IS NOT NULL OR w.credit_intake_id IS NOT NULL OR b.status='OPEN' AND m.verified) AND ($2='' OR lower(b.bill_number)=lower($2) OR lower(b.supplier_invoice_number)=lower($2) OR lower(s.name)=lower($2)) ORDER BY b.created_at DESC,b.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const intakeRows=(await db.query(`SELECT q.id,q.invoice_number,q.revision,s.name supplier,w.result->>'problem' problem
  FROM stockchief_runtime.agent_supplier_invoice_intakes q LEFT JOIN stockchief_runtime.agent_invoice_dispute_work w ON w.intake_id=q.id
  JOIN suppliers s ON s.workspace_id=q.workspace_id AND s.id=q.supplier_id
  WHERE q.workspace_id=$1 AND q.status='EXCEPTION' AND q.comparison->>'status'='DISPUTED'
    AND q.bill_id IS NULL AND q.duplicate_bill_id IS NULL AND w.bill_id IS NULL
    AND ($2='' OR lower(q.invoice_number)=lower($2) OR lower(s.name)=lower($2))
  ORDER BY q.created_at DESC,q.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,(page-1)*100])).rows;
 const state=await policy.accountState(db,ctx.workspaceId);
 return {summary:'Review disputes against supplier originals, approved purchase orders and actual receipts. Confirmed mailbox conversations show replies, reminders, corrected invoices and credit notes. A disputed invoice stays out of the payment run until it is settled.',
  rows:rows.slice(0,100).map(({total_minor,currency,...r})=>({...r,Total:money.format(total_minor,currency)})),more:rows.length>100||intakeRows.length>100,
  invoiceDisputeForm:{intakes:intakeRows.slice(0,100),mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId),
    blocked:await policy.stopped(db,ctx.workspaceId,state,action,false),...await require('./invoice-dispute-follow-through').ruleForm(db,ctx,state)}};
}
module.exports={facts,compose,composeReminder,authority,confirmedExample,definition:{id:100,key:'supplier-invoice-disputes',label:'Ask suppliers to review invoice differences',filterLabel:'Bill, supplier invoice or supplier',readPage:review},spec:{name:action,agentJob:100,description:'Prepare a supplier invoice dispute from its original readable supplier document and current purchase-order/receipt differences. Sends a factual review request only; never changes a price, payable, stock, payment or supplier terms.',record:'supplier_bill',fields:['recordReference','mailbox'],permission:require('../actions/permissions').MANAGE_ACCOUNTING,ownerOnly:true,capability:'connection.email',completionGate:'provider_effect_succeeded',resultingRecords:['supplier_communications','stockchief_runtime.provider_effects'],build,execute,
 verify:async(db,ctx,r,p)=>Boolean((await db.query("SELECT 1 FROM supplier_communications WHERE workspace_id=$1 AND id=$2 AND invoice_dispute_bill_id=$3 AND status IN ('QUEUED','SENDING','SENT')",[ctx.workspaceId,r.communicationId,p.recordId])).rows.length)}};
