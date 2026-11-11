'use strict';

const {ValidationError,AuthorizationError}=require('../domain/errors');
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const {hash}=require('../pricing/postgres-promotions');
const draft=require('../autopilot/draft-authority');
const banking=require('./postgres-banking');
const {snapshot,postedReceipt,sameAllocations}=require('./customer-bank-receipt-evidence');

const action='customer_payment.match_bank_line';
const scoped=c=>({query:(...args)=>c.query(...args),transaction:fn=>fn(c)});

async function owner(db,ctx){
 const found=(await db.query(`SELECT 1 FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
   WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=u.account_id AND a.disabled_at IS NOT NULL)`,
 [ctx.workspaceId,ctx.actorId])).rowCount;
 if(!found)throw new AuthorizationError('Only the current inventory owner can match customer bank receipts.');
}
async function build(db,ctx,row,args){
 await owner(db,ctx);
 await policy.requireWorkspaceJob(db,ctx.workspaceId,103,'draft');
 const p=await snapshot(db,ctx,row.id,args.bankTransaction);
 if(p.existing)return {payload:p,summary:'This bank credit is already matched. Repeating it adds no payment.'};
 const details=p.allocations.map(a=>a.invoiceNumber+' '+money.format(a.amountMinor,p.currency)).join(', ');
 const approval=p.needsPaymentConfirmation?' Confirm this first customer receipt or the unclear remittance reference.':'';
 return {payload:p,summary:'Match the recorded '+money.format(p.amountMinor,p.currency)+' credit at '+p.bankName+' to '+p.customerName+
   ' and allocate it to '+details+'.'+approval};
}
async function execute(db,ctx,p){
 await owner(db,ctx);
 const automatic=ctx.agentPaymentScope==='automatic';
 const account=await policy.requireWorkspaceJob(db,ctx.workspaceId,103,'draft');
 if(automatic){
  const trained=await draft.trained(db,ctx.workspaceId,action,p);
  policy.requireJob(account.plan,103,'automatic',{trained});
  const hold=await policy.stopped(db,ctx.workspaceId,account,action,true,p);
  if(hold)throw new ValidationError(hold);
 }
 const fresh=await snapshot(db,ctx,p.recordId,p.bankTransactionId,true);
 if(fresh.existing)return {...fresh.existing,automatic};
 if(fresh.sourceFingerprint!==p.sourceFingerprint||hash(fresh.training)!==hash(p.training))throw new ValidationError('The bank credit or invoice changed after review. Prepare a fresh match.');
 if(automatic){
  if(fresh.needsPaymentConfirmation)throw new ValidationError('This receipt needs its own confirmation.');
  const rule=(await db.query(`SELECT r.maximum_minor FROM stockchief_runtime.agent_draft_rules r
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by AND u.role='owner'
    WHERE r.workspace_id=$1 AND r.action_type=$2 AND r.scope_key=$3 AND r.currency=$4 FOR SHARE OF r,u`,
  [ctx.workspaceId,action,p.training.key,p.currency])).rows[0];
  if(rule&&p.amountMinor>Number(rule.maximum_minor))throw new ValidationError('The bank credit exceeds the owner’s receipt limit. Approve it individually.');
 }
 const result=fresh.alreadyPosted?{...fresh.alreadyPosted,amountMinor:fresh.amountMinor,linkedExisting:true}
   :await require('../operations/postgres-business-workflows').recordCustomerBankReceiptInTransaction(db,ctx,{
    customerId:fresh.customerId,bankTransactionId:fresh.bankTransactionId,allocations:fresh.allocations,reference:fresh.paymentReference,
   });
 await banking.match(scoped(db),ctx,p.bankTransactionId,'payment:'+result.paymentId);
 await require('../operations/postgres-security-audit').record(db,ctx,{action:'Customer bank receipt matched',reference:p.bankTransactionId,
   after:{invoices:fresh.allocations.map(a=>({invoice:a.invoiceNumber,amountMinor:a.amountMinor})),
    bank:fresh.bankName,amount:money.format(fresh.amountMinor,fresh.currency),payment:result.paymentNumber}});
 return {...result,automatic,bankTransactionId:p.bankTransactionId,invoiceId:p.recordId,href:'/money/invoices/'+p.recordId};
}
async function verify(db,ctx,result,p){
 if(!result.paymentId)return false;
 const bank=await banking.receiptAccount(db,ctx.workspaceId,p.bankTransactionId);
 if(!['MATCHED','RECONCILED'].includes(bank.status)||bank.matched_payment_id!==result.paymentId)return false;
 const posted=await postedReceipt(db,ctx,bank,result.paymentId);
 return Boolean(posted&&sameAllocations(posted.allocations,p.allocations||p.existing?.allocations||[{invoiceId:p.recordId,amountMinor:p.amountMinor}]));
}
async function confirmedExample(db,ctx,proposal){
 if(proposal.result?.automatic===true||proposal.result?.replayed||!proposal.result?.paymentId)return false;
 try{return await verify(db,ctx,proposal.result,proposal.payload);}
 catch(error){if(['validation_error','not_found','forbidden'].includes(error.code))return false;throw error;}
}

const candidateSources=`FROM accounting_bank_transactions t
  JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id AND b.active=1 AND b.account_kind='BANK'
  JOIN accounting_accounts cash ON cash.workspace_id=b.workspace_id AND cash.id=b.ledger_account_id
    AND cash.active=1 AND cash.account_type='ASSET' AND cash.normal_balance='DEBIT'
    AND (cash.system_key='CASH' OR cash.system_key IS NULL AND b.receipt_verified_at IS NOT NULL
      AND b.receipt_verified_by IS NOT NULL AND b.receipt_verified_ledger_id=cash.id)
  JOIN accounting_settings s ON s.workspace_id=t.workspace_id AND s.enabled=1 AND s.base_currency=b.currency
  JOIN accounting_customer_invoices i ON i.workspace_id=t.workspace_id
    AND lower(i.invoice_number)=lower(coalesce(t.remittance->0->>'invoiceNumber',nullif(trim(t.reference),''),trim(t.description)))
    AND i.currency=b.currency AND i.issue_date<=t.transaction_date
    AND (i.status IN('OPEN','PARTIALLY_PAID') AND (t.remittance IS NOT NULL OR i.balance_minor>=t.amount_minor)
      OR i.status='PAID' AND t.external_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounting_payments paid
        JOIN accounting_payment_allocations l ON l.workspace_id=paid.workspace_id AND l.payment_id=paid.id AND l.customer_invoice_id=i.id
        WHERE paid.workspace_id=t.workspace_id AND paid.customer_id=i.customer_id AND paid.status='POSTED'
          AND paid.reference=t.external_id AND paid.amount_minor=t.amount_minor AND paid.cash_account_id=b.ledger_account_id))`;

async function review(db,ctx,{page=1,filter=''}){
 const history=await require('../commercial/agent-history').access(db,ctx.workspaceId),offset=(page-1)*100,today=await require('../lib/business-time').today(db,ctx.workspaceId);
 const [completed,pending]=await Promise.all([
  db.query(`SELECT i.invoice_number AS "Invoice",c.name AS "Customer",b.name AS "Bank",a.amount_minor,p.currency,t.transaction_date AS "Received on",'/money/invoices/'||i.id AS link FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id JOIN accounting_payments p ON p.workspace_id=t.workspace_id AND p.id=t.matched_payment_id AND p.status='POSTED' AND p.direction='CUSTOMER_RECEIPT'
   AND (p.source_key='agent-bank-receipt:'||t.id OR EXISTS(SELECT 1 FROM stockchief_runtime.assistant_action_proposals a
     WHERE a.workspace_id=t.workspace_id AND a.action_type='customer_payment.match_bank_line' AND a.status='EXECUTED'
       AND a.result->>'bankTransactionId'=t.id AND a.result->>'paymentId'=p.id AND a.result->>'linkedExisting'='true')) JOIN accounting_payment_allocations a ON a.workspace_id=p.workspace_id AND a.payment_id=p.id JOIN accounting_customer_invoices i ON i.workspace_id=a.workspace_id AND i.id=a.customer_invoice_id JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id WHERE t.workspace_id=$1 AND t.status IN ('MATCHED','RECONCILED') AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)) AND ($3::timestamptz IS NULL OR t.matched_at::timestamptz>=$3::timestamptz) ORDER BY t.matched_at DESC,t.id LIMIT 101 OFFSET $4`,[ctx.workspaceId,filter,history.activityAfter,offset]),
  db.query(`SELECT t.id AS "bankTransaction",i.invoice_number AS "invoiceNumber",c.name AS "customerName",
    b.name AS "bankName",t.amount_minor,b.currency,t.statement_id AS "statementId",
    coalesce(jsonb_array_length(t.remittance),1) AS "allocationCount"
    ${candidateSources}
    JOIN customers c ON c.workspace_id=i.workspace_id AND c.id=i.customer_id
    WHERE t.workspace_id=$1 AND t.status='UNMATCHED' AND t.amount_minor>0 AND t.remittance_problem IS NULL AND t.transaction_date<=$4
      AND ($2='' OR lower(i.invoice_number)=lower($2) OR lower(c.name)=lower($2)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(t.remittance) r WHERE lower(r->>'invoiceNumber')=lower($2)))
    ORDER BY t.transaction_date,t.id LIMIT 101 OFFSET $3`,[ctx.workspaceId,filter,offset,today])
 ]);
 const account=await policy.accountState(db,ctx.workspaceId),blocked=await policy.stopped(db,ctx.workspaceId,account,action,false);
 const rows=completed.rows.slice(0,100).map(r=>{const {amount_minor,currency,...row}=r;return {...row,Amount:money.format(amount_minor,currency)};});
 return {rows,more:completed.rows.length>100||pending.rows.length>100,summary:'Match recorded incoming bank credits to their issued invoices. Preparing a match posts nothing. First customers, uncertain references and owner limits require individual confirmation; stock and outgoing money stay unchanged.',bankMatchForm:{blocked,entries:pending.rows.slice(0,100).map(r=>({...r,amount:money.format(r.amount_minor,r.currency)}))}};
}
async function requireRoutineAuthority(db,ctx){
 const saved=(await db.query(`SELECT m.updated_by,m.revision FROM stockchief_runtime.agent_job_modes m
  JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.updated_by AND u.role='owner'
  JOIN accounts a ON a.id=u.account_id JOIN workspace_autopilot w ON w.workspace_id=m.workspace_id
  WHERE m.workspace_id=$1 AND m.job_id=103 AND m.mode='routine' AND u.id=$2
   AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=a.id AND x.disabled_at IS NOT NULL)
  FOR SHARE OF m,u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!saved||!(await require('../autopilot/postgres-service').getState(db,ctx.workspaceId)).canAutomate)
  throw new ValidationError('The owner must enable this receipt routine and automatic work before it can run.');
 return {kind:'standing_job_rule',job:103,ownerId:ctx.actorId,modeRevision:Number(saved.revision)};
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
 const candidates=(await db.query(`SELECT t.id bank_id,i.id invoice_id,i.invoice_number,t.remittance_original_id ${candidateSources}
  LEFT JOIN stockchief_runtime.assistant_action_proposals p ON p.workspace_id=t.workspace_id AND p.idempotency_key='receipt-routine:'||t.id||':'||i.id||coalesce(':'||t.remittance_original_id,'')
  WHERE t.workspace_id=$1 AND t.status='UNMATCHED' AND t.amount_minor>0 AND t.remittance_problem IS NULL AND t.transaction_date<=$2
   AND (p.status='PENDING' OR p.id IS NULL AND (t.receipt_checked_at IS NULL OR t.receipt_checked_at<=now()-interval '15 minutes'))
  ORDER BY (p.id IS NULL) DESC,t.receipt_checked_at NULLS FIRST,t.transaction_date,t.id,i.id LIMIT $3`,[workspaceId,today,size])).rows;
 const assistant=require('../assistant/postgres-service');
 for(const candidate of candidates){
  const planStepKey='receipt-routine:'+candidate.bank_id+':'+candidate.invoice_id+
    (candidate.remittance_original_id?':'+candidate.remittance_original_id:'');
  const status=await db.transaction(async client=>{
   const local=scoped(client);let savepoint=false,proposal;
   const rememberHold=problem=>client.query(`UPDATE accounting_bank_transactions SET receipt_checked_at=now(),receipt_check_problem=$3
     WHERE workspace_id=$1 AND id=$2 AND status='UNMATCHED'`,[workspaceId,candidate.bank_id,String(problem).slice(0,500)]);
   try{
    proposal=(await client.query('SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND idempotency_key=$2 AND actor_user_id=$3',[workspaceId,planStepKey,ctx.actorId])).rows[0];
    if(!proposal){const prepared=await assistant.prepareAction(local,{...ctx,planStepKey},'Match the recorded bank receipt under the owner’s saved receipt routine.',{action,recordReference:candidate.invoice_id,bankTransaction:candidate.bank_id});proposal=prepared.proposal;}
    if(!proposal){await rememberHold('Review the retained statement and exact remittance.');return 'skipped';}
    // The scheduler may already own an outer transaction. Roll back every write
    // after preparation on a hold while preserving its real review proposal.
    await client.query('SAVEPOINT customer_receipt_post');savepoint=true;
    const result=await assistant.executeReceiptRoutine(local,ctx,proposal.id);
    await client.query('RELEASE SAVEPOINT customer_receipt_post');
    return result.replayed?'skipped':'matched';
   }catch(error){
    if(!['validation_error','entitlement_required','forbidden','not_found'].includes(error.code))throw error;
    if(savepoint){await client.query('ROLLBACK TO SAVEPOINT customer_receipt_post');await client.query('RELEASE SAVEPOINT customer_receipt_post');}
    if(!proposal)await rememberHold(error.message);
    return 'waiting';
   }
  },{isolation:'SERIALIZABLE',retrySafe:true});
  outcome[status]++;
 }
 if(outcome.matched)await require('../assistant/postgres-goal-resume').refreshWorkspace(db,workspaceId);
 return outcome;
}
module.exports={snapshot,execute,run,confirmedExample,requireRoutineAuthority,definition:{id:103,key:'customer-payment-matches',label:'Match customer bank receipts',filterLabel:'Invoice number or customer',readPage:review},spec:{name:action,record:'customer_invoice',fields:['recordReference','bankTransaction'],permission:require('../actions/permissions').RECORD_PAYMENTS,ownerOnly:true,capability:'accounting.core',resultingRecords:['accounting_payments','accounting_payment_allocations','accounting_bank_transactions','accounting_journal_entries'],description:'Match one recorded positive bank credit to its exact issued customer invoices on a verified same-currency bank cash account. A remittance must allocate the complete credit without guessing. First customers and unclear references need individual confirmation. Growth needs a taught customer, bank, currency and allocation scope; Pro and Custom can match within current owner authority.',build,execute,verify}};
