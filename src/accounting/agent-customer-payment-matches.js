'use strict';
const {ValidationError,AuthorizationError}=require('../domain/errors'),policy=require('../commercial/agent-plan'),money=require('../domain/currency'),{hash}=require('../pricing/postgres-promotions'),draft=require('../autopilot/draft-authority');
const action='customer_payment.match_bank_line',key=id=>'agent-bank-receipt:'+id,scoped=c=>({query:(...a)=>c.query(...a),transaction:fn=>fn(c)});
async function owner(db,ctx){if(!(await db.query("SELECT 1 FROM users WHERE workspace_id=$1 AND id=$2 AND role='owner'",[ctx.workspaceId,ctx.actorId])).rowCount)throw new AuthorizationError('Only the inventory owner can match customer bank receipts.');}
async function snapshot(db,ctx,invoiceId,bankId,lock=false){
 const b=(await db.query(`SELECT t.*,b.name AS bank_name,b.active AS bank_active,b.account_kind,b.currency,b.ledger_account_id,a.base_currency,
  (SELECT id FROM accounting_accounts WHERE workspace_id=t.workspace_id AND system_key='CASH') AS cash_account_id
  FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id
  JOIN accounting_settings a ON a.workspace_id=t.workspace_id AND a.enabled=1 WHERE t.workspace_id=$1 AND t.id=$2`+(lock?' FOR UPDATE OF t FOR SHARE OF b':''),[ctx.workspaceId,bankId])).rows[0];
 const i=(await db.query(`SELECT i.*,c.name AS customer_name,
  (EXISTS(SELECT 1 FROM accounting_journal_entries e WHERE e.workspace_id=i.workspace_id AND e.id=i.journal_entry_id AND e.status='POSTED') OR
   i.source_key='sales-order:'||i.sales_order_id AND EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=i.workspace_id AND l.sales_order_id=i.sales_order_id AND l.quantity_fulfilled>0)
   AND NOT EXISTS(SELECT 1 FROM sales_order_lines l WHERE l.workspace_id=i.workspace_id AND l.sales_order_id=i.sales_order_id AND l.quantity_fulfilled<>(SELECT coalesce(sum((e.metadata::jsonb->>'quantity')::numeric),0) FROM accounting_journal_entries e WHERE e.workspace_id=l.workspace_id AND e.source_type='sale_fulfillment' AND e.source_record_type='sales_order' AND e.source_record_id=l.sales_order_id AND e.status='POSTED' AND e.metadata::jsonb->>'salesOrderLineId'=l.id))) AS posted_evidence
  FROM accounting_customer_invoices i JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE i.workspace_id=$1 AND i.id=$2`+(lock?' FOR UPDATE OF i':''),[ctx.workspaceId,invoiceId])).rows[0];
 if(!b||!i)throw new ValidationError('Choose an exact recorded bank credit and customer invoice from this inventory.');
 const amount=money.integer(b.amount_minor,'Bank credit',{signed:true});
 if(amount<=0||b.account_kind!=='BANK'||Number(b.bank_active)!==1)throw new ValidationError('Use an incoming credit on an active bank account. Refunds and card statement lines need their own review.');
 if(b.currency!==i.currency||b.currency!==b.base_currency)throw new ValidationError('The bank, invoice and books must use the same currency. Review any conversion first.');
 if(b.ledger_account_id!==b.cash_account_id)throw new ValidationError('This bank account uses a different ledger account. Review its receipt posting in Money before automatic matching.');
 const training=draft.scope(i.customer_id,i.currency,amount,{bankAccountId:b.bank_account_id,cashAccountId:b.cash_account_id,proof:'exact-invoice-reference'},'Customer receipts · '+i.customer_name+' · '+b.bank_name);
 if(['MATCHED','RECONCILED'].includes(b.status)){
  const prior=(await db.query(`SELECT p.id AS "paymentId",p.payment_number AS "paymentNumber",a.amount_minor FROM accounting_payments p JOIN accounting_payment_allocations a ON a.workspace_id=p.workspace_id AND a.payment_id=p.id WHERE p.workspace_id=$1 AND p.id=$2 AND p.direction='CUSTOMER_RECEIPT' AND p.status='POSTED' AND p.currency=$3 AND p.cash_account_id=$4 AND a.customer_invoice_id=$5 AND a.amount_minor=$6`,[ctx.workspaceId,b.matched_payment_id,i.currency,b.cash_account_id,i.id,amount])).rows[0];
  if(!prior)throw new ValidationError('This bank credit is already used by another payment or invoice. Review the existing match.');
  return {recordId:i.id,invoiceNumber:i.invoice_number,bankTransactionId:b.id,bankName:b.bank_name,customerName:i.customer_name,amountMinor:amount,currency:i.currency,training,existing:{paymentId:prior.paymentId,paymentNumber:prior.paymentNumber,bankTransactionId:b.id,invoiceId:i.id,amountMinor:amount,replayed:true}};
 }
 if(b.status!=='UNMATCHED'||!['OPEN','PARTIALLY_PAID'].includes(i.status)||i.posted_evidence!==true)throw new ValidationError('Use an unmatched bank credit and an issued invoice with verified posting and an open balance.');
 const balance=money.integer(i.balance_minor,'Invoice balance');if(amount>balance)throw new ValidationError('The bank credit exceeds this invoice balance. Review overpayments or split remittances instead of forcing a match.');
 if(b.transaction_date<i.issue_date)throw new ValidationError('This credit predates the invoice. Review it as a deposit before applying it.');
 if(b.transaction_date>await require('../lib/business-time').today(db,ctx.workspaceId))throw new ValidationError('A future-dated bank credit cannot be treated as money already received. Review the statement date.');
 const reference=String(b.reference||'').trim(),description=String(b.description||'').trim(),escaped=i.invoice_number.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 if(reference&&reference.toLowerCase()!==i.invoice_number.toLowerCase())throw new ValidationError('The bank reference differs from this invoice. Review the remittance first.');
 if(!reference&&!new RegExp('(?<![A-Za-z0-9])'+escaped+'(?![A-Za-z0-9])','i').test(description))throw new ValidationError('The recorded bank evidence does not name this invoice. Review the original remittance before matching.');
 const known=(await db.query(`SELECT EXISTS(SELECT 1 FROM accounting_payments WHERE workspace_id=$1 AND customer_id=$2 AND direction='CUSTOMER_RECEIPT' AND status='POSTED') OR EXISTS(SELECT 1 FROM sales_orders o JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.customer_id=$2 AND l.quantity_fulfilled>0) AS known`,[ctx.workspaceId,i.customer_id])).rows[0].known;
 const clearReference=(reference||description).toLowerCase()===i.invoice_number.toLowerCase(),ambiguous=(await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE workspace_id=$1 AND lower(invoice_number)=lower($2)',[ctx.workspaceId,i.invoice_number])).rows[0].n>1,needsPaymentConfirmation=!clearReference||!known||ambiguous;
 const state={bank:{id:b.id,account:b.bank_account_id,amount,date:b.transaction_date,hash:b.content_hash,reference,description,currency:b.currency,ledger:b.ledger_account_id},invoice:{id:i.id,customer:i.customer_id,currency:i.currency,status:i.status,balance,issueDate:i.issue_date,salesOrder:i.sales_order_id},needsPaymentConfirmation};
 return {recordId:i.id,invoiceNumber:i.invoice_number,customerName:i.customer_name,customerId:i.customer_id,salesOrderId:i.sales_order_id,bankTransactionId:b.id,bankName:b.bank_name,bankAccountId:b.bank_account_id,amountMinor:amount,currency:i.currency,paymentDate:b.transaction_date,expectedBalanceMinor:balance,needsPaymentConfirmation,sourceFingerprint:hash(state),training};
}
async function build(db,ctx,row,args){
 await owner(db,ctx);await policy.requireWorkspaceJob(db,ctx.workspaceId,103,'draft');const p=await snapshot(db,ctx,row.id,args.bankTransaction);
 return {payload:p,summary:p.existing?'This bank credit is already matched to '+p.invoiceNumber+'. Repeating it adds no payment.':'Match the recorded '+money.format(p.amountMinor,p.currency)+' credit at '+p.bankName+' to invoice '+p.invoiceNumber+' for '+p.customerName+'. Record the received money and reduce the invoice balance together.'+(p.needsPaymentConfirmation?' Confirm this first customer receipt or the unclear remittance reference.':' The bank reference identifies this invoice.')+' No charge, supplier payment or refund is sent.'};
}
async function execute(db,ctx,p){
 await owner(db,ctx);const automatic=ctx.agentPaymentScope==='automatic',account=await policy.requireWorkspaceJob(db,ctx.workspaceId,103,'draft');
 if(automatic){const trained=await draft.trained(db,ctx.workspaceId,action,p);policy.requireJob(account.plan,103,'automatic',{trained});const hold=await policy.stopped(db,ctx.workspaceId,account,action,true,p);if(hold)throw new ValidationError(hold);}
 const fresh=await snapshot(db,ctx,p.recordId,p.bankTransactionId,true);if(fresh.existing)return fresh.existing;
 if(fresh.sourceFingerprint!==p.sourceFingerprint||hash(fresh.training)!==hash(p.training))throw new ValidationError('The bank credit or invoice changed after review. Prepare a fresh match.');
 if(automatic){if(fresh.needsPaymentConfirmation)throw new ValidationError('This receipt needs its own confirmation.');const rule=(await db.query(`SELECT r.maximum_minor FROM stockchief_runtime.agent_draft_rules r JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner' WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3 AND r.currency=$4 FOR SHARE OF r,u`,[ctx.workspaceId,action,p.training.key,p.currency])).rows[0];if(rule&&p.amountMinor>Number(rule.maximum_minor))throw new ValidationError('The bank credit exceeds the owner’s receipt limit. Approve it individually.');}
 const result=await require('../operations/postgres-business-workflows').recordCustomerPayment(scoped(db),ctx,{customerId:fresh.customerId,customerInvoiceId:p.recordId,salesOrderId:fresh.salesOrderId,amountMinor:fresh.amountMinor,currency:fresh.currency,paymentDate:fresh.paymentDate,method:'BANK_TRANSFER',reference:fresh.invoiceNumber,sourceKey:key(fresh.bankTransactionId),idempotencyKey:key(fresh.bankTransactionId)});
 await require('./postgres-banking').match(scoped(db),ctx,p.bankTransactionId,'payment:'+result.paymentId);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer bank receipt matched',reference:p.bankTransactionId,after:{invoice:p.invoiceNumber,bank:p.bankName,amount:money.format(p.amountMinor,p.currency),payment:result.paymentNumber}});
 return {...result,bankTransactionId:p.bankTransactionId,invoiceId:p.recordId,href:'/money/invoices/'+p.recordId};
}
async function verify(db,ctx,r,p){return Boolean(r.paymentId&&(await db.query(`SELECT 1 FROM accounting_bank_transactions t JOIN accounting_payment_allocations a ON a.workspace_id=t.workspace_id AND a.payment_id=t.matched_payment_id WHERE t.workspace_id=$1 AND t.id=$2 AND t.status IN ('MATCHED','RECONCILED') AND t.matched_payment_id=$3 AND a.customer_invoice_id=$4 AND a.amount_minor=$5`,[ctx.workspaceId,p.bankTransactionId,r.paymentId,p.recordId,p.amountMinor])).rowCount);}
async function review(db,ctx,{page=1,filter=''}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId),offset=(page-1)*100,today=await require('../lib/business-time').today(db,ctx.workspaceId);
 const [completed,pending]=await Promise.all([
  db.query(`SELECT i.invoice_number AS "Invoice",c.name AS "Customer",b.name AS "Bank",a.amount_minor,p.currency,t.transaction_date AS "Received on",'/money/invoices/'||i.id AS link FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id JOIN accounting_payments p ON p.workspace_id=t.workspace_id AND p.id=t.matched_payment_id AND p.source_key='agent-bank-receipt:'||t.id JOIN accounting_payment_allocations a ON a.workspace_id=p.workspace_id AND a.payment_id=p.id JOIN accounting_customer_invoices i ON i.workspace_id=a.workspace_id AND i.id=a.customer_invoice_id JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE t.workspace_id=$1 AND t.status IN ('MATCHED','RECONCILED') AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)) AND ($3::timestamptz IS NULL OR t.matched_at::timestamptz>=$3::timestamptz) ORDER BY t.matched_at DESC,t.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,history.activityAfter,offset]),
  db.query(`SELECT t.id AS "bankTransaction",i.invoice_number AS "invoiceNumber",c.name AS "customerName",b.name AS "bankName",t.amount_minor,b.currency FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id JOIN accounting_settings s ON s.workspace_id=t.workspace_id AND s.enabled=1 AND s.base_currency=b.currency JOIN accounting_customer_invoices i ON i.workspace_id=t.workspace_id AND lower(i.invoice_number)=lower(coalesce(nullif(trim(t.reference),''),trim(t.description))) AND i.currency=b.currency AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>=t.amount_minor JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE t.workspace_id=$1 AND t.status='UNMATCHED' AND t.amount_minor>0 AND t.transaction_date>=i.issue_date AND t.transaction_date<=$4 AND b.active=1 AND b.account_kind='BANK' AND b.ledger_account_id=(SELECT id FROM accounting_accounts WHERE workspace_id=t.workspace_id AND system_key='CASH') AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)) ORDER BY t.transaction_date,t.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,offset,today])
 ]);
 const account=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,account,action,false);
 const rows=completed.rows.slice(0,100).map(r=>{const {amount_minor,currency,...row}=r;return {...row,Amount:money.format(amount_minor,currency)};});
 return {rows,more:completed.rows.length>100||pending.rows.length>100,summary:'Match recorded incoming bank credits to their issued invoices. Preparing a match posts nothing. First customers, uncertain references and owner limits require individual confirmation; stock and outgoing money stay unchanged.',bankMatchForm:{blocked,entries:pending.rows.slice(0,100).map(r=>({...r,amount:money.format(r.amount_minor,r.currency)}))}};
}
async function requireRoutineAuthority(db,ctx){
 const saved=(await db.query(`SELECT m.updated_by FROM stockchief_runtime.agent_job_modes m
  JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id
  WHERE m.workspace_id=$1 AND m.job_id=103 AND m.mode='routine' AND u.id=$2
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)
  FOR SHARE OF m,u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!saved||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
  throw new ValidationError('The owner must enable this receipt routine and automatic work before it can run.');
}
async function run(db,workspaceId,{limit=20}={}){
 const outcome={matched:0,waiting:0,skipped:0};
 // No implicit rollout: an owner must explicitly select routine work for job 103.
 const setting=(await db.query(`SELECT m.updated_by FROM stockchief_runtime.agent_job_modes m
  JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id WHERE m.workspace_id=$1 AND m.job_id=103 AND m.mode='routine'
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)`,[workspaceId])).rows[0];
 if(!setting)return outcome;
 const ctx={workspaceId,actorId:setting.updated_by},account=await policy.accountState(db,workspaceId);
 if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,103,'automatic',{trained:true})||!(await require('../autopilot/postgres-service').getState(db,workspaceId)).canAutomate)return outcome;
 const today=await require('../lib/business-time').today(db,workspaceId),size=Number.isSafeInteger(limit)?Math.max(1,Math.min(limit,20)):20;
 const candidates=(await db.query(`SELECT t.id bank_id,i.id invoice_id,i.invoice_number FROM accounting_bank_transactions t
  JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id AND b.active=1 AND b.account_kind='BANK'
  JOIN accounting_settings s ON s.workspace_id=t.workspace_id AND s.enabled=1 AND s.base_currency=b.currency
  JOIN accounting_customer_invoices i ON i.workspace_id=t.workspace_id AND lower(i.invoice_number)=lower(coalesce(nullif(trim(t.reference),''),trim(t.description)))
   AND i.currency=b.currency AND i.status IN ('OPEN','PARTIALLY_PAID') AND i.balance_minor>=t.amount_minor AND i.issue_date<=t.transaction_date
  LEFT JOIN stockchief_runtime.assistant_action_proposals p ON p.workspace_id=t.workspace_id AND p.idempotency_key='receipt-routine:'||t.id||':'||i.id
  WHERE t.workspace_id=$1 AND t.status='UNMATCHED' AND t.amount_minor>0 AND t.transaction_date<=$2
   AND b.ledger_account_id=(SELECT id FROM accounting_accounts WHERE workspace_id=t.workspace_id AND system_key='CASH')
   AND (p.id IS NULL OR p.status='PENDING')
  ORDER BY (p.id IS NULL) DESC,t.transaction_date,t.id,i.id LIMIT $3`,[workspaceId,today,size])).rows;
 const assistant=require('../assistant/postgres-service');
 for(const candidate of candidates){
  const planStepKey='receipt-routine:'+candidate.bank_id+':'+candidate.invoice_id;
  const status=await db.transaction(async client=>{
   const local=scoped(client);let savepoint=false;
   try{
    let proposal=(await client.query('SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND idempotency_key=$2 AND actor_user_id=$3',[workspaceId,planStepKey,ctx.actorId])).rows[0];
    if(!proposal){const prepared=await assistant.prepareAction(local,{...ctx,planStepKey},'Match the recorded bank receipt under the owner’s saved receipt routine.',{action,recordReference:candidate.invoice_id,bankTransaction:candidate.bank_id});proposal=prepared.proposal;}
    if(!proposal)return 'skipped';
    // The scheduler may already own an outer transaction. Roll back every write
    // after preparation on a hold while preserving its real review proposal.
    await client.query('SAVEPOINT customer_receipt_post');savepoint=true;
    const result=await assistant.executeReceiptRoutine(local,ctx,proposal.id);
    await client.query('RELEASE SAVEPOINT customer_receipt_post');
    return result.replayed?'skipped':'matched';
   }catch(error){
    if(!['validation_error','entitlement_required','forbidden'].includes(error.code))throw error;
    if(savepoint){await client.query('ROLLBACK TO SAVEPOINT customer_receipt_post');await client.query('RELEASE SAVEPOINT customer_receipt_post');}
    return 'waiting';
   }
  },{isolation:'SERIALIZABLE',retrySafe:true});
  outcome[status]++;
 }
 return outcome;
}
module.exports={snapshot,execute,run,requireRoutineAuthority,definition:{id:103,key:'customer-payment-matches',label:'Match customer bank receipts',filterLabel:'Invoice number or customer',readPage:review},spec:{name:action,record:'customer_invoice',fields:['recordReference','bankTransaction'],permission:require('../actions/permissions').RECORD_PAYMENTS,ownerOnly:true,capability:'accounting.core',resultingRecords:['accounting_payments','accounting_payment_allocations','accounting_bank_transactions','accounting_journal_entries'],description:'Match a recorded positive bank credit to an existing issued customer invoice. Use exact same-currency bank evidence on the books cash account, never an invented payment. First customers and unclear remittance references need individual confirmation. Growth requires a taught customer/bank/currency receipt limit; Pro/Custom can run clear matches in approved authority. Refuse overpayments, deposits, already-used credits and different currencies. No external charge, payment or refund.',build,execute,verify}};
