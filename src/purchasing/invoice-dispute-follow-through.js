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
  if(input.reminderBillId)return reminderWorker(database,workspaceId,input);
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
  const followed=await followUp(database,workspaceId,{eligible});
  return {queued,reminders:followed.reminders};
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
    ORDER BY m.sent_at::timestamptz,m.id LIMIT 10`,[workspaceId,messageId])).rows;
  // A reminder can share the dispute's thread; the reply still belongs to one dispute.
  return rows.length&&new Set(rows.map(r=>r.bill_id)).size===1?rows[0]:null;
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

// Job 100 follow-up: the owner's dispute limit and reminder schedule, the whole
// conversation with the supplier, reminders when it does not answer, replies
// that wait for a person, and settlement by a supplier credit note.
const RULES='stockchief_runtime.agent_invoice_dispute_rules';
const DEFAULTS=Object.freeze({reminderDays:7,reminderLimit:2});
const REMINDER='invoice-dispute-reminder:';
const SETTLED_BY_CREDIT=new Set(['price_outside_approved_cost','additional_charges_require_review','invoice_tax_differs']);
const money=require('../domain/currency');
const audit=require('../operations/postgres-security-audit');
const {has}=require('../db/schema-installed');

async function rule(db,workspaceId,{lock=false}={}) {
  return (await db.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 AND enabled${lock?' FOR SHARE':''}`,[workspaceId])).rows[0]||null;
}
async function schedulePolicy(db,workspaceId) {
  const saved=await rule(db,workspaceId);
  return saved?{reminderDays:Number(saved.reminder_days),reminderLimit:Number(saved.reminder_limit)}:DEFAULTS;
}
async function ruleForm(db,ctx,state) {
  const saved=(await db.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
  const books=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
  return {rule:saved?{enabled:saved.enabled,revision:saved.revision,currency:saved.currency,maximum:money.fromMinor(saved.maximum_minor,saved.currency),
      reminderDays:saved.reminder_days,reminderLimit:saved.reminder_limit}:null,
    ruleRevision:saved?.revision||0,ruleCurrency:books?.base_currency||null,rulePlan:state.plan,defaults:DEFAULTS};
}

async function configure(database,ctx,input) {
  return database.transaction(async db=>{
    await intake.owner(db,ctx,{lock:true});
    await policy.requireWorkspaceJob(db,ctx.workspaceId,100,'draft');
    const prior=(await db.query(`SELECT * FROM ${RULES} WHERE workspace_id=$1 FOR UPDATE`,[ctx.workspaceId])).rows[0];
    if(Number(input.revision)!==Number(prior?.revision||0))throw new ValidationError('Reload your dispute limit before changing it.');
    if(input.stop==='yes'){
      if(prior?.enabled){
        await db.query(`UPDATE ${RULES} SET enabled=false,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1`,[ctx.workspaceId]);
        await audit.record(db,ctx,{action:'Supplier invoice dispute limit stopped',before:{maximumMinor:Number(prior.maximum_minor),currency:prior.currency}});
      }
      return {stopped:true};
    }
    if(input.confirmed!=='yes')throw new ValidationError('Confirm the dispute limit and reminder schedule.');
    const books=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
    if(!books)throw new ValidationError('Set up the accounting currency first.');
    const maximum=money.userToMinor(input.maximum,books.base_currency,{label:'Dispute limit'});
    const days=Number(input.reminderDays),limit=Number(input.reminderLimit);
    if(!(maximum>0))throw new ValidationError('Enter a dispute limit above zero.');
    if(!Number.isSafeInteger(days)||days<1||days>60)throw new ValidationError('Remind after 1 to 60 days.');
    if(!Number.isSafeInteger(limit)||limit<0||limit>5)throw new ValidationError('Send 0 to 5 reminders.');
    await require('../manager/postgres-operating-instructions').checkRuleLimit(db,ctx,[],prior?.enabled?0:1);
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'invoice-dispute-rule:'+((prior?.revision||0)+1),4096,{finished:true});
    await db.query(`INSERT INTO ${RULES}(workspace_id,currency,maximum_minor,reminder_days,reminder_limit,authorized_by)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true,currency=EXCLUDED.currency,
      maximum_minor=EXCLUDED.maximum_minor,reminder_days=EXCLUDED.reminder_days,reminder_limit=EXCLUDED.reminder_limit,
      authorized_by=EXCLUDED.authorized_by,revision=agent_invoice_dispute_rules.revision+1,updated_at=clock_timestamp()`,
    [ctx.workspaceId,books.base_currency,maximum,days,limit,ctx.actorId]);
    await audit.record(db,ctx,{action:'Supplier invoice dispute limit saved',
      before:prior?{maximumMinor:Number(prior.maximum_minor),reminderDays:prior.reminder_days,reminderLimit:prior.reminder_limit,enabled:prior.enabled}:{},
      after:{maximumMinor:maximum,currency:books.base_currency,reminderDays:days,reminderLimit:limit}});
    return {maximumMinor:maximum};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function businessDay(db,workspaceId) {
  const time=require('../lib/business-time'),{timeZone}=await time.forWorkspace(db,workspaceId);
  return at=>time.context(timeZone,new Date(at)).calendarDate;
}

// Every message sent for this dispute, the supplier's replies in those threads
// and any credit note the supplier sent for this invoice.
async function conversation(db,workspaceId,bill) {
  const messages=(await db.query(`SELECT m.id,m.status,m.sent_at,m.created_at,m.external_thread_id,m.connector_id,m.idempotency_key,
      m.subject,m.error_message,coalesce((${delivery.confirmedSql()}),false) verified
    FROM supplier_communications m LEFT JOIN stockchief_runtime.provider_effects e
      ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send'
    WHERE m.workspace_id=$1 AND m.invoice_dispute_bill_id=$2 ORDER BY m.created_at,m.id`,[workspaceId,bill.id])).rows
    .map(m=>({...m,reminder:m.idempotency_key.startsWith(REMINDER)?Number(m.idempotency_key.split(':').at(-1)):null}));
  const verified=messages.filter(m=>m.verified);
  const replies=verified.length?(await db.query(`SELECT count(DISTINCT r.id)::int n,max(r.received_at::timestamptz) latest
    FROM connection_email_messages r JOIN supplier_communications m ON m.workspace_id=r.workspace_id AND m.connector_id=r.connector_id
      AND m.supplier_id=r.supplier_id AND m.external_thread_id=r.external_thread_id AND lower(m.recipient)=lower(r.sender)
    WHERE r.workspace_id=$1 AND m.id=ANY($2::text[]) AND r.trust_status='TRUSTED' AND r.classification='supplier'
      AND r.external_message_id<>m.external_message_id AND r.received_at::timestamptz>=m.sent_at::timestamptz
      AND lower(coalesce(r.subject,'')) !~ '(automatic reply|out of office|undeliverable|delivery failure)'`,
  [workspaceId,verified.map(m=>m.id)])).rows[0]:{n:0,latest:null};
  const credits=bill.supplier_invoice_number?(await db.query(`SELECT q.id,q.invoice_number,q.created_at,q.revision
    FROM stockchief_runtime.agent_supplier_invoice_intakes q
    WHERE q.workspace_id=$1 AND q.supplier_id=$2 AND q.status='CREDIT_REVIEW'
      AND lower(btrim(q.document->>'originalInvoiceNumber'))=lower(btrim($3))
    ORDER BY q.created_at DESC,q.id LIMIT 20`,[workspaceId,bill.supplier_id,bill.supplier_invoice_number])).rows:[];
  const sentAt=verified.map(m=>m.sent_at).filter(Boolean).sort((a,b)=>Date.parse(a)-Date.parse(b));
  return {messages,first:verified.find(m=>m.reminder==null)||null,pending:messages.some(m=>!m.verified),
    remindersSent:verified.filter(m=>m.reminder!=null).length,lastSentAt:sentAt.at(-1)||null,
    replyCount:Number(replies.n),lastReplyAt:replies.latest,credits};
}

async function disputedBill(db,workspaceId,billId,{lock=false}={}) {
  const bill=(await db.query(`SELECT id,bill_number,supplier_id,supplier_invoice_number,status,journal_entry_id,review_revision,currency
    FROM accounting_supplier_bills WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[workspaceId,billId])).rows[0];
  if(!bill)throw new NotFoundError('That invoice dispute could not be found.');
  return bill;
}

// Checked when a reminder is prepared and again when the mailbox sends it.
async function reminderDue(db,ctx,billId,number,{automatic=false}={}) {
  const bill=await disputedBill(db,ctx.workspaceId,billId);
  if(bill.status!=='DISPUTED'||bill.journal_entry_id)throw new ValidationError('This dispute is settled. No reminder is needed.');
  const c=await conversation(db,ctx.workspaceId,bill),own=REMINDER+billId+':'+number;
  const others=c.messages.filter(m=>m.idempotency_key!==own);
  if(!c.first)throw new ValidationError('Wait until the mailbox confirms the dispute was sent.');
  if(others.some(m=>!m.verified))throw new ValidationError('Wait until the mailbox confirms the earlier message before sending a reminder.');
  if(others.filter(m=>m.reminder!=null).length!==number-1)throw new ValidationError('This reminder was already sent. Reload the dispute.');
  if(c.replyCount||c.credits.length)throw new ValidationError('The supplier has replied. Read the reply before writing again.');
  if(automatic){
    const plan=await schedulePolicy(db,ctx.workspaceId),sent=Math.max(...others.map(m=>Date.parse(m.sent_at)));
    if(number>plan.reminderLimit)throw new ValidationError('StockChief has sent '+plan.reminderLimit+' reminder'+(plan.reminderLimit===1?'':'s')+'. The next step is yours.');
    if(!(sent<=Date.now()-plan.reminderDays*86400000))throw new ValidationError('The next reminder is not due yet.');
  }
  return c;
}

// What an open dispute waits for. Clearing it never creates an empty record;
// marking replies read always records when.
async function attention(db,workspaceId,billId,text,{read=false}={}) {
  const id='invoice-dispute-bill:'+billId;
  if(!(await db.query('SELECT 1 FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2',[workspaceId,billId])).rowCount){
    if(text===null&&!read)return;
    await require('../commercial/storage-capacity').reserve(db,workspaceId,'invoice-dispute:'+id,4096,{finished:true});
  }
  await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,bill_id,attention,attention_at,replies_seen_at)
    VALUES($1,$2,$3,$4,CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,CASE WHEN $5 THEN now() ELSE NULL END)
    ON CONFLICT(bill_id) DO UPDATE SET attention=EXCLUDED.attention,
      attention_at=CASE WHEN EXCLUDED.attention IS NULL THEN NULL
        WHEN agent_invoice_dispute_work.attention IS NOT DISTINCT FROM EXCLUDED.attention THEN agent_invoice_dispute_work.attention_at ELSE now() END,
      replies_seen_at=CASE WHEN $5 THEN now() ELSE agent_invoice_dispute_work.replies_seen_at END`,
  [id,workspaceId,billId,text,read]);
}

async function queueReminder(db,ctx,bill,c,number) {
  if(!c.first)throw new ValidationError('Wait until the mailbox confirms the dispute was sent.');
  const disputes=require('./agent-invoice-disputes'),day=await businessDay(db,ctx.workspaceId);
  const p=await disputes.facts(db,ctx,bill.id,c.first.connector_id);
  const result=await disputes.spec.execute(db,ctx,{...p,reminder:number,firstSentOn:day(c.first.sent_at)});
  await attention(db,ctx.workspaceId,bill.id,null);
  return {...result,reminder:number};
}

async function remind(database,ctx,billId,input) {
  return database.transaction(async db=>{
    await grant(db,ctx,{lock:true});
    const bill=await disputedBill(db,ctx.workspaceId,billId,{lock:true});
    const c=await conversation(db,ctx.workspaceId,bill),number=c.remindersSent+1;
    if(input.confirmed!=='yes'||Number(input.reminder)!==number)throw new ValidationError('Reload the dispute and confirm this reminder.');
    return queueReminder(db,{...ctx,agentInvoiceDisputeScope:'individual'},bill,c,number);
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function markRead(database,ctx,billId,input) {
  return database.transaction(async db=>{
    await intake.owner(db,ctx,{lock:true});
    await policy.requireWorkspaceJob(db,ctx.workspaceId,100,'draft');
    const bill=await disputedBill(db,ctx.workspaceId,billId,{lock:true});
    if(input.confirmed!=='yes')throw new ValidationError('Confirm you have read the supplier’s replies.');
    await attention(db,ctx.workspaceId,bill.id,null,{read:true});
    await audit.record(db,ctx,{action:'Supplier invoice dispute replies read',reference:bill.supplier_invoice_number||bill.bill_number,after:{billId:bill.id}});
    return {billId:bill.id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// A supplier credit note can settle a price, charge or tax difference: the
// invoice posts as billed and the credit note brings it back to what was
// agreed. Goods billed but not received need a corrected invoice instead.
async function creditOffer(db,ctx,billId,sourceId) {
  const review=require('./postgres-invoice-review'),credits=require('./agent-supplier-credit-notes');
  const bill=await review.get(db,ctx,billId);
  if(bill.status!=='DISPUTED'||bill.journal_entry_id||bill.opened_at)throw new ValidationError('Only an open, unposted dispute can be settled with a credit note.');
  const row=await intake.get(db,ctx,sourceId);
  if(row.status!=='CREDIT_REVIEW'||row.supplier_id!==bill.supplier_id)throw new ValidationError('Choose a credit note from this supplier.');
  const document=await credits.readNote(db,ctx,row);
  if(normalize(document.originalInvoiceNumber)!==normalize(bill.supplier_invoice_number))throw new ValidationError('This credit note names a different invoice.');
  const {total,tax}=credits.amounts(document);
  const preview=await review.preview(scoped(db),ctx,billId);
  const explained=await require('./invoice-dispute-evidence').explain(db,ctx,bill,preview);
  const kinds=[...new Set(explained.differences.map(d=>d.kind))].sort(),format=minor=>money.format(minor,bill.currency);
  const books=(await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
  const today=await require('../lib/business-time').today(db,ctx.workspaceId);
  const hold=preview.status!=='DISPUTED'?'The invoice no longer differs from the purchase order. Recheck it.'
    :kinds.some(k=>!SETTLED_BY_CREDIT.has(k))?'A credit note cannot settle goods billed but not received, or an unclear difference. Ask the supplier for a corrected invoice.'
    :explained.disputedMinor==null?'The amount in question is unclear. Review this invoice yourself.'
    :document.currency!==bill.currency||bill.currency!==books?.base_currency?'The credit note or invoice is in another currency. Review the conversion yourself.'
    :document.issueDate>today?'The credit note is dated in the future.'
    :total<explained.disputedMinor?'The credit note covers '+format(total)+' of the '+format(explained.disputedMinor)+' in question. Ask the supplier for the rest.'
    :total>explained.disputedMinor?'The credit note is for more than the '+format(explained.disputedMinor)+' in question. Check it yourself.'
    :tax!==explained.taxOverMinor?'The credit note tax does not match the extra tax on the invoice.':null;
  return {bill,row,document,total,tax,kinds,disputedMinor:explained.disputedMinor,hold,
    fingerprint:hash({billId,revision:bill.review_revision,match:preview.matchFingerprint,sourceId:row.id,source:row.source_hash,
      sourceRevision:row.revision,total,tax,disputed:explained.disputedMinor})};
}

async function settle(database,ctx,billId,input) {
  return database.transaction(async db=>{
    await grant(db,ctx,{lock:true});
    await policy.requireWorkspaceJob(db,ctx.workspaceId,98,'draft');
    await policy.requireWorkspaceJob(db,ctx.workspaceId,105,'draft');
    const prior=(await db.query('SELECT credit_intake_id,result FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2 FOR UPDATE',
      [ctx.workspaceId,billId])).rows[0];
    if(prior?.credit_intake_id&&prior.credit_intake_id===input.sourceId)return {billId,supplierCreditId:prior.result?.supplierCreditId,replayed:true};
    await disputedBill(db,ctx.workspaceId,billId,{lock:true});
    const offer=await creditOffer(db,ctx,billId,String(input.sourceId||''));
    if(input.confirmed!=='yes'||input.fingerprint!==offer.fingerprint||offer.hold)throw new ValidationError(offer.hold||'Review the current credit note and confirm it.');
    const reason=String(input.reason||'').trim();
    if(!reason||reason.length>800)throw new ValidationError('Record the supplier evidence you reviewed, up to 800 characters.');
    await require('../commercial/storage-capacity').reserve(db,ctx.workspaceId,'invoice-dispute-credit:'+billId,Buffer.byteLength(reason)+8192,{finished:true});
    const review=require('./postgres-invoice-review'),credits=require('./agent-supplier-credit-notes');
    // 1. Accept the invoice as billed, because the credit note returns the difference.
    const first=await review.preview(scoped(db),ctx,billId);
    await db.query(`INSERT INTO stockchief_runtime.agent_supplier_invoice_charge_approvals(workspace_id,document_fingerprint,approved_by,reason,allow_price_difference,allow_charge_difference,allow_tracking_confirmation)
      VALUES($1,$2,$3,$4,$5,$6,false) ON CONFLICT(workspace_id,document_fingerprint) DO UPDATE SET
        allow_price_difference=agent_supplier_invoice_charge_approvals.allow_price_difference OR EXCLUDED.allow_price_difference,
        allow_charge_difference=agent_supplier_invoice_charge_approvals.allow_charge_difference OR EXCLUDED.allow_charge_difference`,
    [ctx.workspaceId,first.documentFingerprint,ctx.actorId,'Settled by supplier credit note '+offer.row.invoice_number+': '+reason,
      offer.kinds.includes('price_outside_approved_cost'),offer.kinds.some(k=>k!=='price_outside_approved_cost')]);
    const accepted=await review.preview(scoped(db),ctx,billId);
    if(accepted.status!=='OPEN')throw new ValidationError('The invoice still has a difference the credit note does not settle.');
    const posted=await review.execute(scoped(db),ctx,billId,{idempotencyKey:'invoice-dispute-credit:'+billId+':'+offer.row.id,
      reason:'Settled by supplier credit note '+offer.row.invoice_number+': '+reason,expectedBillRevision:Number(offer.bill.review_revision),
      expectedMatchFingerprint:accepted.matchFingerprint});
    if(posted.status!=='OPEN'||!posted.journalEntryId)throw new ValidationError('The invoice did not post. Nothing was changed.');
    // 2. Apply the credit note to it through supplier credit tracking (job 105).
    const authority='invoice-dispute:'+billId;
    const result=await credits.evaluate(db,ctx,offer.row,{lock:true,authority});
    if(result.status!=='READY'||result.candidate.billId!==billId||result.candidate.amount!==offer.total
        ||result.candidate.remainingAfter!==0||result.candidate.returnId)throw new ValidationError(result.problem||'The credit note could not be applied to this invoice exactly.');
    const booked=await credits.book(db,ctx,offer.row,result,{fingerprint:result.fingerprint,reason,authority});
    // 3. Record how the dispute ended.
    const work=(await db.query(`INSERT INTO stockchief_runtime.agent_invoice_dispute_work(id,workspace_id,bill_id,credit_intake_id,result)
      VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(bill_id) DO UPDATE SET credit_intake_id=EXCLUDED.credit_intake_id,result=EXCLUDED.result,
        attention=NULL,attention_at=NULL,next_check_at=NULL,checked_at=now() RETURNING intake_id`,
    ['invoice-dispute-bill:'+billId,ctx.workspaceId,billId,offer.row.id,JSON.stringify({status:'RESOLVED',resolution:'CREDIT',
      creditIntakeId:offer.row.id,supplierCreditId:booked.supplierCreditId,creditMinor:offer.total})])).rows[0];
    if(work?.intake_id)await db.query(`UPDATE stockchief_runtime.agent_supplier_invoice_intakes SET status='POSTED',bill_id=$3,problem=NULL,
      retry_after=NULL,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 AND bill_id IS NULL`,[ctx.workspaceId,work.intake_id,billId]);
    await audit.record(db,ctx,{action:'Supplier invoice dispute settled by credit note',reference:offer.bill.supplier_invoice_number||offer.bill.bill_number,
      after:{billId,creditNote:offer.row.invoice_number,creditIntakeId:offer.row.id,supplierCreditId:booked.supplierCreditId,
        creditMinor:offer.total,amountInQuestionMinor:offer.disputedMinor,currency:offer.bill.currency,reason}});
    return {billId,supplierCreditId:booked.supplierCreditId,journalEntryId:posted.journalEntryId,remainingMinor:booked.remainingMinor};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Runs with the routine: queues due reminders when StockChief may send them
// alone, and otherwise says what each open dispute waits for.
async function followUp(database,workspaceId,{eligible}) {
  if(!await has(database,'stockchief_runtime.agent_invoice_dispute_work','attention'))return {reminders:0};
  const account=await policy.accountState(database,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,100,'draft'))return {reminders:0};
  const bills=(await database.query(`SELECT b.id,b.supplier_id,b.supplier_invoice_number,w.replies_seen_at,w.attention
    FROM accounting_supplier_bills b LEFT JOIN stockchief_runtime.agent_invoice_dispute_work w ON w.workspace_id=b.workspace_id AND w.bill_id=b.id
    WHERE b.workspace_id=$1 AND b.status='DISPUTED' AND b.journal_entry_id IS NULL
      AND EXISTS(SELECT 1 FROM supplier_communications m WHERE m.workspace_id=b.workspace_id AND m.invoice_dispute_bill_id=b.id AND m.status='SENT')
    ORDER BY coalesce(w.attention_at,w.checked_at),b.id LIMIT 50`,[workspaceId])).rows;
  if(!bills.length)return {reminders:0};
  const plan=await schedulePolicy(database,workspaceId),day=await businessDay(database,workspaceId);
  const newer=(at,seen)=>Boolean(at)&&(!seen||new Date(at)>new Date(seen));
  let reminders=0;
  for(const bill of bills){
    const c=await conversation(database,workspaceId,bill);
    let text=null;
    if(c.credits.some(q=>newer(q.created_at,bill.replies_seen_at)))text='The supplier sent credit note '+c.credits[0].invoice_number+'. Check it against the dispute.';
    else if(c.replyCount&&newer(c.lastReplyAt,bill.replies_seen_at))text='The supplier replied. Read the reply and decide what to do next.';
    else if(!c.replyCount&&!c.credits.length&&c.first&&!c.pending&&Date.parse(c.lastSentAt)<=Date.now()-plan.reminderDays*86400000){
      if(c.remindersSent>=plan.reminderLimit)text='No reply after '+(c.remindersSent?c.remindersSent+' reminder'+(c.remindersSent===1?'':'s'):'the dispute')+'. Contact the supplier yourself.';
      else if(eligible){
        const job=await queue.enqueue(database,{workspaceId,kind:KIND,payload:{reminderBillId:bill.id,reminder:c.remindersSent+1},
          idempotencyKey:'reminder:'+bill.id+':'+(c.remindersSent+1)+':'+Math.floor(Date.now()/86400000),priority:55,maxAttempts:8});
        if(job.created)reminders++;
        continue;
      }else text='No reply since '+day(c.lastSentAt)+'. Send a reminder.';
    }
    if(text!==(bill.attention??null))await database.transaction(db=>attention(db,workspaceId,bill.id,text),{isolation:'READ COMMITTED'});
  }
  return {reminders};
}

async function reminderWorker(database,workspaceId,input) {
  return database.transaction(async db=>{
    const saved=(await db.query("SELECT updated_by FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=100 AND mode='routine'",[workspaceId])).rows[0];
    if(!saved)return {skipped:'no_routine_authority'};
    const ctx={workspaceId,actorId:saved.updated_by};
    let granted;
    try{granted=await grant(db,ctx,{automatic:true,lock:true});}
    catch(error){if(isReviewError(error))return {skipped:'no_current_authority'};throw error;}
    const bill=await disputedBill(db,workspaceId,String(input.reminderBillId),{lock:true});
    if(bill.status!=='DISPUTED'||bill.journal_entry_id)return {skipped:'settled'};
    const c=await conversation(db,workspaceId,bill);
    if(c.remindersSent+1!==Number(input.reminder))return {skipped:'reminder_changed'};
    await db.query('SAVEPOINT invoice_dispute_reminder');
    try{
      const result=await queueReminder(db,{...ctx,agentInvoiceDisputeScope:'automatic',invoiceDisputeRoutineRevision:granted.revision},bill,c,Number(input.reminder));
      await db.query('RELEASE SAVEPOINT invoice_dispute_reminder');
      return {status:result.status,billId:bill.id,communicationId:result.communicationId,reminder:result.reminder};
    }catch(error){
      if(!isReviewError(error))throw error;
      await db.query('ROLLBACK TO SAVEPOINT invoice_dispute_reminder');
      await db.query('RELEASE SAVEPOINT invoice_dispute_reminder');
      await attention(db,workspaceId,bill.id,'A reminder waits for you. '+error.message);
      return {status:'HELD',billId:bill.id,problem:error.message};
    }
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

// Needs you: disputes waiting for a person.
async function inbox(db,workspaceId) {
  if(!await has(db,'stockchief_runtime.agent_invoice_dispute_work','attention'))return [];
  const account=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,100,'draft'))return [];
  const rows=(await db.query(`SELECT w.bill_id,w.attention,w.result->>'problem' problem,coalesce(w.attention_at,w.checked_at) at,
      coalesce(b.supplier_invoice_number,b.bill_number) invoice,s.name supplier
    FROM stockchief_runtime.agent_invoice_dispute_work w
    JOIN accounting_supplier_bills b ON b.workspace_id=w.workspace_id AND b.id=w.bill_id
    JOIN suppliers s ON s.workspace_id=b.workspace_id AND s.id=b.supplier_id
    WHERE w.workspace_id=$1 AND b.status='DISPUTED' AND b.journal_entry_id IS NULL
      AND (w.attention IS NOT NULL OR w.result->>'status'='HELD' AND NOT EXISTS(SELECT 1 FROM supplier_communications m
        WHERE m.workspace_id=w.workspace_id AND m.invoice_dispute_bill_id=w.bill_id))
    ORDER BY coalesce(w.attention_at,w.checked_at),w.id LIMIT 20`,[workspaceId])).rows;
  return rows.map(r=>({kind:'accounting',importance:'Needs You',priority:66,
    title:'Invoice '+r.invoice+' from '+r.supplier+': dispute needs you',happened:r.attention||r.problem||'',
    why:'Disputes over your limit, with unclear evidence, or answered by the supplier wait for a person.',
    recommendation:r.attention?'Open the dispute and decide the next step.':'Check the differences and approve the dispute message.',
    href:'/autopilot/supplier-disputes/'+encodeURIComponent(r.bill_id),actionLabel:'Open dispute',sourceId:'invoice-dispute:'+r.bill_id,at:r.at,createdAt:r.at}));
}

async function page(database,ctx,billId,input={}) {
  await intake.owner(database,ctx);
  const state=await policy.requireWorkspaceJob(database,ctx.workspaceId,100,'draft');
  return database.transaction(async db=>{
    const bill=await require('./postgres-invoice-review').get(db,ctx,billId);
    const work=(await db.query('SELECT * FROM stockchief_runtime.agent_invoice_dispute_work WHERE workspace_id=$1 AND bill_id=$2',[ctx.workspaceId,billId])).rows[0];
    const c=await conversation(db,ctx.workspaceId,bill),message=c.messages.at(-1)||null;
    const pageNumber=Number(input.page||1);
    if(!Number.isSafeInteger(pageNumber)||pageNumber<1||pageNumber>1000000)throw new ValidationError('Choose a valid supplier reply page.');
    const threads=c.messages.filter(m=>m.verified&&m.external_thread_id).map(m=>m.id);
    const replies=threads.length?(await db.query(`SELECT DISTINCT r.id,r.subject,r.received_at,r.sender
      FROM connection_email_messages r JOIN supplier_communications m ON m.workspace_id=r.workspace_id AND m.connector_id=r.connector_id
        AND m.supplier_id=r.supplier_id AND m.external_thread_id=r.external_thread_id AND lower(m.recipient)=lower(r.sender)
      WHERE r.workspace_id=$1 AND m.id=ANY($2::text[]) AND r.trust_status='TRUSTED' AND r.classification='supplier'
        AND r.external_message_id<>m.external_message_id AND r.received_at::timestamptz>=m.sent_at::timestamptz
        AND lower(coalesce(r.subject,'')) !~ '(automatic reply|out of office|undeliverable|delivery failure)'
      ORDER BY r.received_at DESC,r.id LIMIT 51 OFFSET $3`,[ctx.workspaceId,threads,(pageNumber-1)*50])).rows:[];
    const visible=replies.slice(0,50);
    const sources=visible.length?(await db.query(`SELECT q.id,q.invoice_number,q.status,a.message_id,a.filename
      FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN connection_email_attachments a
        ON a.workspace_id=q.workspace_id AND a.id=q.attachment_id
      WHERE q.workspace_id=$1 AND a.message_id=ANY($2::text[]) AND q.document->>'documentType'='invoice'
      ORDER BY q.created_at DESC,q.id`,[ctx.workspaceId,visible.map(r=>r.id)])).rows:[];
    let selected=null,selectedCredit=null,explained=null;
    if(input.source&&bill.status==='DISPUTED'){
      try{selected=await correction(db,ctx,billId,String(input.source));}
      catch(error){if(!isReviewError(error))throw error;selected={hold:error.message};}
    }
    if(input.credit&&bill.status==='DISPUTED'){
      try{selectedCredit=await creditOffer(db,ctx,billId,String(input.credit));}
      catch(error){if(!isReviewError(error))throw error;selectedCredit={hold:error.message};}
    }
    if(bill.status==='DISPUTED'){
      try{explained=await require('./invoice-dispute-evidence').explain(db,ctx,bill,await require('./postgres-invoice-review').preview(scoped(db),ctx,billId));}
      catch(error){if(!isReviewError(error))throw error;}
    }
    const plan=await schedulePolicy(db,ctx.workspaceId),day=await businessDay(db,ctx.workspaceId);
    const newer=at=>Boolean(at)&&(!work?.replies_seen_at||new Date(at)>new Date(work.replies_seen_at));
    const reminder=bill.status==='DISPUTED'&&c.first?{next:c.remindersSent+1,sent:c.remindersSent,limit:plan.reminderLimit,
      lastSentOn:day(c.lastSentAt),dueOn:day(Date.parse(c.lastSentAt)+plan.reminderDays*86400000),
      canSend:!c.pending&&!c.replyCount&&!c.credits.length}:null;
    const blocked=await policy.stopped(db,ctx.workspaceId,state,ACTION,false);
    return {bill,work,message,messages:c.messages.map(m=>({...m,sentOn:m.sent_at?day(m.sent_at):null})),threadKnown:threads.length>0,
      replies:visible,sources,selected,selectedCredit,credits:c.credits,explained,reminder,
      unread:Boolean(c.replyCount&&newer(c.lastReplyAt)||c.credits.some(q=>newer(q.created_at))),
      saved:await rule(db,ctx.workspaceId),blocked,page:pageNumber,more:replies.length>50,
      mailboxes:await require('../connections/postgres-outbound-mail').mailboxes(db,ctx.workspaceId)};
  },{isolation:'REPEATABLE READ'});
}

module.exports={KIND,grant,prepare,worker,schedule,replyContext,correction,resolve,page,
  rule,ruleForm,configure,conversation,reminderDue,remind,markRead,creditOffer,settle,followUp,inbox};
