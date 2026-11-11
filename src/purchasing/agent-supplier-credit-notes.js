'use strict';

const { ValidationError, NotFoundError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');
const money = require('../domain/currency');
const { ratioMinor } = require('../domain/exact-quantity');
const { hash } = require('../pricing/postgres-promotions');
const { createHash } = require('node:crypto');
const { nowIso } = require('../lib/util');
const invoiceIntake = require('./agent-supplier-invoice-intake');
const creditLedger = require('../accounting/postgres-supplier-credits');
const queue = require('../operations/postgres-job-queue');
const JOB = 105;
const KIND = 'agent.supplier-credit-source';
const digest = value => createHash('sha256').update(value).digest('hex');
const scoped = client => ({ query: (...args) => client.query(...args), transaction: fn => fn(client) });
const normalize = value => String(value || '').trim().toLowerCase();
const listHref = '/autopilot/supplier-credits';
const detailHref = id => listHref + '/' + encodeURIComponent(id);

async function grant(db, ctx, { lock = false, managedReturnId = null } = {}) {
  if(managedReturnId){
    const returns=require('./supplier-return-evidence');
    await returns.access(db,ctx,{lock,stop:true});
    const tracked=await returns.lookup(db,ctx.workspaceId,managedReturnId);
    if(!returns.dispatchProof(tracked))throw new ValidationError('Confirm the tracked physical supplier handoff first.');
    return 'managed-supplier-return:'+managedReturnId;
  }
  if (lock) {
    await db.query('SELECT a.id FROM account_subscriptions a JOIN workspaces w ON w.owner_account_id=a.account_id WHERE w.id=$1 FOR SHARE OF a', [ctx.workspaceId]);
  }
  const account = await policy.requireWorkspaceJob(db, ctx.workspaceId, JOB, 'automatic');
  await invoiceIntake.owner(db, ctx, { lock });
  const mode = (await db.query(`SELECT m.revision,m.mode,m.updated_by,a.mode inventory_mode,a.paused,a.suspended
    FROM stockchief_runtime.agent_job_modes m JOIN workspace_autopilot a ON a.workspace_id=m.workspace_id
    WHERE m.workspace_id=$1 AND m.job_id=$2${lock ? ' FOR SHARE OF m,a' : ''}`, [ctx.workspaceId, JOB])).rows[0];
  const stop = await policy.stopped(db, ctx.workspaceId, account, 'supplier_credit.apply_note', true);
  if (stop) throw new ValidationError(stop);
  if (mode?.mode !== 'routine' || mode.updated_by !== ctx.actorId || mode.inventory_mode !== 'POLICY_AUTOMATED'
      || Number(mode.paused) || Number(mode.suspended)) {
    throw new ValidationError('The current owner must enable routine supplier credit tracking for this inventory.');
  }
  return mode.revision;
}

async function readNote(db, ctx, row) {
  const original = await invoiceIntake.source(db, ctx.workspaceId,
    row.source_upload_id ? { uploadId: row.source_upload_id } : row.attachment_id);
  if (original.content_hash !== row.source_hash || digest(original.extracted_text) !== row.source_text_hash
      || original.supplier_id !== row.supplier_id || original.trust_status !== 'TRUSTED') {
    throw new ValidationError('The original note or its verified supplier changed. Recheck the saved source.');
  }
  const scope = await require('../commercial/entitlements').ownerScopeForWorkspace(db, ctx.workspaceId);
  const paid = row.source_upload_id
    ? (await db.query(`SELECT 1 FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2
        AND meter='agent_documents' AND idempotency_key=$3 AND status='COMMITTED' AND units>=1`,
      [scope.accountId, ctx.workspaceId, require('./supplier-invoice-uploads').key(original)])).rowCount
    : (await require('../documents/source-read-receipts').readReceipts(db, scope, original.content_hash, { lock:false }))
      .some(receipt=>receipt.status==='COMMITTED');
  if (!paid) throw new ValidationError('This original has no completed document reading. Recheck it in Supplier invoices.');
  const confirmed = row.reviewed_by === ctx.actorId && row.document?.ownerConfirmedSource === row.source_hash;
  const parser = require('./supplier-invoice-source-parser');
  const document = confirmed ? row.document : parser.parse(original.extracted_text);
  if (document.documentType !== 'credit' || normalize(document.invoiceNumber) !== normalize(row.invoice_number)) {
    throw new ValidationError('This original does not identify the saved supplier credit note.');
  }
  if (original.connector_id) {
    const enabled = (await db.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_settings
      WHERE workspace_id=$1 AND enabled AND authorized_by=$2 AND $3=ANY(connector_ids) FOR SHARE`,
    [ctx.workspaceId, ctx.actorId, original.connector_id])).rows[0];
    if (!enabled || original.connection_status !== 'connected' || original.paused_at) {
      throw new ValidationError('Restore the authorized source mailbox or review the original through the manual accounting workflow.');
    }
  }
  return document;
}

function amounts(document) {
  const total = Math.abs(money.integer(document.total, 'Credit amount', { signed: true }));
  const tax = Math.abs(money.integer(document.tax, 'Credit tax', { signed: true }));
  if (!total || tax > total) throw new ValidationError('The original credit total and tax need confirmation.');
  return { total, tax };
}

function noteFingerprint(doc) {
  const { total, tax } = amounts(doc);
  return hash({ total, tax, taxStated: doc.taxStated === true, currency: doc.currency, date: doc.issueDate, bill: normalize(doc.originalInvoiceNumber),
    returnNumber: normalize(doc.supplierReturnReference), order: normalize(doc.purchaseOrder), rows: doc.rows, charges: doc.charges });
}

async function findBill(db, ctx, supplierId, reference, lock = false) {
  if (!reference) return null;
  const bills = (await db.query(`SELECT b.*,j.status journal_status,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') reversed
    FROM accounting_supplier_bills b LEFT JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id
    WHERE b.workspace_id=$1 AND b.supplier_id=$2 AND (b.id=$3 OR lower(btrim(b.supplier_invoice_number))=lower(btrim($3)) OR lower(b.bill_number)=lower($3))
      AND b.status IN('OPEN','PARTIALLY_PAID','PAID') ORDER BY b.id LIMIT 2${lock ? ' FOR UPDATE OF b' : ''}`,
  [ctx.workspaceId, supplierId, reference])).rows;
  return bills.length === 1 && bills[0].journal_status === 'POSTED' && !bills[0].reversed ? bills[0] : null;
}

async function findReturn(db, ctx, row, document, originalBill, { lock, posted, allowance }) {
  const known = posted.find(p => p.supplier_return_id)?.supplier_return_id || null;
  if (allowance && (known || document.supplierReturnReference)) {
    return { problem:'This credit identifies a physical supplier return. Review its return evidence.' };
  }
  if (allowance || (!known && posted.some(p => p.source_hash))) return {};
  const matches = (await db.query(`SELECT id,return_number,status,supplier_bill_id,expected_credit_minor,shipped_at,actual_credit_minor
    FROM supplier_returns WHERE workspace_id=$1 AND supplier_id=$2
      AND (CASE WHEN $5::text IS NOT NULL THEN id=$5 WHEN $3::text IS NOT NULL THEN lower(return_number)=lower($3) OR EXISTS(
        SELECT 1 FROM stockchief_runtime.agent_supplier_return_cases c WHERE c.workspace_id=$1 AND c.return_id=supplier_returns.id AND c.supplier_reference=lower(btrim($3))) ELSE supplier_bill_id=$4 END)
      AND status IN('REQUESTED','AUTHORIZED','AWAITING_CREDIT','RECONCILED','CREDIT_MISMATCH') ORDER BY id LIMIT 2${lock ? ' FOR UPDATE' : ''}`,
  [ctx.workspaceId, row.supplier_id, document.supplierReturnReference, originalBill.id, known])).rows;
  if (matches.length > 1) return { problem: 'Several supplier returns refer to this bill. Confirm the exact return reference in the source reading.' };
  if (!matches.length && (known || document.supplierReturnReference)) return { problem: 'The return named by the credit note is not recorded for this supplier.' };
  const match = matches[0];
  if (!match || !document.supplierReturnReference && ['RECONCILED','CREDIT_MISMATCH'].includes(match.status)) return {};
  if (match.supplier_bill_id !== originalBill.id || match.status !== 'AWAITING_CREDIT' || !match.shipped_at) {
    return { problem: 'The named supplier return has not been physically shipped against this original bill, or was already reconciled.' };
  }
  const proof=require('./supplier-return-evidence');
  const managed=await proof.lookup(db,ctx.workspaceId,match.id);
  let progress=null;
  if(managed){
    if(!proof.dispatchProof(managed)){
      return {problem:'The credit note needs the tracked return’s confirmed physical handoff.'};
    }
    if(document.issueDate<managed.dispatch.shippedOn)return {problem:'This credit predates the recorded physical return.'};
    progress=await require('./agent-supplier-returns').credited(db,ctx,managed);
    if(progress.problem)return {problem:progress.problem};
  }
  const otherNote = !managed&&(await db.query(`SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications
    WHERE workspace_id=$1 AND supplier_return_id=$2 AND source_hash IS DISTINCT FROM $3 LIMIT 1`,
  [ctx.workspaceId,match.id,row.source_hash])).rowCount;
  if (otherNote) return { problem:'A different sourced credit is already being applied to this physical return.' };
  const lines = (await db.query(`SELECT r.id,l.movement_ids::jsonb movements
    FROM supplier_returns r JOIN supplier_return_lines l ON l.workspace_id=r.workspace_id AND l.supplier_return_id=r.id
    WHERE r.workspace_id=$1 AND r.id=$2 ORDER BY l.id`,[ctx.workspaceId,match.id])).rows;
  const movementIds = lines.flatMap(l=>l.movements||[]);
  if (!lines.length || lines.some(l=>!l.movements?.length) || new Set(movementIds).size!==movementIds.length) {
    return { problem:'The original supplier return needs its recorded physical shipment before the credit can be applied.' };
  }
  const costs = (await db.query(`SELECT c.inventory_movement_id,c.cost_delta_minor,j.source_type,j.source_record_id,j.status,
    EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED') reversed
    FROM accounting_inventory_cost_movements c
    JOIN movements m ON m.workspace_id=c.workspace_id AND m.id=c.inventory_movement_id AND m.quantity_delta<0
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
    WHERE c.workspace_id=$1 AND c.inventory_movement_id=ANY($2::text[]) AND c.cost_source_type='supplier_return_shipment' AND c.cost_source_record_id=$3`,
  [ctx.workspaceId,movementIds,match.id])).rows;
  if (costs.length !== movementIds.length || costs.some(c=>c.reversed || Number(c.cost_delta_minor)>0
      || Number(c.cost_delta_minor)!==0 && (c.source_type!=='supplier_return_shipment' || c.source_record_id!==match.id || c.status!=='POSTED'))) {
    return { problem:'The return shipment and posted cost evidence no longer agree. Review the original return.' };
  }
  const returnCost = money.sum(costs.map(c=>-Number(c.cost_delta_minor)));
  if(managed&&(managed.dispatch.lines.map(l=>l.movementId).sort().join()!==[...movementIds].sort().join()
      ||money.sum(managed.dispatch.lines.map(l=>Number(l.costMinor)))!==returnCost)){
    return {problem:'The confirmed physical handoff no longer agrees with the posted return movement and cost.'};
  }
  return { match:{...match,returnCost,managed:Boolean(managed),progress} };
}

async function evaluate(db, ctx, row, { lock = false, targetReference = '', originalReference = '', authority = null, allowance = false } = {}) {
  const document = await readNote(db, ctx, row);
  const { total, tax } = amounts(document);
  const number = document.invoiceNumber.trim();
  if (!number || number.length > 80 || !row.supplier_id) throw new ValidationError('Confirm the supplier and its exact credit memo number.');
  const result = { number, total, tax, currency: document.currency, date: document.issueDate,
    originalReference: document.originalInvoiceNumber || originalReference || null, remaining: total, applied: 0, postings: [] };
  const waiting = (problem, status = 'WAITING') => ({ ...result, status, problem });
  const postingDate = await require('../lib/business-time').today(db, ctx.workspaceId);
  if (document.issueDate > postingDate) return waiting('The original credit note is dated in the future.');
  const books = (await db.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1', [ctx.workspaceId])).rows[0];
  if (books?.base_currency !== document.currency) return waiting('This note uses a different currency from the accounting books. Review its verified conversion.');
  if ((await db.query('SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications WHERE workspace_id=$1 AND source_hash=$2 AND lower(source_number)<>lower($3) LIMIT 1',[ctx.workspaceId,row.source_hash,number])).rowCount) {
    return waiting('This exact original was already booked under a different credit number. Review its posted application.', 'CONFLICT');
  }
  const posted = lock ? await creditLedger.lockIdentity(db, ctx.workspaceId, row.supplier_id, number)
    : await creditLedger.booked(db, ctx.workspaceId, row.supplier_id, number);
  const originals = (await db.query(`SELECT id,document,source_hash FROM stockchief_runtime.agent_supplier_invoice_intakes
    WHERE workspace_id=$1 AND supplier_id=$2 AND status='CREDIT_REVIEW' AND lower(btrim(invoice_number))=lower($3)
    ORDER BY created_at,id`, [ctx.workspaceId, row.supplier_id, number])).rows;
  const canonical = originals[0];
  const originId = posted.find(p => p.intake_id)?.intake_id || canonical?.id || row.id;
  if (originId !== row.id) {
    const same = canonical && noteFingerprint(canonical.document) === noteFingerprint(document);
    return { ...waiting(same ? 'This supplier credit note is already tracked from its first original.'
      : 'The supplier reused this credit number with different facts. Resolve the originals before applying it.', same ? 'DUPLICATE' : 'CONFLICT'), originId };
  }
  if (!posted.length && originals.some(source => source.id !== row.id && noteFingerprint(source.document) !== noteFingerprint(document))) {
    return waiting('More than one original uses this credit number with different facts. Review or stop the incorrect source before applying the credit.', 'CONFLICT');
  }
  let originalBill = await findBill(db, ctx, row.supplier_id, result.originalReference, lock);
  // A prior exact application may retain an owner-confirmed original reference.
  if (!originalBill && !result.originalReference && posted[0]?.evidence?.originalBillId) {
    originalBill = await findBill(db, ctx, row.supplier_id, posted[0].evidence.originalBillId, lock);
  }
  if (!originalBill) return waiting('Link the exact original posted supplier invoice before applying this credit.');
  result.originalBillId = originalBill.id;
  result.originalBillNumber = originalBill.bill_number;
  if (originalBill.currency !== document.currency) return waiting('The original bill and credit use different currencies.');
  if (document.issueDate < originalBill.issue_date) return waiting('The credit date precedes the original invoice. Check the exact dates.');
  if (document.purchaseOrder && !(await db.query('SELECT 1 FROM purchase_orders WHERE workspace_id=$1 AND id=$2 AND lower(po_number)=lower($3)',
    [ctx.workspaceId, originalBill.purchase_order_id, document.purchaseOrder])).rows.length) {
    return waiting('The credit note names a different purchase order from the original bill.');
  }
  if (posted.some(p => p.journal_status !== 'POSTED' || p.reversed || Number(p.amount_minor) !== Number(p.payable_minor)
      || p.currency !== document.currency || p.credit_date !== document.issueDate
      || (p.intake_id && p.intake_id !== row.id) || (p.source_hash && p.source_hash !== row.source_hash) || (p.tax_minor != null && Number(p.tax_minor) !== Number(p.ledger_tax_minor))
      || (p.return_cost_minor != null && Number(p.return_cost_minor) !== Number(p.ledger_return_cost_minor)))) {
    return waiting('A credit with this number has different or unreconciled accounting evidence. Review it before applying anything else.', 'CONFLICT');
  }
  const applied = money.sum(posted.map(p => Number(p.amount_minor)));
  result.applied = applied;
  result.remaining = Math.max(0, total - applied);
  result.postings = posted.map(p => ({ id: p.id, billId: p.supplier_bill_id, billNumber: p.bill_number,
    amount: Number(p.amount_minor), journalId: p.journal_entry_id }));
  if (applied > total || posted.some(p => !p.source_hash && (posted.length !== 1 || applied !== total || p.supplier_bill_id !== originalBill.id))) {
    return waiting('The same credit number already has a different manual application. Review the original accounting record.', 'CONFLICT');
  }
  if (applied === total) {
    if (document.supplierReturnReference && posted.some(p => !p.source_hash)) {
      const reference = (await db.query(`SELECT id FROM supplier_returns WHERE workspace_id=$1 AND supplier_id=$2
        AND lower(return_number)=lower($3) AND supplier_bill_id=$4`,
      [ctx.workspaceId,row.supplier_id,document.supplierReturnReference,originalBill.id])).rows;
      if (reference.length !== 1 || posted[0].journal_metadata?.supplierReturnId !== reference[0].id) {
        return waiting('The existing application links to a different physical return than the original note.', 'CONFLICT');
      }
    }
    if (document.taxStated && money.sum(posted.map(p=>Number(p.ledger_tax_minor))) !== tax) {
      return waiting('The existing application has different tax from the original note. Review its posted accounting.', 'CONFLICT');
    }
    return { ...result, status: 'APPLIED', problem: null };
  }
  if (!document.taxStated && Number(originalBill.tax_minor) > 0) return waiting('The taxed original bill needs the exact tax amount from the credit note. Confirm the source fields.');
  const priorTax = money.sum(posted.map(p => Number(p.tax_minor || 0)));
  const otherTax = Number((await db.query(`SELECT coalesce(sum(l.credit_minor-l.debit_minor),0) amount
    FROM accounting_supplier_credits c JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id AND j.status='POSTED'
    JOIN accounting_journal_lines l ON l.workspace_id=j.workspace_id AND l.entry_id=j.id
    JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='SALES_TAX_RECOVERABLE'
    LEFT JOIN stockchief_runtime.agent_supplier_credit_applications x ON x.workspace_id=c.workspace_id AND x.credit_id=c.id
    WHERE c.workspace_id=$1 AND c.supplier_id=$2 AND coalesce(x.evidence->>'originalBillId',c.supplier_bill_id)=$3
      AND lower(btrim(c.credit_number)) IS DISTINCT FROM lower($4)
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')`,
  [ctx.workspaceId, row.supplier_id, originalBill.id, number])).rows[0].amount);
  if (tax > Number(originalBill.tax_minor) - otherTax || priorTax > tax) return waiting('The credit tax exceeds the remaining original posted tax.');
  result.canChooseAllowance = !document.supplierReturnReference && posted.length === 0;
  const returned = await findReturn(db, ctx, row, document, originalBill, { lock, posted, allowance });
  if (returned.problem) return waiting(returned.problem);
  result.returnId = returned.match?.id || null;
  result.returnNumber = returned.match?.return_number || null;
  const targetBill = targetReference ? await findBill(db, ctx, row.supplier_id, targetReference, lock) : originalBill;
  if (!targetBill || targetBill.currency !== document.currency || !Number(targetBill.balance_minor) || targetBill.issue_date > postingDate) {
    return waiting('The original bill has no remaining balance. Review a different open bill for the same supplier and currency, or retain the unused credit.');
  }
  const amount = Math.min(result.remaining, Number(targetBill.balance_minor));
  const taxMinor = ratioMinor(tax, applied + amount, total) - priorTax;
  if (taxMinor < 0 || taxMinor > amount) return waiting('The remaining credit tax cannot be allocated exactly to this bill.');
  const returnRecord = returned.match;
  if (posted.some(p => (p.supplier_return_id || null) !== (returnRecord?.id || null))) {
    return waiting('The recorded physical return changed after an application. Review the original credit and shipment.', 'CONFLICT');
  }
  const progress=returnRecord?.progress;
  if(progress&&result.remaining>progress.remaining)return waiting('The exact supplier note exceeds the outstanding expected return credit. Review its original and amount.');
  const priorReturnCost = progress?progress.cost:money.sum(posted.map(p => Number(p.return_cost_minor || 0)));
  const returnCostMinor = returnRecord ? ratioMinor(returnRecord.returnCost,
    (progress?progress.amount:applied)+amount,progress?Number(returnRecord.expected_credit_minor):total)-priorReturnCost : null;
  if (returnCostMinor !== null && returnCostMinor < 0) return waiting('The posted credit already clears more than the verified return cost.', 'CONFLICT');
  const candidate = { billId: targetBill.id, billNumber: targetBill.bill_number, billBalance: Number(targetBill.balance_minor),
    amount, taxMinor, postingDate, balanceAfter: Number(targetBill.balance_minor) - amount, remainingAfter: result.remaining - amount,
    returnId: returnRecord?.id || null, returnNumber: returnRecord?.return_number || null, returnCost: returnRecord?.returnCost ?? null,
    returnCostMinor, managedReturn:Boolean(progress), cumulativeReturnCredit:progress?progress.amount+amount:null,
    remainingReturnCredit:progress?progress.remaining-amount:null, allowance: allowance && posted.length === 0,
    needsReturnConfirmation: Boolean(returnRecord && !document.supplierReturnReference && !posted.length),
    expectedCredit: returnRecord?.expected_credit_minor == null ? null : Number(returnRecord.expected_credit_minor) };
  return { ...result, status: 'READY', candidate, problem: null, fingerprint: hash({ authority, revision: row.revision,
    intakeId: row.id, hash: row.source_hash, document: noteFingerprint(document), originalBillId: originalBill.id,
    posted: result.postings, candidate }) };
}

async function storeWork(db, workspaceId, id, result) {
  await require('../commercial/storage-capacity').reserve(db, workspaceId, 'supplier-credit-work:' + id,
    Buffer.byteLength(JSON.stringify(result)) + 4096, { finished: true });
  await db.query(`INSERT INTO stockchief_runtime.agent_supplier_credit_work(intake_id,workspace_id,result,next_check_at)
    VALUES($1,$2,$3::jsonb,CASE WHEN $4 THEN NULL ELSE now()+interval '15 minutes' END) ON CONFLICT(intake_id) DO UPDATE
    SET result=EXCLUDED.result,checked_at=now(),next_check_at=EXCLUDED.next_check_at`, [id, workspaceId, JSON.stringify(result), result.status === 'APPLIED']);
}

async function worker(database, workspaceId, id) {
  return database.transaction(async db => {
    const owner = (await db.query('SELECT updated_by FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2', [workspaceId, JOB])).rows[0];
    if (!owner) return { skipped: 'no_routine_authority' };
    const ctx = { workspaceId, actorId: owner.updated_by };
    let authority;
    try { authority = await grant(db, ctx, { lock: true }); }
    catch (error) {
      if (['validation_error','entitlement_required','forbidden'].includes(error.code)) return { skipped: 'no_current_authority' };
      throw error;
    }
    const row = (await db.query(`SELECT * FROM stockchief_runtime.agent_supplier_invoice_intakes
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId,id])).rows[0];
    if (row?.status !== 'CREDIT_REVIEW') return { skipped: 'source_unavailable' };
    let result;
    try { result = await evaluate(db, ctx, row, { authority }); }
    catch (error) {
      if (!(error instanceof ValidationError) && !(error instanceof NotFoundError)) throw error;
      result = { status: 'WAITING', problem: error.message };
    }
    await storeWork(db, workspaceId, id, result);
    return { id, status: result.status, amountMinor: result.candidate?.amount || 0 };
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function approve(database, ctx, id, input) {
  return database.transaction(async db => {
    const managedReturnId=String(input.managedReturnId||'').trim()||null;
    const authority = await grant(db, ctx, { lock: true, managedReturnId });
    const row = await invoiceIntake.get(db, ctx, id, { lock: true });
    if (row.status !== 'CREDIT_REVIEW' || input.confirmed !== 'yes' || !/^[a-f0-9]{64}$/.test(input.fingerprint || '')) {
      throw new ValidationError('Confirm the exact original credit note and proposed bill application.');
    }
    const replay = (await db.query(`SELECT a.credit_id,c.supplier_bill_id,c.amount_minor,c.journal_entry_id,a.evidence FROM stockchief_runtime.agent_supplier_credit_applications a
      JOIN accounting_supplier_credits c ON c.workspace_id=a.workspace_id AND c.id=a.credit_id
      WHERE a.workspace_id=$1 AND a.intake_id=$2 AND a.approval_fingerprint=$3`,
    [ctx.workspaceId, id, input.fingerprint])).rows[0];
    if (replay) return { supplierCreditId: replay.credit_id, billId: replay.supplier_bill_id, amountMinor: Number(replay.amount_minor),
      journalEntryId: replay.journal_entry_id, balanceMinor: replay.evidence.candidate.balanceAfter,
      remainingMinor: replay.evidence.candidate.remainingAfter, replayed: true };
    const reason = String(input.reason || '').trim();
    if (!reason || reason.length > 1000) throw new ValidationError('Explain the supplier evidence you reviewed, up to 1000 characters.');
    const result = await evaluate(db, ctx, row, { lock: true, authority,
      targetReference: String(input.targetReference || '').trim(), originalReference: String(input.originalReference || '').trim(),
      allowance: input.allowance === 'yes' });
    if (result.status !== 'READY' || result.fingerprint !== input.fingerprint) {
      throw new ValidationError('The credit original, approval, or bill balance changed. Review the current comparison again.');
    }
    const candidate = result.candidate;
    if(candidate.managedReturn!==(managedReturnId!==null)||managedReturnId&&candidate.returnId!==managedReturnId){
      throw new ValidationError('Open and approve this credit from the tracked physical supplier return.');
    }
    if (candidate.billId !== result.originalBillId && input.confirmAlternate !== 'yes') {
      throw new ValidationError('Confirm the supplier allows applying the exact unused credit to this other bill.');
    }
    if (candidate.needsReturnConfirmation && input.confirmReturn !== 'yes') {
      throw new ValidationError('Confirm the supplier credit covers this exact physically shipped return.');
    }
    if (candidate.allowance && input.confirmAllowance !== 'yes') {
      throw new ValidationError('Confirm the supplier original identifies an allowance separate from a physical return.');
    }
    if (candidate.returnId && candidate.expectedCredit != null && candidate.expectedCredit !== result.total
        && input.confirmVariance !== 'yes') throw new ValidationError('Confirm the exact difference from the expected return credit.');
    const evidence = { originalBillId: result.originalBillId, targetBillId: candidate.billId, candidate, reason,
      number: result.number, date: result.date, currency: result.currency, sourceHash: row.source_hash, tax: result.tax,
      total: result.total, approvedBy: ctx.actorId };
    await require('../commercial/storage-capacity').reserve(db, ctx.workspaceId, 'supplier-credit-approval:' + input.fingerprint,
      Buffer.byteLength(JSON.stringify(evidence)) + 8192, { finished: true });
    const bill = await findBill(db, ctx, row.supplier_id, candidate.billId, true);
    const booked = await creditLedger.applySourceCredit(db, ctx, bill, { amountMinor: candidate.amount, taxMinor: candidate.taxMinor,
      creditNumber: result.number, creditDate: result.date, postingDate: candidate.postingDate, originalBillId: result.originalBillId,
      returnId: candidate.returnId, returnCostMinor: candidate.returnCostMinor,
      sourceHash: row.source_hash, sourceKey: 'agent-supplier-credit:' + input.fingerprint, reason });
    if(candidate.managedReturn){
      const complete=candidate.remainingReturnCredit===0;
      await db.query(`UPDATE supplier_returns SET actual_credit_minor=$3,supplier_credit_id=$4,status=$5,
        reconciled_at=CASE WHEN $5='RECONCILED' THEN $6 ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId,candidate.returnId,candidate.cumulativeReturnCredit,booked.supplierCreditId,complete?'RECONCILED':'AWAITING_CREDIT',nowIso()]);
    }else if (candidate.returnId && candidate.remainingAfter === 0) {
      const matches = candidate.expectedCredit == null || candidate.expectedCredit === result.total;
      await db.query(`UPDATE supplier_returns SET actual_credit_minor=$3,supplier_credit_id=$4,status=$5,
        reconciled_at=CASE WHEN $5='RECONCILED' THEN $6 ELSE NULL END WHERE workspace_id=$1 AND id=$2`,
      [ctx.workspaceId, candidate.returnId, result.total, booked.supplierCreditId, matches ? 'RECONCILED' : 'CREDIT_MISMATCH', nowIso()]);
    }
    if (candidate.returnId && candidate.remainingAfter > 0) {
      // Change the locked return row so a concurrent native reconciliation must see this application or retry.
      await db.query('UPDATE supplier_returns SET actual_credit_minor=$3 WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId, candidate.returnId, result.applied + candidate.amount]);
    }
    await db.query(`INSERT INTO stockchief_runtime.agent_supplier_credit_applications
      (credit_id,intake_id,workspace_id,source_hash,source_number,approval_fingerprint,tax_minor,evidence,supplier_return_id,return_cost_minor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`, [booked.supplierCreditId, id, ctx.workspaceId, row.source_hash,
      result.number, input.fingerprint, candidate.taxMinor, JSON.stringify(evidence), candidate.returnId, candidate.returnCostMinor]);
    await require('../operations/postgres-security-audit').record(db, ctx, { action: 'Supplier credit note applied', reference: result.number,
      after: { supplierCreditId: booked.supplierCreditId, sourceId: id, billId: candidate.billId, amountMinor: candidate.amount,
        balanceMinor: candidate.balanceAfter, unusedMinor: candidate.remainingAfter } });
    await storeWork(db, ctx.workspaceId, id, await evaluate(db, ctx, row, { authority }));
    return { ...booked, billId: candidate.billId, remainingMinor: candidate.remainingAfter };
  }, { isolation: 'SERIALIZABLE', retrySafe: true });
}

async function schedule(db, workspaceId) {
  const owner = (await db.query(`SELECT updated_by FROM stockchief_runtime.agent_job_modes
    WHERE workspace_id=$1 AND job_id=$2 AND mode='routine'`, [workspaceId, JOB])).rows[0];
  if (!owner) return { queued: 0 };
  try { await grant(db, { workspaceId, actorId: owner.updated_by }); }
  catch (error) {
    if (['validation_error','entitlement_required','forbidden'].includes(error.code)) return { queued: 0 };
    throw error;
  }
  const due = (await db.query(`SELECT q.id,q.revision FROM stockchief_runtime.agent_supplier_invoice_intakes q
    LEFT JOIN stockchief_runtime.agent_supplier_credit_work w ON w.workspace_id=q.workspace_id AND w.intake_id=q.id
    WHERE q.workspace_id=$1 AND q.status='CREDIT_REVIEW' AND (w.intake_id IS NULL OR w.next_check_at<=now())
    ORDER BY w.next_check_at NULLS FIRST,q.created_at,q.id LIMIT 50`, [workspaceId])).rows;
  let queued = 0;
  for (const row of due) {
    const job = await queue.enqueue(db.transaction ? db : scoped(db), { workspaceId, kind: KIND,
      payload: { intakeId: row.id }, idempotencyKey: `recheck:${row.id}:${row.revision}:${Math.floor(Date.now()/900000)}`,
      priority: 60, maxAttempts: 8 });
    if (job.created) queued++;
  }
  return { queued };
}

async function readPage(db, ctx, { filter = '', page = 1, adviceOnly = false } = {}) {
  await invoiceIntake.owner(db, ctx);
  const account = await policy.requireWorkspaceJob(db, ctx.workspaceId, JOB, 'suggest');
  const one = adviceOnly || account.plan === 'growth';
  const rows = (await db.query(`WITH credits AS (
    SELECT s.name supplier,q.invoice_number reference,
      coalesce(w.result->>'status','UNCHECKED') state,w.result->>'problem' problem,
      abs((q.document->>'total')::bigint) amount,
      coalesce((w.result->>'remaining')::bigint,abs((q.document->>'total')::bigint)) remaining,
      q.document->>'currency' currency,coalesce(w.result->'candidate'->>'billNumber',w.result->>'originalBillNumber',q.document->>'originalInvoiceNumber') bill,
      q.created_at recorded,'/autopilot/supplier-credits/'||q.id link,
      CASE w.result->>'status' WHEN 'APPLIED' THEN 4 WHEN 'DUPLICATE' THEN 5 ELSE 1 END priority
    FROM stockchief_runtime.agent_supplier_invoice_intakes q
    JOIN suppliers s ON s.workspace_id=q.workspace_id AND s.id=q.supplier_id
    LEFT JOIN stockchief_runtime.agent_supplier_credit_work w ON w.workspace_id=q.workspace_id AND w.intake_id=q.id
    WHERE q.workspace_id=$1 AND q.status='CREDIT_REVIEW'
    UNION ALL
    SELECT s.name,r.return_number,'AWAITING_NOTE',NULL,r.expected_credit_minor,NULL,b.currency,b.bill_number,r.shipped_at::timestamptz,'/supplier-returns/'||r.id,2
    FROM supplier_returns r JOIN suppliers s ON s.workspace_id=r.workspace_id AND s.id=r.supplier_id
    LEFT JOIN accounting_supplier_bills b ON b.workspace_id=r.workspace_id AND b.id=r.supplier_bill_id
    WHERE r.workspace_id=$1 AND r.status='AWAITING_CREDIT' AND NOT EXISTS(
      SELECT 1 FROM stockchief_runtime.agent_supplier_invoice_intakes q JOIN stockchief_runtime.agent_supplier_credit_work w ON w.intake_id=q.id AND w.workspace_id=q.workspace_id
      WHERE q.workspace_id=r.workspace_id AND q.status='CREDIT_REVIEW' AND w.result->>'returnId'=r.id)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications a
        WHERE a.workspace_id=r.workspace_id AND a.supplier_return_id=r.id AND a.intake_id IS NOT NULL)
    UNION ALL
    SELECT s.name,coalesce(c.credit_number,'Unnumbered credit'),CASE WHEN j.status='POSTED' AND NOT EXISTS(
      SELECT 1 FROM accounting_journal_entries x WHERE x.workspace_id=c.workspace_id AND x.reversal_of_entry_id=c.journal_entry_id AND x.status='POSTED')
      THEN 'MANUAL_APPLIED' ELSE 'BOOKS_CHANGED' END,NULL,c.amount_minor,NULL,b.currency,b.bill_number,c.created_at::timestamptz,'/money/bills/'||b.id,4
    FROM accounting_supplier_credits c JOIN suppliers s ON s.workspace_id=c.workspace_id AND s.id=c.supplier_id
    JOIN accounting_supplier_bills b ON b.workspace_id=c.workspace_id AND b.id=c.supplier_bill_id
    LEFT JOIN accounting_journal_entries j ON j.workspace_id=c.workspace_id AND j.id=c.journal_entry_id
    WHERE c.workspace_id=$1 AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_applications a WHERE a.workspace_id=c.workspace_id AND a.credit_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_supplier_credit_work w WHERE w.workspace_id=c.workspace_id AND w.result->'postings' @> jsonb_build_array(jsonb_build_object('id',c.id)))
    ) SELECT * FROM credits WHERE $2='' OR lower(supplier)=lower($2) OR lower(reference)=lower($2) OR lower(bill)=lower($2)
    ORDER BY priority,recorded DESC,reference,link LIMIT $3 OFFSET $4`, [ctx.workspaceId,filter,one?1:101,one?0:(page-1)*100])).rows;
  const labels = { UNCHECKED:'Original received. Check the exact invoice and available credit.',
    READY:'Ready for owner approval', WAITING:'Needs follow-up', APPLIED:'Fully applied to posted bills',
    DUPLICATE:'Original already tracked', CONFLICT:'Conflicting original or application',
    AWAITING_NOTE:'Awaiting credit', MANUAL_APPLIED:'Applied to bill', BOOKS_CHANGED:'Review changed accounting evidence' };
  return { rows: rows.slice(0,100).map(row => ({ Supplier: row.supplier, 'Credit or return': row.reference,
    Status: row.problem || labels[row.state], Amount: row.amount == null || !row.currency ? null : money.format(row.amount,row.currency),
    Remaining: row.remaining == null || !row.currency ? null : money.format(row.remaining,row.currency), Bill: row.bill, link: row.link })),
  more: rows.length>100, summary: one?'One supplier credit or return to review. Growth suggestions do not prepare or apply credits.'
    :'Track supplier-issued credits through exact posted bill applications and follow up on shipped returns still awaiting a note.' };
}

async function page(database, ctx, input = {}) {
  const account = await policy.requireWorkspaceJob(database, ctx.workspaceId, JOB, 'suggest');
  const number = Number(input.page || 1);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1000000) throw new ValidationError('Choose a valid credit results page.');
  const filter = String(input.filter || '').trim();
  if (filter.length > 150) throw new ValidationError('Use an exact credit number, invoice number or supplier name.');
  const report = await readPage(database, ctx, { filter, page: number });
  const suggestion = account.plan === 'growth';
  if (!input.id || suggestion) return { ...report, suggestion, selected: null, filter, page: suggestion?1:number };
  const targetReference = String(input.targetReference || '').trim(), originalReference = String(input.originalReference || '').trim();
  const allowance = input.allowance === 'yes',managedReturnId=String(input.managedReturnId||'').trim()||null;
  if (targetReference.length > 150 || originalReference.length > 150) throw new ValidationError('Use an exact original or target bill reference.');
  const selected = await database.transaction(async db => {
    const row = await invoiceIntake.get(db, ctx, input.id);
    if (row.status !== 'CREDIT_REVIEW') throw new NotFoundError('This source is not a current supplier credit note.');
    let authority = null, hold;
    try { authority = await grant(db, ctx, {managedReturnId}); }
    catch (error) {
      if (!['validation_error','entitlement_required','forbidden'].includes(error.code)) throw error;
      hold = error.message;
    }
    let facts;
    try { facts = await evaluate(db, ctx, row, { targetReference, originalReference, authority, allowance }); }
    catch (error) {
      if (!(error instanceof ValidationError) && !(error instanceof NotFoundError)) throw error;
      facts = { status:'WAITING',problem:error.message,number:row.invoice_number,postings:[] };
    }
    if(facts.candidate?.managedReturn&&facts.candidate.returnId!==managedReturnId){
      hold='Open the exact credit from the tracked supplier return before approving it.';
    }else if(managedReturnId&&facts.status==='READY'&&facts.candidate?.returnId!==managedReturnId){
      hold='This credit identifies a different original supplier return.';
    }
    const alternatives = facts.originalBillId && facts.remaining > 0 && !hold && !['CONFLICT','DUPLICATE'].includes(facts.status)
      ? (await db.query(`SELECT b.bill_number,b.balance_minor FROM accounting_supplier_bills b
          JOIN accounting_journal_entries j ON j.workspace_id=b.workspace_id AND j.id=b.journal_entry_id AND j.status='POSTED'
          WHERE b.workspace_id=$1 AND b.supplier_id=$2 AND b.currency=$3 AND b.id<>$4 AND b.balance_minor>0
            AND b.status IN('OPEN','PARTIALLY_PAID') AND b.issue_date<=$5
            AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id
              AND r.reversal_of_entry_id=j.id AND r.status='POSTED')
          ORDER BY b.due_date NULLS LAST,b.id LIMIT 10`,
        [ctx.workspaceId,row.supplier_id,facts.currency,facts.originalBillId,await require('../lib/business-time').today(db,ctx.workspaceId)])).rows
      : [];
    return { id:row.id, sourceHref:'/autopilot/supplier-invoices/'+encodeURIComponent(row.id),
      facts, hold, targetReference, originalReference, alternatives, allowance, managedReturnId };
  }, { isolation:'REPEATABLE READ' });
  return { ...report, suggestion, selected, filter, page:number };
}

function notices(row) {
  if (!Number(row?.n) && !Number(row?.awaiting)) return [];
  const title = Number(row.n) ? Number(row.n)+' supplier credit '+(Number(row.n)===1?'note needs':'notes need')+' review'
    : Number(row.awaiting)+' shipped supplier '+(Number(row.awaiting)===1?'return is':'returns are')+' waiting for credit';
  return [{ kind:'accounting', importance:'Needs You', priority:67, sourceId:'supplier-credit-notes',
    title, happened:Number(row.n)?'Supplier credit notes were checked against original bills and earlier applications.'
      :'The physical supplier return is recorded. Review the supplier credit note when it arrives.',
    why:Number(row.n)?'Review the source or approve the exact application to use the available credit.'
      :'The supplier has not provided a matched credit note.',
    actionLabel:'Review supplier credits', href:listHref, at:row.created_at, createdAt:row.created_at }];
}

const definition = { id:JOB, key:'supplier-credits', label:'Track and use supplier credit notes',
  filterLabel:'Supplier, credit memo, return or bill number', readPage };
module.exports = { JOB, KIND, evaluate, worker, approve, grant, detailHref, listHref, definition, page, schedule, notices };
