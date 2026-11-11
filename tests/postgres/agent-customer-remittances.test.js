'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,createHash}=require('node:crypto');
const receipts=require('../../src/accounting/agent-customer-payment-matches');
const banking=require('../../src/accounting/postgres-banking');
const statements=require('../../src/accounting/postgres-bank-statements');
const assistant=require('../../src/assistant/postgres-service');
const training=require('../../src/autopilot/draft-authority');
const mode=require('../../src/autopilot/job-modes');

test('native statement originals allocate each exact remittance once to its invoices and verified cash ledger',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  const {db,ctx,browser,csrf}=f;
  const customerId='fixture-customer';
  await f.subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const parcel=await f.parcel();await f.shipping.markPacked(db,ctx,parcel.shipmentId);
  await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',trackingNumber:randomUUID(),carrier:'UPS'});
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const post=async(route,body)=>{
    const html=(await browser.get('/accounting/banking').expect(200)).text;
    return browser.post(route).type('form').send({_csrf:csrf(html),...body}).expect(303);
  };
  const makeBank=async(code,name)=>{
    await post('/accounting/chart',{code,name,type:'ASSET',subtype:'CASH',normalBalance:'DEBIT'});
    const cash=(await db.query('SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND code=$2',[ctx.workspaceId,code])).rows[0].id;
    await post('/accounting/banking/accounts',{name,kind:'BANK',ledgerAccountId:cash});
    const bank=(await db.query('SELECT id FROM accounting_bank_accounts WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,name])).rows[0].id;
    return {id:bank,cash,name};
  };
  const verify=bank=>post('/accounting/banking/'+bank.id+'/verify-cash',{confirmed:'yes',ledgerAccountId:bank.cash});
  const invoice=async(number,amount='20.00',customer=customerId)=>{
    const r=await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,
      {customerId:customer,description:'Issued customer services',quantity:1,unitAmount:amount,issueDate:today,
        idempotencyKey:randomUUID(),documentNumber:number});
    return {id:r.id,number};
  };
  const balance=async i=>Number((await db.query('SELECT balance_minor FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,i.id])).rows[0].balance_minor);
  const raw=(externalId,amount,remittance,extra='')=>Buffer.from('Transaction Date,Posted Date,Description,Amount,Transaction ID,Remittance,Currency\n'+
    [today,today,'Customer bank transfer',amount,externalId,remittance,'USD'].join(',')+'\n'+extra);
  const upload=async(bank,source,filename)=>{
    const html=(await browser.get('/accounting/banking').expect(200)).text;
    await browser.post('/accounting/banking/'+bank.id+'/import-statement').field('_csrf',csrf(html))
      .field('dateFormat','ISO').attach('statement',source,{filename,contentType:'text/csv'}).expect(303);
  };
  const bankLine=async externalId=>(await db.query('SELECT * FROM accounting_bank_transactions WHERE workspace_id=$1 AND external_id=$2',
    [ctx.workspaceId,externalId])).rows[0];
  const payments=async()=>Number((await db.query("SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1 AND direction='CUSTOMER_RECEIPT'",[ctx.workspaceId])).rows[0].n);
  const prepare=(i,bank)=>assistant.prepareAction(db,ctx,'Match the recorded statement credit and exact remittance',
    {action:'customer_payment.match_bank_line',recordReference:i.id,bankTransaction:bank.id});
  const verifyPosted=async(externalId,bank,expected)=>{
    const line=await bankLine(externalId);
    assert.equal(line.status,'MATCHED');
    const payment=(await db.query('SELECT * FROM accounting_payments WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,line.matched_payment_id])).rows[0];
    assert.equal(payment.cash_account_id,bank.cash);
    assert.equal(payment.amount_minor.toString(),String(line.amount_minor));
    const allocations=(await db.query('SELECT customer_invoice_id,amount_minor FROM accounting_payment_allocations WHERE payment_id=$1',
      [payment.id])).rows;
    assert.deepEqual(Object.fromEntries(allocations.map(a=>[a.customer_invoice_id,Number(a.amount_minor)])),expected);
    const journal=(await db.query(`SELECT a.id,a.system_key,l.debit_minor,l.credit_minor FROM accounting_journal_lines l
      JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
      WHERE l.workspace_id=$1 AND l.entry_id=$2 ORDER BY a.code`,[ctx.workspaceId,payment.journal_entry_id])).rows;
    assert.equal(journal.length,2);
    assert.equal(journal.find(l=>l.id===bank.cash).debit_minor.toString(),String(line.amount_minor));
    assert.equal(journal.find(l=>l.system_key==='ACCOUNTS_RECEIVABLE').credit_minor.toString(),String(line.amount_minor));
    return payment;
  };

  const bank=await makeBank('1015','Collections checking');
  const one=await invoice('REMIT-ONE'),two=await invoice('REMIT-TWO','15.00');
  const firstSource=raw('remit-csv-one','10.00','REMIT-ONE=4.00;REMIT-TWO=6.00',
    [today,today,'Bank service fee','-1.25','remit-debit','','USD'].join(',')+'\n');
  await f.subscribe('starter');
  await upload(bank,firstSource,'bank-export.csv');
  const first=await bankLine('remit-csv-one');
  const original=(await db.query('SELECT * FROM stockchief_runtime.bank_statement_originals WHERE id=$1',[first.statement_id])).rows[0];
  assert.deepEqual(original.original,firstSource);assert.equal(original.source_hash,createHash('sha256').update(firstSource).digest('hex'));
  assert.equal(original.row_count,2);assert.equal(original.imported_count,2);assert.equal(first.statement_row,2);
  assert.equal(Number((await bankLine('remit-debit')).amount_minor),-125);
  await upload(bank,firstSource,'same-bank-export.csv');
  assert.equal((await db.query('SELECT count(*)::int n FROM accounting_bank_transactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
  await browser.get('/accounting/banking/statements/'+first.statement_id+'/original').expect(200);
  await browser.get('/autopilot/reviews/customer-payment-matches').expect(402);
  assert.equal(await payments(),0);
  await f.subscribe('growth');
  await mode.save(db,ctx,103,{mode:'routine',revision:0});
  await assert.rejects(prepare(one,first),/Verify this bank/);
  await verify(bank);
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);
  const teaching=(await db.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1
    AND action_type='customer_payment.match_bank_line' AND payload->>'bankTransactionId'=$2`,[ctx.workspaceId,first.id])).rows[0];
  assert(teaching);
  const review=(await browser.get('/actions/'+teaching.id).expect(200)).text;
  assert.match(review,/Invoice allocations/);assert.match(review,/Original bank statement/);assert.match(review,/REMIT-TWO/);
  const responses=await Promise.all([assistant.executeProposal(db,ctx,teaching.id),assistant.executeProposal(db,ctx,teaching.id)]);
  assert.equal(responses[0].result.paymentId,responses[1].result.paymentId);
  assert.equal(await payments(),1);
  await verifyPosted('remit-csv-one',bank,{[one.id]:400,[two.id]:600});
  assert.equal(await balance(one),1600);assert.equal(await balance(two),900);
  await training.save(db,ctx,teaching.id,{mode:'save',maximum:'12.00',revision:0});
  await upload(bank,raw('remit-csv-growth','8.00','REMIT-ONE=5.00;REMIT-TWO=3.00'),'growth.csv');
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);
  await verifyPosted('remit-csv-growth',bank,{[one.id]:500,[two.id]:300});
  const trainedCredit=await bankLine('remit-csv-growth');
  const automaticExample=(await db.query("SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND payload->>'bankTransactionId'=$2",
    [ctx.workspaceId,trainedCredit.id])).rows[0];
  assert.equal((await training.settings(db,ctx,automaticExample.id)).canTeach,false);

  const second=await makeBank('1016','Second collections account');await verify(second);
  await assert.rejects(statements.importStatement(db,ctx,second.id,{buffer:firstSource,filename:'same-export-again.csv'}),/already assigned to another bank account/);
  await upload(second,raw('remit-csv-pro','17.00','REMIT-ONE;REMIT-TWO'),'full-balances.csv');
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0,'Growth cannot carry teaching over to another bank or cash ledger.');
  await f.subscribe('pro');
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);
  await verifyPosted('remit-csv-pro',second,{[one.id]:1100,[two.id]:600});
  assert.equal(await balance(one),0);assert.equal(await balance(two),0);

  const three=await invoice('REMIT-THREE'),four=await invoice('REMIT-FOUR');
  await upload(second,raw('remit-csv-ambiguous','10.00','REMIT-THREE;REMIT-FOUR'),'missing-amounts.csv');
  await assert.rejects(prepare(three,await bankLine('remit-csv-ambiguous')),/do not uniquely exhaust/);
  const incompatible=randomUUID();
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at)
    VALUES($1,$2,'Separate customer','separate-payer@example.test','ACTIVE',$3,now()::text,now()::text)`,[incompatible,ctx.workspaceId,ctx.actorId]);
  await invoice('REMIT-OTHER','20.00',incompatible);
  await upload(second,raw('remit-csv-other','10.00','REMIT-THREE=5.00;REMIT-OTHER=5.00'),'different-payers.csv');
  await assert.rejects(prepare(three,await bankLine('remit-csv-other')),/different customers/);
  await assert.rejects(statements.importStatement(db,ctx,bank.id,{buffer:raw('remit-csv-one','11.00','REMIT-ONE=5.00;REMIT-TWO=6.00'),
    filename:'changed-export.csv'}),/conflicts with the retained/);
  await upload(second,raw('remit-csv-custom','11.00',''),'custom.csv');
  const customCredit=await bankLine('remit-csv-custom');
  await assert.rejects(prepare(three,customCredit),/does not name this invoice/);
  await assert.rejects(statements.attachRemittance(db,ctx,customCredit.id,{buffer:Buffer.from('Invoice,Amount\nREMIT-THREE,10.00\n'),
    filename:'inexact.csv',confirmed:'yes'}),/do not equal this bank credit/);
  const remittanceFile=Buffer.from('Invoice,Amount,Transaction ID,Currency\nREMIT-THREE,5.00,remit-csv-custom,USD\nREMIT-FOUR,6.00,remit-csv-custom,USD\n');
  const bankingPage=(await browser.get('/accounting/banking').expect(200)).text;
  await browser.post('/accounting/banking/transactions/'+customCredit.id+'/remittance').field('_csrf',csrf(bankingPage)).field('confirmed','yes')
    .attach('remittance',remittanceFile,{filename:'customer-remittance.csv',contentType:'text/csv'}).expect(303);
  const savedRemittance=await bankLine('remit-csv-custom');
  assert.equal(savedRemittance.id,customCredit.id);
  const originalRemittance=(await db.query('SELECT original FROM stockchief_runtime.bank_remittance_originals WHERE id=$1',[savedRemittance.remittance_original_id])).rows[0];
  assert.deepEqual(originalRemittance.original,remittanceFile);
  await browser.get('/accounting/banking/remittances/'+savedRemittance.remittance_original_id+'/original').expect(200);
  const pending=await prepare(three,savedRemittance);
  assert.match((await browser.get('/actions/'+pending.proposal.id).expect(200)).text,/Original customer remittance/);
  await f.subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,pending.proposal.id),e=>e.code==='entitlement_required');
  await f.subscribe('enterprise');
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);
  await verifyPosted('remit-csv-custom',second,{[three.id]:500,[four.id]:600});
  assert.equal(await payments(),4);
  await upload(second,raw('remit-csv-malformed','10.00','REMIT-THREE=unreadable;REMIT-FOUR=6.00'),'incomplete-remittance.csv');
  const malformed=await bankLine('remit-csv-malformed');
  assert.equal(malformed.status,'UNMATCHED');assert(malformed.remittance_problem);assert(malformed.statement_id);
  await assert.rejects(prepare(three,malformed),/Review the original bank remittance/);

  const defaultCash=(await db.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'",[ctx.workspaceId])).rows[0].id;
  await post('/accounting/banking/accounts',{name:'Default cash checking',kind:'BANK',ledgerAccountId:defaultCash});
  const defaultBank={id:(await db.query("SELECT id FROM accounting_bank_accounts WHERE workspace_id=$1 AND name='Default cash checking'",[ctx.workspaceId])).rows[0].id,cash:defaultCash};
  const earlier=await invoice('REMIT-PREVIOUS','9.00');
  const posted=await f.workflows.recordCustomerPayment(db,ctx,{customerId,customerInvoiceId:earlier.id,amountMinor:900,paymentDate:today,
    currency:'USD',reference:'prior-native-receipt',method:'BANK_TRANSFER',idempotencyKey:randomUUID()});
  await upload(defaultBank,raw('prior-native-receipt','9.00','REMIT-PREVIOUS=9.00'),'already-posted.csv');
  assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);
  assert.equal(await payments(),5,'Matching a previously recorded exact receipt does not post it again.');
  assert.equal((await bankLine('prior-native-receipt')).matched_payment_id,posted.paymentId);
  await upload(defaultBank,raw('different-native-receipt','9.00','REMIT-PREVIOUS=9.00'),'another-bank-credit.csv');
  await assert.rejects(banking.match(db,ctx,(await bankLine('different-native-receipt')).id,'payment:'+posted.paymentId),/already matches a different bank transaction/);
  assert.equal(Number((await db.query("SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1 AND direction='SUPPLIER_PAYMENT'",[ctx.workspaceId])).rows[0].n),0);
  const impact=(await require('../../src/autopilot/time-saved').report(db,ctx)).rows.find(r=>r.key==='customer-receipt');
  assert.equal(impact.count,5);assert.equal(impact.minutes,null);
});
