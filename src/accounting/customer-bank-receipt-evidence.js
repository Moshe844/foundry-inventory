'use strict';

const {ValidationError}=require('../domain/errors');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const draft=require('../autopilot/draft-authority');
const banking=require('./postgres-banking');
const {parse}=require('./bank-remittance');

const exactNumber=value=>String(value||'').trim().toLowerCase();
const receiptKey=id=>'agent-bank-receipt:'+id;

async function postedReceipt(db,ctx,bank,paymentId) {
  const row=(await db.query(`SELECT p.id,p.payment_number,p.customer_id,p.payment_date,p.journal_entry_id,
      EXISTS(SELECT 1 FROM accounting_journal_entries j WHERE j.workspace_id=p.workspace_id AND j.id=p.journal_entry_id AND j.status='POSTED'
        AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=j.workspace_id AND r.reversal_of_entry_id=j.id AND r.status='POSTED')) posted,
      (SELECT coalesce(sum(l.debit_minor-l.credit_minor),0) FROM accounting_journal_lines l
        WHERE l.workspace_id=p.workspace_id AND l.entry_id=p.journal_entry_id AND l.account_id=p.cash_account_id AND l.currency=p.currency) cash,
      (SELECT coalesce(sum(l.credit_minor-l.debit_minor),0) FROM accounting_journal_lines l JOIN accounting_accounts a
        ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.system_key='ACCOUNTS_RECEIVABLE'
        WHERE l.workspace_id=p.workspace_id AND l.entry_id=p.journal_entry_id AND l.customer_id=p.customer_id AND l.currency=p.currency) receivable,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('invoiceId',l.customer_invoice_id,'amountMinor',l.amount_minor)
        ORDER BY l.customer_invoice_id),'[]'::jsonb) FROM accounting_payment_allocations l WHERE l.workspace_id=p.workspace_id AND l.payment_id=p.id) allocations
    FROM accounting_payments p WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='POSTED'
      AND p.direction='CUSTOMER_RECEIPT' AND p.cash_account_id=$3 AND p.currency=$4 AND p.amount_minor=$5`,
  [ctx.workspaceId,paymentId,bank.ledger_account_id,bank.currency,bank.amount_minor])).rows[0];
  if(!row?.posted||Number(row.cash)!==Number(bank.amount_minor)||Number(row.receivable)!==Number(bank.amount_minor)
      ||money.sum(row.allocations.map(a=>money.integer(a.amountMinor)))!==Number(bank.amount_minor))return null;
  return {paymentId:row.id,paymentNumber:row.payment_number,journalEntryId:row.journal_entry_id,
    customerId:row.customer_id,paymentDate:row.payment_date,allocations:row.allocations};
}

function sameAllocations(allocations,requested) {
  return allocations.length===requested.length&&requested.every(target=>allocations.some(posted=>
    posted.invoiceId===target.invoiceId&&(target.amountMinor==null||Number(posted.amountMinor)===Number(target.amountMinor))));
}

async function invoiceRows(db,ctx,invoiceId,remittance,lock) {
  return (await db.query(`SELECT i.*,c.name AS customer_name,
    (EXISTS(SELECT 1 FROM accounting_journal_entries e WHERE e.workspace_id=i.workspace_id AND e.id=i.journal_entry_id AND e.status='POSTED'
      AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED')) OR
    i.source_key='sales-order:'||i.sales_order_id AND EXISTS(SELECT 1 FROM sales_order_lines l
      WHERE l.workspace_id=i.workspace_id AND l.sales_order_id=i.sales_order_id AND l.quantity_fulfilled>0)
    AND NOT EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=i.workspace_id AND l.sales_order_id=i.sales_order_id
      AND l.quantity_fulfilled<>(SELECT coalesce(sum((e.metadata::jsonb->>'quantity')::numeric),0) FROM accounting_journal_entries e
      WHERE e.workspace_id=l.workspace_id AND e.source_type='sale_fulfillment' AND e.source_record_type='sales_order'
        AND e.source_record_id=l.sales_order_id AND e.status='POSTED' AND e.metadata::jsonb->>'salesOrderLineId'=l.id
        AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries r WHERE r.workspace_id=e.workspace_id AND r.reversal_of_entry_id=e.id AND r.status='POSTED')))) posted_evidence
    FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id
    WHERE i.workspace_id=$1 AND ($3::text[] IS NULL AND i.id=$2 OR lower(i.invoice_number)=ANY($3::text[])) ORDER BY i.id`+
    (lock?' FOR UPDATE OF i':''),[ctx.workspaceId,invoiceId,remittance?.map(r=>exactNumber(r.invoiceNumber))||null])).rows;
}

async function earlierReceipt(db,ctx,bank,customer,targets) {
  const rows=(await db.query(`SELECT p.id,p.reference,p.source_key FROM accounting_payments p WHERE p.workspace_id=$1
      AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED' AND p.customer_id=$2 AND p.currency=$3
      AND p.amount_minor=$4
      AND EXISTS(SELECT 1 FROM accounting_payment_allocations a WHERE a.workspace_id=p.workspace_id AND a.payment_id=p.id
        AND a.customer_invoice_id=ANY($5::text[]))
      AND NOT EXISTS(SELECT 1 FROM accounting_bank_transactions t WHERE t.workspace_id=p.workspace_id AND t.matched_payment_id=p.id
        AND t.status IN('MATCHED','RECONCILED')) ORDER BY p.payment_date DESC,p.id LIMIT 2`,
  [ctx.workspaceId,customer,bank.currency,bank.amount_minor,targets.map(t=>t.invoiceId)])).rows;
  if(!rows.length)return null;
  const row=rows[0],proven=rows.length===1&&(row.source_key===receiptKey(bank.id)
    ||bank.external_id&&row.reference===bank.external_id);
  const receipt=proven?await postedReceipt(db,ctx,bank,row.id):null;
  if(!receipt||receipt.customerId!==customer||!sameAllocations(receipt.allocations,targets)) {
    throw new ValidationError('A recorded receipt may already cover this credit. Review the exact bank transaction and existing posting in Money.');
  }
  return receipt;
}

async function snapshot(db,ctx,invoiceId,bankId,lock=false) {
  const bank=await banking.receiptAccount(db,ctx.workspaceId,bankId,{lock});
  const amount=money.integer(bank.amount_minor,'Bank credit');
  if(bank.status==='UNMATCHED'&&bank.remittance_problem)throw new ValidationError('Review the original bank remittance. '+bank.remittance_problem);
  const reference=String(bank.reference||'').trim(),description=String(bank.description||'').trim();
  const remittance=bank.remittance||parse(reference,bank.currency);
  const invoices=await invoiceRows(db,ctx,invoiceId,remittance,lock);
  const primary=invoices.find(i=>i.id===invoiceId);
  if(!primary)throw new ValidationError('Choose an exact recorded bank credit and customer invoice from this inventory.');
  if(remittance&&remittance.some(ref=>invoices.filter(i=>exactNumber(i.invoice_number)===exactNumber(ref.invoiceNumber)).length!==1)) {
    throw new ValidationError('The named remittance invoices are missing or ambiguous. Compare the exact bank references.');
  }
  if(invoices.some(i=>i.customer_id!==primary.customer_id))throw new ValidationError('One customer receipt cannot be allocated to invoices of different customers.');
  if(invoices.some(i=>i.currency!==bank.currency))throw new ValidationError('The bank, invoice and books must use the same currency. Review any conversion first.');
  if(remittance){
    const bankReference=exactNumber(reference||description);
    if(bankReference&&!invoices.some(i=>exactNumber(i.invoice_number)===bankReference)
      &&(await db.query('SELECT 1 FROM accounting_customer_invoices WHERE workspace_id=$1 AND lower(invoice_number)=$2 LIMIT 1',
        [ctx.workspaceId,bankReference])).rowCount) {
      throw new ValidationError('The bank reference identifies a different invoice from this remittance. Review both originals.');
    }
  }
  const inputTargets=invoices.map(i=>({
    invoiceId:i.id,invoiceNumber:i.invoice_number,amountMinor:remittance
      ?remittance.find(r=>exactNumber(r.invoiceNumber)===exactNumber(i.invoice_number))?.amountMinor:null,
    balanceMinor:money.integer(i.balance_minor,'Invoice balance'),status:i.status,
    issueDate:i.issue_date,salesOrderId:i.sales_order_id||null,postedEvidence:i.posted_evidence,
  }));
  if(!remittance)inputTargets[0].amountMinor=amount;
  const proof=invoices.length>1?'exact-remittance-allocation':'exact-invoice-reference';
  const training=draft.scope(primary.customer_id,primary.currency,amount,
    {bankAccountId:bank.bank_account_id,cashAccountId:bank.ledger_account_id,proof},
    'Customer receipts · '+primary.customer_name+' · '+bank.bank_name);
  const common={recordId:primary.id,invoiceNumber:primary.invoice_number,customerName:primary.customer_name,customerId:primary.customer_id,
    salesOrderId:primary.sales_order_id,bankTransactionId:bank.id,bankName:bank.bank_name,bankAccountId:bank.bank_account_id,
    cashAccountId:bank.ledger_account_id,amountMinor:amount,currency:bank.currency,paymentDate:bank.transaction_date,
    expectedBalanceMinor:money.integer(primary.balance_minor),training};
  if(['MATCHED','RECONCILED'].includes(bank.status)){
    const prior=await postedReceipt(db,ctx,bank,bank.matched_payment_id);
    if(!prior||prior.customerId!==primary.customer_id||!sameAllocations(prior.allocations,inputTargets)){
      throw new ValidationError('This bank credit is already used by another payment or invoice. Review the existing match.');
    }
    return {...common,existing:{...prior,bankTransactionId:bank.id,invoiceId:primary.id,amountMinor:amount,replayed:true}};
  }
  if(bank.status!=='UNMATCHED'||invoices.some(i=>i.posted_evidence!==true))throw new ValidationError('Use an unmatched bank credit and an issued invoice with verified posting and an open balance.');
  if(invoices.some(i=>bank.transaction_date<i.issue_date))throw new ValidationError('This credit predates an invoice. Review it as a deposit before applying it.');
  if(bank.transaction_date>await require('../lib/business-time').today(db,ctx.workspaceId))throw new ValidationError('A future-dated bank credit cannot be treated as money already received. Review the statement date.');

  if(!remittance){
    const escaped=primary.invoice_number.replace(/[.*+?^{}()|[\]\\$]/g,'\\$&');
    if(reference&&exactNumber(reference)!==exactNumber(primary.invoice_number))throw new ValidationError('The bank reference differs from this invoice. Review the remittance first.');
    if(!reference&&!new RegExp('(?<![A-Za-z0-9])'+escaped+'(?![A-Za-z0-9])','i').test(description)){
      throw new ValidationError('The recorded bank evidence does not name this invoice. Review the original remittance before matching.');
    }
  }
  const alreadyPosted=await earlierReceipt(db,ctx,bank,primary.customer_id,inputTargets);
  const targets=inputTargets.map(target=>{
    const posted=alreadyPosted?.allocations.find(a=>a.invoiceId===target.invoiceId);
    const amountMinor=posted?.amountMinor??target.amountMinor??(inputTargets.length===1?amount:target.balanceMinor);
    if(!posted&&(!['OPEN','PARTIALLY_PAID'].includes(target.status)||!amountMinor))throw new ValidationError('The named invoice does not have an open balance.');
    if(!posted&&amountMinor>target.balanceMinor)throw new ValidationError('The bank credit exceeds this invoice balance. Review the remittance instead of forcing a match.');
    return {...target,amountMinor};
  });
  if(money.sum(targets.map(t=>money.integer(t.amountMinor)))!==amount)throw new ValidationError('The named invoice allocations do not uniquely exhaust this bank credit. Review the exact remittance amounts.');
  const known=(await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_payments WHERE workspace_id=$1 AND customer_id=$2
    AND direction='CUSTOMER_RECEIPT' AND status='POSTED') OR EXISTS(SELECT 1 FROM sales_orders o
      JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id
      WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0) known`,[ctx.workspaceId,primary.customer_id])).rows[0].known;
  const ambiguous=!remittance&&(await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE workspace_id=$1 AND lower(invoice_number)=lower($2)',
    [ctx.workspaceId,primary.invoice_number])).rows[0].n>1;
  const clearReference=Boolean(remittance)||exactNumber(reference||description)===exactNumber(primary.invoice_number);
  const needsPaymentConfirmation=!clearReference||!known||ambiguous;
  const fingerprint=hash({bank:{id:bank.id,account:bank.bank_account_id,amount,date:bank.transaction_date,hash:bank.content_hash,
    reference,description,currency:bank.currency,ledger:bank.ledger_account_id,verified:bank.receipt_verified_at,remittance,
    statement:bank.statement_id,statementHash:bank.statement_hash,row:bank.statement_row,
    remittanceId:bank.remittance_original_id,remittanceHash:bank.remittance_hash},targets,alreadyPosted,needsPaymentConfirmation});
  return {...common,allocations:targets,alreadyPosted,needsPaymentConfirmation,sourceFingerprint:fingerprint,
    statementId:bank.statement_id,statementRow:bank.statement_row,remittanceId:bank.remittance_original_id,
    paymentReference:targets.length===1?primary.invoice_number:bank.external_id||reference||description};
}

module.exports={snapshot,postedReceipt,sameAllocations,receiptKey};
