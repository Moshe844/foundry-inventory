'use strict';

const {ValidationError,NotFoundError}=require('../domain/errors');
const {hash}=require('../pricing/postgres-promotions');
const {createHash}=require('node:crypto');
const policy=require('../commercial/agent-plan');
const intake=require('./agent-supplier-invoice-intake');
const delivery=require('./invoice-dispute-delivery');
const workflows=require('../operations/postgres-business-workflows');
const queue=require('../operations/postgres-job-queue');
const scoped=db=>({query:(...args)=>db.query(...args),transaction:fn=>fn(db)});
const ACTION='supplier_invoice.dispute', KIND='agent.supplier-invoice-dispute';
const isReviewError=error=>['validation_error','forbidden','entitlement_required','not_found'].includes(error.code);
const normalize=value=>String(value||'').trim().toLowerCase();
const sha=value=>createHash('sha256').update(value).digest('hex');

async function grant(db,ctx,{automatic=false,lock=false}={}) {
  if(lock)await db.query('SELECT s.id FROM account_subscriptions s JOIN workspaces w ON w.owner_account_id=s.account_id WHERE w.id=$1 FOR SHARE OF s',[ctx.workspaceId]);
  await intake.owner(db,ctx,{lock});
  const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,100,'draft');
  const stopped=await policy.stopped(db,ctx.workspaceId,account,ACTION,automatic,{needsDisputeConfirmation:false});
  if(stopped)throw new ValidationError(stopped);
  if(!automatic)return account;
  const mode=(await db.query(`SELECT m.revision,m.mode,m.updated_by,a.mode inventory_mode
    FROM stockchief_runtime.agent_job_modes m JOIN workspace_autopilot a ON a.workspace_id=m.workspace_id
    WHERE m.workspace_id=$1 AND m.job_id=100${lock?' FOR SHARE OF m,a':''}`,[ctx.workspaceId])).rows[0];
  if(mode?.updated_by!==ctx.actorId||mode?.mode!=='routine'||mode.inventory_mode!=='POLICY_AUTOMATED') {
    throw new ValidationError('The current owner must enable routine supplier invoice disputes.');
  }
  return {...account,revision:mode.revision};
}

async function record(db,ctx,row,result) {
  const {id,billId,intakeId}=row;
  await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'invoice-dispute:'+id,
    Buffer.byteLength(JSON.stringify(result))+4096,{finished:true});
  await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,bill_id,intake_id,result,next_check_at)
    VALUES($1,$2,$3,$4,$5::jsonb,CASE WHEN $6 THEN now()+interval '15 minutes' ELSE NULL END)
    ON CONFLICT(id) DO UPDATE SET bill_id=coalesce(EXCLUDED.bill_id,agent_invoice_dispute_work.bill_id),
      intake_id=coalesce(EXCLUDED.intake_id,agent_invoice_dispute_work.intake_id),result=EXCLUDED.result,
      next_check_at=EXCLUDED.next_check_at,checked_at=now()`,
  [id,ctx.workspaceId,billId||null,intakeId||null,JSON.stringify(result),result.status==='HELD']);
}

async function original(db,ctx,id) {
  const row=await intake.get(db,ctx,id,{lock:true});
  const mapped=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND intake_id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(mapped?.bill_id)return {row,work:mapped,billId:mapped.bill_id};
  if(row.status!=='EXCEPTION'||row.duplicate_bill_id||row.bill_id||row.comparison?.status!=='DISPUTED'||!row.prepared_input) {
    throw new ValidationError('Use a saved supplier original with a current invoice difference.');
  }
  const evidence=await intake.source(db,ctx.workspaceId,row.source_upload_id?{uploadId:row.source_upload_id}:row.attachment_id);
  if(row.source_hash!==evidence.content_hash||row.source_text_hash!==sha(evidence.extracted_text)||evidence.supplier_id!==row.supplier_id
      ||evidence.trust_status!=='TRUSTED'||evidence.connection_status!=='connected'||evidence.paused_at||!evidence.provider_account_id) {
    throw new ValidationError('The original supplier document or its mailbox needs review.');
  }
  if(evidence.connector_id) {
    const setting=(await db.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_settings
      WHERE workspace_id=$1 AND authorized_by=$2 AND enabled AND $3=ANY(connector_ids) FOR SHARE`,
    [ctx.workspaceId,ctx.actorId,evidence.connector_id])).rowCount;
    if(!setting)throw new ValidationError('Choose a currently authorized supplier-invoice source mailbox.');
  }
  const comparison=await workflows.previewSupplierInvoice(scoped(db),ctx,row.prepared_input);
  if(comparison.status!=='DISPUTED')throw new ValidationError('The purchase or receipt has changed. Recheck the invoice through supplier invoice matching.');
  const bill=await workflows.recordSupplierInvoice(scoped(db),ctx,{...row.prepared_input,
    sourceKey:'invoice-dispute-source:'+id,idempotencyKey:'invoice-dispute-unposted:'+id,
    expectedMatchFingerprint:comparison.matchFingerprint},{unpostedOnly:true});
  if(bill.status!=='DISPUTED'||bill.journalEntryId)throw new ValidationError('A posted invoice cannot become an unposted dispute.');
  const work={id:mapped?.id||'invoice-dispute-intake:'+id,intakeId:id,billId:bill.billId};
  await record(db,ctx,work,{status:'HELD',problem:'Review the source-proven invoice differences.'});
  return {row,work,billId:bill.billId};
}

async function prepare(database,ctx,id,input) {
  return database.transaction(async db=>{
    await grant(db,ctx,{lock:true});
    const row=await intake.get(db,ctx,id,{lock:true});
    if(input.confirmed!=='yes'||Number(input.revision)!==Number(row.revision))throw new ValidationError('Review the exact current invoice original.');
    return original(db,ctx,id);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function worker(database,workspaceId,input) {
  if(input.verifyEffectId)return delivery.recover(database,workspaceId,input.verifyEffectId);
  return database.transaction(async db=>{
    const saved=(await db.query("SELECT updated_by FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=100 AND mode='routine'",[workspaceId])).rows[0];
    if(!saved)return {skipped:'no_routine_authority'};
    const ctx={workspaceId,actorId:saved.updated_by};
    let granted;
    try{granted=await grant(db,ctx,{automatic:true,lock:true});}
    catch(error){if(isReviewError(error))return {skipped:'no_current_authority'};throw error;}
    const disputes=require('./agent-invoice-disputes');
    const work={id:'invoice-dispute-'+input.sourceKind+':'+input.sourceId};
    if(input.sourceKind==='intake')work.intakeId=input.sourceId;
    else if(input.sourceKind==='bill')work.billId=input.sourceId;
    else throw new ValidationError('The queued invoice dispute has no recognized source.');
    await db.query('SAVEPOINT invoice_dispute_work');
    try {
      if(work.intakeId)Object.assign(work,(await original(db,ctx,work.intakeId)).work);
      const existing=(await db.query('SELECT id,bill_id,intake_id FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2 FOR UPDATE',
        [workspaceId,work.billId])).rows[0];
      if(existing)Object.assign(work,{id:existing.id,billId:existing.bill_id,intakeId:existing.intake_id});
      const bill=(await db.query(`SELECT b.status,b.source_message_id,m.connector_id FROM accounting_supplier_bills b
        LEFT JOIN connection_email_messages m ON m.workspace_id=b.workspace_id AND m.id=b.source_message_id
        WHERE b.workspace_id=$1 AND b.id=$2 FOR UPDATE OF b`,[workspaceId,work.billId])).rows[0];
      if(bill?.status!=='DISPUTED')return {skipped:'bill_no_longer_disputed'};
      const prior=(await db.query('SELECT id,status FROM supplier_communications WHERE workspace_id=$1 AND invoice_dispute_bill_id=$2 ORDER BY created_at DESC LIMIT 1',
        [workspaceId,work.billId])).rows[0];
      if(prior){await record(db,ctx,work,{status:prior.status,communicationId:prior.id});return {status:prior.status,communicationId:prior.id};}
      await db.query('RELEASE SAVEPOINT invoice_dispute_work');
      await db.query('SAVEPOINT invoice_dispute_work');
      const boxes=(await db.query(`SELECT id FROM workspace_connectors WHERE workspace_id=$1 AND status='connected'
        AND paused_at IS NULL AND setup_status IS DISTINCT FROM 'REAUTHORIZATION_REQUIRED'
        AND provider_type IN('gmail','microsoft365') AND provider_account_id IS NOT NULL
        AND capabilities::jsonb ?| array['MAIL_SEND','mail:send'] ORDER BY id`,[workspaceId])).rows;
      const preferred=boxes.find(b=>b.id===bill.connector_id);
      const box=preferred||(boxes.length===1?boxes[0]:null);
      if(!box)throw new ValidationError('Choose the connected sending mailbox for this supplier.');
      const p=await disputes.facts(db,ctx,work.billId,box.id);
      const result=await disputes.spec.execute(db,{...ctx,agentInvoiceDisputeScope:'automatic',invoiceDisputeRoutineRevision:granted.revision},p);
      await db.query('RELEASE SAVEPOINT invoice_dispute_work');
      await record(db,ctx,work,{status:result.status,communicationId:result.communicationId});
      return {status:result.status,billId:work.billId,communicationId:result.communicationId};
    } catch(error) {
      if(!isReviewError(error))throw error;
      await db.query('ROLLBACK TO SAVEPOINT invoice_dispute_work');
      await db.query('RELEASE SAVEPOINT invoice_dispute_work');
      if(work.billId&&!(await db.query('SELECT 1 FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2',[workspaceId,work.billId])).rowCount)delete work.billId;
      if(work.intakeId&&!(await db.query('SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes WHERE workspace_id=$1 AND id=$2',[workspaceId,work.intakeId])).rowCount)return {skipped:'source_removed'};
      await record(db,ctx,work,{status:'HELD',problem:error.message});
      return {status:'HELD',billId:work.billId,problem:error.message};
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function schedule(database,workspaceId) {
  const owner=(await database.query(`SELECT u.id,m.mode FROM users u JOIN workspaces w ON w.owner_account_id=u.account_id AND w.id=u.workspace_id
    LEFT JOIN stockchief_runtime.agent_job_modes m ON m.workspace_id=w.id AND m.job_id=100
    WHERE w.id=$1 AND u.role='owner' ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!owner)return {queued:0};
  const ctx={workspaceId,actorId:owner.id};
  let eligible=false;
  try{await grant(database,ctx,{automatic:true});eligible=true;}catch(error){if(!isReviewError(error))throw error;}
  const rows=eligible?(await database.query(`SELECT * FROM (
    SELECT 'intake' "sourceKind",q.id "sourceId",q.created_at at
    FROM stockchief_runtime.agent_supplier_invoice_intakes q LEFT JOIN stockchief_runtime.agent_invoice_dispute_work w ON w.intake_id=q.id
    WHERE q.workspace_id=$1 AND q.status='EXCEPTION' AND q.comparison->>'status'='DISPUTED'
      AND q.duplicate_bill_id IS NULL AND q.bill_id IS NULL AND (w.id IS NULL OR w.next_check_at<=now())
    UNION ALL SELECT 'bill',b.id,b.created_at::timestamptz FROM accounting_supplier_bills b
      LEFT JOIN stockchief_runtime.agent_invoice_dispute_work w ON w.bill_id=b.id
    WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND b.journal_entry_id IS NULL AND b.invoice_input IS NOT NULL
      AND (w.id IS NULL OR w.intake_id IS NULL AND w.next_check_at<=now())
    ) candidates ORDER BY at,"sourceId" LIMIT 50`,[workspaceId])).rows:[];
  const account=await policy.accountState(database,workspaceId);
  if(policy.usesAgentTerms(account)&&policy.permits(account.plan,100,'draft'))rows.push(...(await database.query(`SELECT id "verifyEffectId"
    FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='AMBIGUOUS' AND provider='microsoft365'
      AND payload->'standingAuthority'->>'kind'='invoice_dispute' AND provider_reference->>'lookupFrom' IS NOT NULL
      AND updated_at<now()-interval '2 minutes' ORDER BY updated_at,id LIMIT 20`,[workspaceId])).rows);
  let queued=0;
  for(const {at,...payload} of rows) {
    const key=[payload.verifyEffectId?'verify':payload.sourceKind,payload.verifyEffectId||payload.sourceId,Math.floor(Date.now()/120000)].join(':');
    const job=await queue.enqueue(database,{workspaceId,kind:KIND,payload,idempotencyKey:key,priority:50,maxAttempts:8});
    if(job.created)queued++;
  }
  return {queued};
}

async function replyContext(db,workspaceId,messageId) {
  if(!messageId)return null;
  const rows=(await db.query(`SELECT m.invoice_dispute_bill_id bill_id,m.id communication_id,m.external_thread_id,
      b.supplier_invoice_number,b.purchase_order_id,b.supplier_id,b.status bill_status,r.id message_id,r.received_at
    FROM connection_email_messages r
    JOIN supplier_communications m ON m.workspace_id=r.workspace_id AND m.connector_id=r.connector_id
      AND m.supplier_id=r.supplier_id AND m.external_thread_id=r.external_thread_id AND lower(m.recipient)=lower(r.sender)
    JOIN accounting_supplier_bills b ON b.workspace_id=m.workspace_id AND b.id=m.invoice_dispute_bill_id
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    JOIN workspace_connectors c ON c.workspace_id=m.workspace_id AND c.id=m.connector_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.trust_status='TRUSTED' AND r.classification='supplier'
      AND r.external_message_id<>m.external_message_id AND r.received_at::timestamptz>=m.sent_at::timestamptz
      AND ${delivery.confirmedSql()} AND e.result->>'externalThreadId'=r.external_thread_id
      AND e.payload->'standingAuthority'->>'kind'='invoice_dispute'
      AND c.provider_account_id=e.payload->'standingAuthority'->>'mailboxAccount' AND c.status='connected' AND c.paused_at IS NULL
      AND lower(coalesce(r.subject,'')) !~ '(automatic reply|out of office|undeliverable|delivery failure)'
    LIMIT 2`,[workspaceId,messageId])).rows;
  return rows.length===1?rows[0]:null;
}

async function correction(db,ctx,billId,sourceId) {
  const bill=await require('./postgres-invoice-review').get(db,ctx,billId);
  if(bill.status!=='DISPUTED'||bill.journal_entry_id||bill.opened_at)throw new ValidationError('Only the unposted disputed original can be replaced.');
  const row=await intake.get(db,ctx,sourceId,{lock:true});
  if(row.bill_id||row.status==='STOPPED'||!row.attachment_id||!row.prepared_input)throw new ValidationError('Choose a retained, unposted corrected invoice original.');
  const original=await intake.source(db,ctx.workspaceId,row.attachment_id);
  const linked=await replyContext(db,ctx.workspaceId,original.message_id);
  if(linked?.bill_id!==billId||row.source_hash!==original.content_hash||row.source_text_hash!==sha(original.extracted_text)
      ||row.source_hash===bill.source_attachment_hash)throw new ValidationError('The corrected original must be from the verified supplier conversation.');
  const document=require('./supplier-invoice-source-parser').parse(original.extracted_text);
  if(document.documentType!=='invoice'||document.replacementInvoiceNumber
      &&normalize(document.replacementInvoiceNumber)!==normalize(bill.supplier_invoice_number)) {
    throw new ValidationError('The corrected original names a different invoice.');
  }
  const requiresReferenceConfirmation=!document.replacementInvoiceNumber
    &&normalize(document.invoiceNumber)!==normalize(bill.supplier_invoice_number);
  const input=await intake.prepareInput(db,ctx,original,document);
  if(input.purchaseOrderId!==bill.purchase_order_id||input.supplierId!==bill.supplier_id)throw new ValidationError('The corrected original names another supplier or purchase order.');
  const comparison=await workflows.recordSupplierInvoice(scoped(db),ctx,input,{preview:true,replacementForId:billId});
  const base=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0]?.base_currency;
  const postingIssue=input.issueDate>await require('../lib/business-time').today(db,ctx.workspaceId)
    ?'Review the future invoice date.' : input.currency!==base?'Review the currency conversion separately.':null;
  const hold=postingIssue || (comparison.status!=='OPEN'?'The corrected original still differs from the purchase order or actual receipts.'
    :!comparison.routineTermsProven?'Review the changed or unverified terms separately.'
    :!comparison.routineAdjustmentsProven&&(input.taxMinor||input.charges.length)?'Review the new tax or charges separately.':null);
  return {bill,row,linked,input,comparison,hold,requiresReferenceConfirmation,fingerprint:hash({billId,billRevision:bill.review_revision,
    messageId:linked.message_id,sourceId:row.id,hash:row.source_hash,revision:row.revision,match:comparison.matchFingerprint})};
}

async function resolve(database,ctx,billId,input) {
  return database.transaction(async db=>{
    await grant(db,ctx,{lock:true});
    await policy.requireWorkspaceJob(db,ctx.workspaceId,98,'draft');
    const prior=(await db.query('SELECT replacement_bill_id,replacement_intake_id FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2 FOR UPDATE',
      [ctx.workspaceId,billId])).rows[0];
    if(prior?.replacement_bill_id&&prior.replacement_intake_id===input.sourceId)return {billId:prior.replacement_bill_id,replayed:true};
    const bill=(await db.query('SELECT id FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,billId])).rows[0];
    if(!bill)throw new NotFoundError('That invoice dispute could not be found.');
    const fresh=await correction(db,ctx,billId,input.sourceId);
    if(input.confirmed!=='yes'||input.fingerprint!==fresh.fingerprint||fresh.hold)throw new ValidationError(fresh.hold||'Review the current corrected invoice and confirm its exact replacement.');
    if(fresh.requiresReferenceConfirmation&&input.confirmReplacementReference!=='yes') {
      throw new ValidationError('Confirm the supplier identified this new invoice number as the replacement for the disputed invoice.');
    }
    const reason=String(input.reason||'').trim();
    if(!reason||reason.length>1000)throw new ValidationError('Record the corrected supplier evidence you reviewed.');
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'invoice-dispute-resolution:'+billId,
      Buffer.byteLength(reason)+8192,{finished:true});
    await db.query(`UPDATE accounting_supplier_bills SET status='VOID',review_revision=review_revision+1,updated_at=now()::text,
      exception_detail=(exception_detail::jsonb||jsonb_build_object('correctedSourceIntake',$3::text,'replacementApprovedBy',$4::text))::text
      WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,billId,fresh.row.id,ctx.actorId]);
    const posted=await workflows.recordSupplierInvoice(scoped(db),ctx,{...fresh.input,sourceKey:'supplier-invoice-source:'+fresh.row.id,
      idempotencyKey:'dispute-correction:'+billId+':'+fresh.row.id,expectedMatchFingerprint:fresh.comparison.matchFingerprint});
    if(posted.status!=='OPEN'||!posted.journalEntryId)throw new ValidationError('The corrected invoice did not post. The disputed original is still retained.');
    await db.query(`UPDATE stockchief_runtime.agent_supplier_invoice_intakes SET status='POSTED',bill_id=$3,
      duplicate_bill_id=NULL,comparison=$4::jsonb,problem=NULL,reviewed_by=$5,reviewed_at=now(),review_note=$6,
      revision=revision+1,retry_after=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2`,
    [ctx.workspaceId,fresh.row.id,posted.billId,JSON.stringify(fresh.comparison),ctx.actorId,reason]);
    await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,bill_id,replacement_intake_id,replacement_bill_id,result)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(bill_id) DO UPDATE SET replacement_intake_id=EXCLUDED.replacement_intake_id,
        replacement_bill_id=EXCLUDED.replacement_bill_id,result=EXCLUDED.result,next_check_at=NULL,checked_at=now()`,
    ['invoice-dispute-bill:'+billId,ctx.workspaceId,billId,fresh.row.id,posted.billId,
      JSON.stringify({status:'RESOLVED',replyMessageId:fresh.linked.message_id,sourceHash:fresh.row.source_hash})]);
    await db.query(`UPDATE stockchief_runtime.agent_supplier_invoice_intakes q SET status='STOPPED',
      problem='The disputed original is retained as void.',retry_after=NULL,revision=revision+1,updated_at=now()
      FROM stockchief_runtime.agent_invoice_dispute_work w WHERE w.workspace_id=$1 AND w.bill_id=$2
        AND q.workspace_id=w.workspace_id AND q.id=w.intake_id`,[ctx.workspaceId,billId]);
    await require('../operations/postgres-security-audit').record(db,ctx,{action:'Supplier invoice dispute resolved',reference:fresh.bill.bill_number,
      after:{disputedBillId:billId,correctedBillId:posted.billId,sourceId:fresh.row.id,replyMessageId:fresh.linked.message_id,reason}});
    return posted;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function page(database,ctx,billId,input={}) {
  await intake.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,100,'draft');
  return database.transaction(async db=>{
    const bill=await require('./postgres-invoice-review').get(db,ctx,billId);
    const work=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2',[ctx.workspaceId,billId])).rows[0];
    const message=(await db.query(`SELECT m.id,m.status,m.error_message,m.sent_at,m.external_thread_id,m.connector_id,
      (${delivery.confirmedSql()}) verified
      FROM supplier_communications m LEFT JOIN stockchief_runtime.provider_effects e
        ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
      WHERE m.workspace_id=$1 AND m.invoice_dispute_bill_id=$2 ORDER BY m.created_at DESC LIMIT 1`,[ctx.workspaceId,billId])).rows[0];
    const pageNumber=Number(input.page||1);
    if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>1000000)throw new ValidationError('Choose a valid supplier reply page.');
    const replies=message?.verified&&message.external_thread_id?(await db.query(`SELECT r.id,r.subject,r.received_at,r.sender
      FROM connection_email_messages r JOIN supplier_communications m ON m.workspace_id=r.workspace_id AND m.connector_id=r.connector_id
        AND m.supplier_id=r.supplier_id AND m.external_thread_id=r.external_thread_id AND lower(m.recipient)=lower(r.sender)
      WHERE r.workspace_id=$1 AND m.id=$2 AND r.trust_status='TRUSTED' AND r.classification='supplier'
        AND r.external_message_id<>m.external_message_id AND r.received_at::timestamptz>=m.sent_at::timestamptz
        AND lower(coalesce(r.subject,'')) !~ '(automatic reply|out of office|undeliverable|delivery failure)'
      ORDER BY r.received_at DESC,r.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,message.id,(pageNumber-1)*50])).rows:[];
    const visible=replies.slice(0,50);
    const sources=visible.length?(await db.query(`SELECT q.id,q.invoice_number,q.status,a.message_id,a.filename
      FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN connection_email_attachments a
        ON a.workspace_id=q.workspace_id AND a.id=q.attachment_id
      WHERE q.workspace_id=$1 AND a.message_id=ANY($2::text[]) AND q.document->>'documentType'='invoice'
      ORDER BY q.created_at DESC,q.id`,[ctx.workspaceId,visible.map(r=>r.id)])).rows:[];
    let selected=null;
    if(input.source&&bill.status==='DISPUTED'){
      try{selected=await correction(db,ctx,billId,String(input.source));}
      catch(error){if(!isReviewError(error))throw error;selected={hold:error.message};}
    }
    const blocked=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    return {bill,work,message,replies:visible,sources,selected,blocked,page:pageNumber,more:replies.length>50,
      mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId)};
  },{isolation:'REPEATABLE READ'});
}

module.exports={KIND,grant,prepare,worker,schedule,replyContext,correction,resolve,page};
