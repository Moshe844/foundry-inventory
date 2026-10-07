'use strict';

const crypto=require('node:crypto');
const {newId,nowIso,requireText,trimOrNull}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');

function money(value,label){
  const text=String(value??'').trim();
  if(!/^-?\d+(?:\.\d{1,2})?$/.test(text))throw new ValidationError(`${label} must be a money amount.`);
  const amount=Math.round(Number(text)*100);
  if(!Number.isSafeInteger(amount))throw new ValidationError(`${label} is too large.`);
  return amount;
}

function date(value,label){
  const text=String(value||'').trim();
  const parsed=Date.parse(`${text}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==text)
    throw new ValidationError(`${label} must be a valid date.`);
  return text;
}

async function requireBank(client,workspaceId,bankId){
  const bank=(await client.query(`SELECT * FROM accounting_bank_accounts
    WHERE workspace_id=$1 AND id=$2 AND active=1`,[workspaceId,bankId])).rows[0];
  if(!bank)throw new NotFoundError('That financial account was not found in this inventory.');
  return bank;
}

async function importOne(database,ctx,bankId,input){
  const transactionDate=date(input.transactionDate,'Transaction date');
  const amountMinor=money(input.amount,'Bank amount');
  if(!amountMinor)throw new ValidationError('Bank amount cannot be zero.');
  const description=requireText(input.description,'Description',{max:500});
  const externalId=trimOrNull(input.externalId);
  const contentHash=crypto.createHash('sha256').update(JSON.stringify({bankId,transactionDate,amountMinor,
    description,externalId})).digest('hex');
  return database.transaction(async(client)=>{
    await requireBank(client,ctx.workspaceId,bankId);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`bank:${ctx.workspaceId}:${bankId}`]);
    const prior=(await client.query(`SELECT * FROM accounting_bank_transactions WHERE workspace_id=$1
      AND bank_account_id=$2 AND (content_hash=$3 OR ($4::text IS NOT NULL AND external_id=$4))`,
    [ctx.workspaceId,bankId,contentHash,externalId])).rows[0];
    if(prior){
      if(prior.content_hash!==contentHash)throw new ValidationError('That bank reference already belongs to a different amount or description.');
      return {transaction:prior,replayed:true};
    }
    const inserted=(await client.query(`INSERT INTO accounting_bank_transactions
      (id,workspace_id,bank_account_id,external_id,transaction_date,amount_minor,description,
       content_hash,import_source,status,imported_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual_bank_import','UNMATCHED',$9) RETURNING *`,
    [newId('banktx'),ctx.workspaceId,bankId,externalId,transactionDate,amountMinor,description,contentHash,nowIso()])).rows[0];
    return {transaction:inserted,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function match(database,ctx,transactionId,target){
  const [kind,targetId]=String(target||'').split(':',2);
  if(!['payment','journal'].includes(kind)||!targetId)throw new ValidationError('Choose an exact payment or journal entry.');
  return database.transaction(async(client)=>{
    const transaction=(await client.query(`SELECT * FROM accounting_bank_transactions
      WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[ctx.workspaceId,transactionId])).rows[0];
    if(!transaction)throw new NotFoundError('That bank transaction was not found in this inventory.');
    if(transaction.status!=='UNMATCHED'){
      const same=kind==='payment'?transaction.matched_payment_id===targetId:
        !transaction.matched_payment_id&&transaction.matched_journal_entry_id===targetId;
      if(!same)throw new ValidationError('This statement line is already matched to a different record.');
      return {transaction,replayed:true};
    }
    const bank=await requireBank(client,ctx.workspaceId,transaction.bank_account_id);
    let expected;
    let journalId;
    let paymentId=null;
    if(kind==='payment'){
      const payment=(await client.query(`SELECT * FROM accounting_payments
        WHERE workspace_id=$1 AND id=$2 AND status='POSTED'`,[ctx.workspaceId,targetId])).rows[0];
      if(!payment||payment.cash_account_id!==bank.ledger_account_id)
        throw new ValidationError('Choose a posted payment that used this financial account.');
      expected=payment.direction==='CUSTOMER_RECEIPT'?Number(payment.amount_minor):-Number(payment.amount_minor);
      journalId=payment.journal_entry_id;paymentId=payment.id;
    }else{
      const result=(await client.query(`SELECT e.id,COALESCE(SUM(l.debit_minor-l.credit_minor),0)::bigint AS amount
        FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
        WHERE e.workspace_id=$1 AND e.id=$2 AND e.status='POSTED' AND l.account_id=$3 GROUP BY e.id`,
      [ctx.workspaceId,targetId,bank.ledger_account_id])).rows[0];
      if(!result)throw new ValidationError('That posted entry did not change this account.');
      expected=bank.account_kind==='CREDIT_CARD'?-Number(result.amount):Number(result.amount);
      journalId=result.id;
    }
    if(expected!==Number(transaction.amount_minor))throw new ValidationError('Bank amount does not equal the exact account effect.');
    const updated=(await client.query(`UPDATE accounting_bank_transactions SET status='MATCHED',
      matched_journal_entry_id=$3,matched_payment_id=$4,matched_at=$5 WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,transactionId,journalId,paymentId,nowIso()])).rows[0];
    return {transaction:updated,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function reconcile(database,ctx,bankId,input){
  const endDate=date(input.statementEndDate,'Statement end date');
  const statementMinor=money(input.statementEndingBalance,'Statement ending balance');
  return database.transaction(async(client)=>{
    const bank=await requireBank(client,ctx.workspaceId,bankId);
    const prior=(await client.query(`SELECT * FROM accounting_reconciliations
      WHERE workspace_id=$1 AND bank_account_id=$2 AND statement_end_date=$3 FOR UPDATE`,
    [ctx.workspaceId,bankId,endDate])).rows[0];
    if(prior&&prior.status==='COMPLETED')throw new ValidationError('This statement is already reconciled.');
    const raw=Number((await client.query(`SELECT COALESCE(SUM(l.debit_minor-l.credit_minor),0)::bigint AS amount
      FROM accounting_journal_lines l JOIN accounting_journal_entries e ON e.id=l.entry_id
      WHERE l.workspace_id=$1 AND l.account_id=$2 AND e.status='POSTED' AND e.posting_date<=$3`,
    [ctx.workspaceId,bank.ledger_account_id,endDate])).rows[0].amount);
    const ledgerMinor=bank.account_kind==='CREDIT_CARD'?-raw:raw;
    const difference=statementMinor-ledgerMinor;
    const unmatched=Number((await client.query(`SELECT COUNT(*) AS count FROM accounting_bank_transactions
      WHERE workspace_id=$1 AND bank_account_id=$2 AND transaction_date<=$3 AND status='UNMATCHED'`,
    [ctx.workspaceId,bankId,endDate])).rows[0].count);
    if(input.complete){
      if(difference)throw new ValidationError(`Reconciliation is out by ${Math.abs(difference)} minor units.`);
      if(unmatched)throw new ValidationError(`${unmatched} statement transaction${unmatched===1?' is':'s are'} still unmatched.`);
    }
    const at=nowIso();
    const row=(await client.query(`INSERT INTO accounting_reconciliations
      (id,workspace_id,bank_account_id,statement_end_date,statement_ending_balance_minor,
       ledger_ending_balance_minor,difference_minor,status,completed_by_user_id,created_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(workspace_id,bank_account_id,statement_end_date) DO UPDATE SET
      statement_ending_balance_minor=EXCLUDED.statement_ending_balance_minor,
      ledger_ending_balance_minor=EXCLUDED.ledger_ending_balance_minor,difference_minor=EXCLUDED.difference_minor,
      status=EXCLUDED.status,completed_by_user_id=EXCLUDED.completed_by_user_id,completed_at=EXCLUDED.completed_at
      RETURNING *`,[prior?.id||newId('recon'),ctx.workspaceId,bankId,endDate,statementMinor,ledgerMinor,difference,
        input.complete?'COMPLETED':'IN_PROGRESS',input.complete?ctx.actorId:null,at,input.complete?at:null])).rows[0];
    if(input.complete)await client.query(`UPDATE accounting_bank_transactions SET status='RECONCILED'
      WHERE workspace_id=$1 AND bank_account_id=$2 AND transaction_date<=$3 AND status='MATCHED'`,
    [ctx.workspaceId,bankId,endDate]);
    return row;
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

module.exports={importOne,match,reconcile};
