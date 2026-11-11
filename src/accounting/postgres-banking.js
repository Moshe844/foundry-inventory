'use strict';

const statement=require('./postgres-bank-statements');
const {newId,nowIso,requireText,trimOrNull}=require('../lib/util');
const {ValidationError,NotFoundError}=require('../domain/errors');

function money(value,label,currency){return require('../domain/currency').toMinor(value,currency,{label,signed:true});}

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

async function receiptAccount(db,workspaceId,transactionId,{lock=false}={}){
  const row=(await db.query(`SELECT t.*,b.name bank_name,b.currency,b.account_kind,b.active bank_active,b.ledger_account_id,
      b.receipt_verified_ledger_id,b.receipt_verified_by,b.receipt_verified_at,a.account_type,a.normal_balance,
      a.system_key,a.active ledger_active,s.base_currency,o.source_hash AS statement_hash,r.source_hash AS remittance_hash
    FROM accounting_bank_transactions t JOIN accounting_bank_accounts b ON b.workspace_id=t.workspace_id AND b.id=t.bank_account_id
    JOIN accounting_accounts a ON a.workspace_id=b.workspace_id AND a.id=b.ledger_account_id
    JOIN accounting_settings s ON s.workspace_id=t.workspace_id AND s.enabled=1
    LEFT JOIN stockchief_runtime.bank_statement_originals o ON o.workspace_id=t.workspace_id
      AND o.bank_account_id=t.bank_account_id AND o.id=t.statement_id
    LEFT JOIN stockchief_runtime.bank_remittance_originals r ON r.workspace_id=t.workspace_id AND r.bank_transaction_id=t.id
      AND r.id=t.remittance_original_id AND r.remittance=t.remittance
    WHERE t.workspace_id=$1 AND t.id=$2`+(lock?' FOR UPDATE OF t FOR SHARE OF b,a,s':''),[workspaceId,transactionId])).rows[0];
  if(!row)throw new NotFoundError('Choose an exact recorded bank credit from this inventory.');
  if(Number(row.amount_minor)<=0||row.account_kind!=='BANK'||Number(row.bank_active)!==1)throw new ValidationError('Use an incoming credit on an active bank account.');
  if(row.currency!==row.base_currency)throw new ValidationError('The bank and books must use the same currency. Review a verified conversion first.');
  const validLedger=row.account_type==='ASSET'&&row.normal_balance==='DEBIT'&&Number(row.ledger_active)===1;
  const defaultCash=row.system_key==='CASH';
  const attestedCash=!row.system_key&&row.receipt_verified_by&&row.receipt_verified_at&&row.receipt_verified_ledger_id===row.ledger_account_id;
  if(!validLedger||!defaultCash&&!attestedCash)throw new ValidationError('Verify this bank’s active cash ledger account in Money before matching receipts.');
  if(row.status==='UNMATCHED'&&row.remittance_original_id&&!row.remittance_hash) {
    throw new ValidationError('The current customer remittance does not match its original evidence.');
  }
  if(row.status==='UNMATCHED'&&row.import_source==='bank_statement_file'&&(!row.statement_hash||!row.statement_row)) {
    throw new ValidationError('The original statement evidence for this credit is unavailable.');
  }
  return row;
}

async function verifyReceiptAccount(database,ctx,bankId,input){
  return database.transaction(async db=>{
    const user=(await db.query(`SELECT u.id FROM users u JOIN workspaces w ON w.id=u.workspace_id AND w.owner_account_id=u.account_id
      WHERE u.workspace_id=$1 AND u.id=$2 AND u.role='owner' AND w.deletion_requested_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM platform_account_access x WHERE x.account_id=u.account_id AND x.disabled_at IS NOT NULL)
      FOR SHARE OF u,w`,[ctx.workspaceId,ctx.actorId])).rows[0];
    if(!user)throw new (require('../domain/errors').AuthorizationError)('Only the current inventory owner can verify bank cash accounts.');
    const bank=(await db.query(`SELECT b.*,a.account_type,a.normal_balance,a.system_key,a.active ledger_active
      FROM accounting_bank_accounts b JOIN accounting_accounts a ON a.workspace_id=b.workspace_id AND a.id=b.ledger_account_id
      WHERE b.workspace_id=$1 AND b.id=$2 AND b.active=1 FOR UPDATE OF b FOR SHARE OF a`,[ctx.workspaceId,bankId])).rows[0];
    if(!bank||bank.account_kind!=='BANK'||bank.ledger_account_id!==input.ledgerAccountId)throw new ValidationError('Review the bank’s current ledger account.');
    if(input.stop==='yes'){
      await db.query('UPDATE accounting_bank_accounts SET receipt_verified_ledger_id=NULL,receipt_verified_by=NULL,receipt_verified_at=NULL WHERE workspace_id=$1 AND id=$2',
        [ctx.workspaceId,bankId]);
    }else{
      if(input.confirmed!=='yes'||bank.account_type!=='ASSET'||bank.normal_balance!=='DEBIT'||Number(bank.ledger_active)!==1||bank.system_key&&bank.system_key!=='CASH') {
        throw new ValidationError('Confirm an active debit-balance bank cash account. Other accounting control accounts cannot be used.');
      }
      await db.query(`UPDATE accounting_bank_accounts SET receipt_verified_ledger_id=ledger_account_id,
        receipt_verified_by=$3,receipt_verified_at=now() WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,bankId,ctx.actorId]);
    }
    await require('../operations/postgres-security-audit').record(db,ctx,{action:input.stop==='yes'?'Bank cash account verification removed':'Bank cash account verified',
      reference:bank.name,after:{bankId,ledgerAccountId:bank.ledger_account_id}});
    return {verified:input.stop!=='yes'};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function importOne(database,ctx,bankId,input){
  const transactionDate=date(input.transactionDate,'Transaction date');
  const description=requireText(input.description,'Description',{max:500});
  const externalId=trimOrNull(input.externalId);
  return database.transaction(async(client)=>{
    const bank=await requireBank(client,ctx.workspaceId,bankId),amountMinor=money(input.amount,'Bank amount',bank.currency);
    if(!amountMinor)throw new ValidationError('Bank amount cannot be zero.');
    const reference=trimOrNull(input.reference),remittance=amountMinor>0
      ?require('./bank-remittance').parse(input.remittance||reference,bank.currency,{explicit:Boolean(input.remittance)}):null;
    if(reference?.length>4000)throw new ValidationError('The bank reference exceeds the supported source field size.');
    const contentHash=statement.transactionHash(bankId,{transactionDate,amountMinor,description,externalId});
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`bank:${ctx.workspaceId}:${bankId}`]);
    const prior=(await client.query(`SELECT * FROM accounting_bank_transactions WHERE workspace_id=$1
      AND bank_account_id=$2 AND (content_hash=$3 OR ($4::text IS NOT NULL AND external_id=$4)
        OR (transaction_date=$5 AND amount_minor=$6 AND md5(description)=md5($7::text) AND description=$7 AND (external_id IS NULL OR $4::text IS NULL)))
      ORDER BY (content_hash=$3) DESC LIMIT 1`,
    [ctx.workspaceId,bankId,contentHash,externalId,transactionDate,amountMinor,description])).rows[0];
    if(prior){
      if(prior.content_hash!==contentHash||reference&&prior.reference&&reference!==prior.reference
        ||remittance&&prior.remittance&&!require('node:util').isDeepStrictEqual(remittance,prior.remittance)) {
        throw new ValidationError('That bank transaction conflicts with previously imported evidence. Compare the original statement.');
      }
      return {transaction:prior,replayed:true};
    }
    const inserted=(await client.query(`INSERT INTO accounting_bank_transactions
      (id,workspace_id,bank_account_id,external_id,transaction_date,amount_minor,description,
       content_hash,import_source,status,imported_at,reference,remittance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual_bank_import','UNMATCHED',$9,$10,$11::jsonb) RETURNING *`,
    [newId('banktx'),ctx.workspaceId,bankId,externalId,transactionDate,amountMinor,description,contentHash,nowIso(),reference,
      remittance?JSON.stringify(remittance):null])).rows[0];
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
        WHERE workspace_id=$1 AND id=$2 AND status='POSTED' FOR UPDATE`,[ctx.workspaceId,targetId])).rows[0];
      if(payment&&(await client.query(`SELECT 1 FROM accounting_bank_transactions
        WHERE workspace_id=$1 AND matched_payment_id=$2 AND id<>$3 AND status IN('MATCHED','RECONCILED') LIMIT 1`,
        [ctx.workspaceId,targetId,transactionId])).rowCount)throw new ValidationError('This payment already matches a different bank transaction.');
      if(!payment||payment.cash_account_id!==bank.ledger_account_id||payment.currency!==bank.currency)
        throw new ValidationError('Choose a posted payment that used this financial account.');
      expected=payment.direction==='CUSTOMER_RECEIPT'?Number(payment.amount_minor):-Number(payment.amount_minor);
      journalId=payment.journal_entry_id;paymentId=payment.id;
    }else{
      const result=(await client.query(`SELECT e.id,min(l.currency) AS currency,count(DISTINCT l.currency)::int AS currency_count,COALESCE(SUM(l.debit_minor-l.credit_minor),0)::bigint AS amount
        FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
        WHERE e.workspace_id=$1 AND e.id=$2 AND e.status='POSTED' AND l.account_id=$3 GROUP BY e.id`,
      [ctx.workspaceId,targetId,bank.ledger_account_id])).rows[0];
      if(!result)throw new ValidationError('That posted entry did not change this account.');
      if(result.currency_count!==1||result.currency!==bank.currency)throw new ValidationError('The bank and posted entry use different currencies. Review an explicit currency conversion before matching.');
      expected=bank.account_kind==='CREDIT_CARD'?-Number(result.amount):Number(result.amount);
      journalId=result.id;
    }
    if(expected!==Number(transaction.amount_minor))throw new ValidationError('Bank amount does not equal the exact account effect.');
    const updated=(await client.query(`UPDATE accounting_bank_transactions SET status='MATCHED',
      matched_journal_entry_id=$3,matched_payment_id=$4,matched_at=$5,receipt_check_problem=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [ctx.workspaceId,transactionId,journalId,paymentId,nowIso()])).rows[0];
    return {transaction:updated,replayed:false};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}

async function reconcile(database,ctx,bankId,input){
  const endDate=date(input.statementEndDate,'Statement end date');
  return database.transaction(async(client)=>{
    const bank=await requireBank(client,ctx.workspaceId,bankId);
    const statementMinor=money(input.statementEndingBalance,'Statement ending balance',bank.currency);
    const books=(await client.query('SELECT base_currency FROM accounting_settings WHERE workspace_id=$1 AND enabled=1',[ctx.workspaceId])).rows[0];
    if(books?.base_currency!==bank.currency)throw new ValidationError('The bank and inventory books use different currencies. Review an explicit currency conversion before reconciling.');
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

// A read of recorded reconciliation evidence, not a new reconciliation or a
// claim that an external account is balanced. Keep this separate from the
// journal's posting-date filter: statement activity has its own dates/states.
async function inspect(database,ctx){
  const permissions=require('../actions/permissions');
  const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,ctx.actorId])).rows[0];
  permissions.assertCan(actor,permissions.VIEW_ACCOUNTING,'view banking and reconciliation');
  const r=(await database.query(`SELECT
    (SELECT count(*)::int FROM accounting_bank_accounts WHERE workspace_id=$1) account_count,
    (SELECT count(*)::int FROM accounting_bank_accounts WHERE workspace_id=$1 AND active=1) active_account_count,
    (SELECT count(*)::int FROM accounting_bank_transactions WHERE workspace_id=$1) transaction_count,
    (SELECT max(imported_at) FROM accounting_bank_transactions WHERE workspace_id=$1) last_imported_at,
    COALESCE((SELECT jsonb_object_agg(status,n) FROM
      (SELECT status,count(*)::int n FROM accounting_bank_transactions WHERE workspace_id=$1 GROUP BY status) s),'{}'::jsonb) transaction_states,
    (SELECT count(*)::int FROM accounting_reconciliations WHERE workspace_id=$1) statement_count,
    (SELECT max(completed_at) FROM accounting_reconciliations WHERE workspace_id=$1 AND status='COMPLETED') last_completed_at,
    COALESCE((SELECT jsonb_object_agg(status,n) FROM
      (SELECT status,count(*)::int n FROM accounting_reconciliations WHERE workspace_id=$1 GROUP BY status) s),'{}'::jsonb) statement_states,
    (SELECT count(*)::int FROM accounting_reconciliations WHERE workspace_id=$1 AND difference_minor<>0) statements_with_difference`,
    [ctx.workspaceId])).rows[0];
  return {available:true,complete:true,
    scope:'All recorded financial accounts, imported statement lines and saved statement reconciliations in this business; independent of the journal posting-date filter.',
    accounts:{total:r.account_count,active:r.active_account_count},
    transactions:{total:r.transaction_count,states:r.transaction_states,lastImportedAt:r.last_imported_at},
    statements:{total:r.statement_count,states:r.statement_states,withRecordedDifference:r.statements_with_difference,lastCompletedAt:r.last_completed_at},
    interpretation:'Absent state counts mean zero recorded rows in this scope. No imported activity or completed statements means reconciliation is unestablished, not that balances match. Completion applies only to its saved statement date; this does not contact a bank, establish current funds, or verify external accounting connections.'};
}

module.exports={receiptAccount,verifyReceiptAccount,importOne,match,reconcile,inspect};
