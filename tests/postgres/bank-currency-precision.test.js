'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,createHash}=require('node:crypto');
test('bank evidence and statement approvals use each currency precision and refuse currency-mismatched reconciliation',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),ledger=require('../../src/accounting/postgres-ledger'),banking=require('../../src/accounting/postgres-banking'),assistant=require('../../src/assistant/postgres-service'),money=require('../../src/domain/currency');
 for(const [currency,amount,expected,invalid]of [['USD','12.34',1234,'1.001'],['JPY','1234',1234,'1.5'],['KWD','12.345',12345,'1.2345']]){
  const owner=await auth.createBusiness(db,{name:'Reviewer',businessName:currency+' bank precision',email:randomUUID()+'@example.test',password:'Bank!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,'pro','agent-v3:pro','ACTIVE') ON CONFLICT(account_id) DO UPDATE SET plan_id='pro',plan_version_id='agent-v3:pro',status='ACTIVE'",[randomUUID(),owner.accountId]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await ledger.configure(db,ctx,{startDate:'2026-01-01',currency});
  const cash=(await db.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'",[ctx.workspaceId])).rows[0].id,bank=randomUUID(),name=currency+' clearing';
  const addBank=async(id,code)=>db.query(`INSERT INTO accounting_bank_accounts(id,workspace_id,name,account_kind,currency,ledger_account_id,active,created_by_user_id,created_at,updated_at) VALUES($1,$2,$3,'BANK',$4,$5,1,$6,now()::text,now()::text)`,[id,ctx.workspaceId,id===bank?name:'Different currency bank',code,cash,ctx.actorId]);
  await addBank(bank,currency);
  const request={action:'accounting.bank_import',recordReference:name,transactionDate:'2026-01-02',amount:Number(amount),description:'Exact recorded statement line',externalId:'native-credit'};
  const p=await assistant.prepareAction(db,ctx,'Import the original bank amount',request);assert(p.proposal.summary.includes(money.format(expected,currency)));
  const imported=await assistant.executeProposal(db,ctx,p.proposal.id);await assistant.executeProposal(db,ctx,p.proposal.id);
  assert.equal(Number(imported.result.transaction.amount_minor),expected);
  const direct={transactionDate:'2026-01-02',amount,description:'Direct source',externalId:'direct-credit'},one=await banking.importOne(db,ctx,bank,direct);assert.equal(Number(one.transaction.amount_minor),expected);assert((await banking.importOne(db,ctx,bank,direct)).replayed);
  if(currency==='USD')assert.equal(one.transaction.content_hash,createHash('sha256').update(JSON.stringify({bankId:bank,transactionDate:direct.transactionDate,amountMinor:1234,description:direct.description,externalId:direct.externalId})).digest('hex'),'Previously accepted USD source hashes remain unchanged.');
  const negative=await assistant.prepareAction(db,ctx,'Import money out',{...request,amount:-Number(amount),externalId:'native-debit'});assert.equal(Number((await assistant.executeProposal(db,ctx,negative.proposal.id)).result.transaction.amount_minor),-expected);
  await assert.rejects(assistant.prepareAction(db,ctx,'An unrepresentable bank amount',{...request,amount:Number(invalid),externalId:'invalid'}),/fraction smaller/);
  await assert.rejects(banking.importOne(db,ctx,bank,{...direct,amount:invalid,externalId:'invalid'}),/fraction smaller/);
  assert.equal((await db.query('SELECT count(*)::int n FROM accounting_bank_transactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,3);
  const statement=await assistant.prepareAction(db,ctx,'Save the exact statement balance',{action:'accounting.reconcile',recordReference:name,statementEndDate:'2026-01-03',statementEndingBalance:Number(amount),enabled:'false'});
  await assistant.executeProposal(db,ctx,statement.proposal.id);const reconciled=(await db.query('SELECT * FROM accounting_reconciliations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(Number(reconciled.statement_ending_balance_minor),expected);assert.equal(Number(reconciled.difference_minor),expected);assert.equal(reconciled.status,'IN_PROGRESS');
  await assert.rejects(assistant.prepareAction(db,ctx,'A statement fraction the currency does not support',{action:'accounting.reconcile',recordReference:name,statementEndDate:'2026-01-03',statementEndingBalance:Number(invalid),enabled:'false'}),/fraction smaller/);
  await assert.rejects(banking.reconcile(db,ctx,bank,{statementEndDate:'2026-01-03',statementEndingBalance:amount,complete:true}),/out by/);
  if(currency==='JPY'){
   const other=randomUUID();await addBank(other,'USD');const line=await banking.importOne(db,ctx,other,{transactionDate:'2026-01-02',amount:'1.00',description:'Different currency evidence',externalId:'different-currency'});
   const journal=await ledger.post(db,ctx,{postingDate:'2026-01-02',sourceKey:randomUUID(),description:'Recorded test opening funds',sourceType:'opening_balance',sourceRecordType:'bank',sourceRecordId:bank,currency:'JPY',lines:[{accountKey:'CASH',debitMinor:100},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:100}]});
   await assert.rejects(banking.match(db,ctx,line.transaction.id,'journal:'+journal.entry.id),/different currencies/);
   await assert.rejects(banking.reconcile(db,ctx,other,{statementEndDate:'2026-01-03',statementEndingBalance:'1.00'}),/different currencies/);
   assert.equal((await db.query('SELECT status FROM accounting_bank_transactions WHERE id=$1',[line.transaction.id])).rows[0].status,'UNMATCHED');
  }
 }
});
