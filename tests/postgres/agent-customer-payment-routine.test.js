'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('scheduled receipt matching needs explicit current owner authority and never exceeds the plan or taught limit',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
 const auto=require('../../src/autopilot/postgres-service'),receipts=require('../../src/accounting/agent-customer-payment-matches'),assistant=require('../../src/assistant/postgres-service'),modes=require('../../src/autopilot/job-modes'),authority=require('../../src/autopilot/draft-authority');
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const parcel=await f.parcel();await f.shipping.markPacked(db,ctx,parcel.shipmentId);await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',trackingNumber:randomUUID(),carrier:'UPS'});
 const cash=(await db.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='CASH'",[ctx.workspaceId])).rows[0].id,bank=randomUUID(),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 await db.query(`INSERT INTO accounting_bank_accounts(id,workspace_id,name,account_kind,currency,ledger_account_id,active,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Routine receipts','BANK','USD',$3,1,$4,now()::text,now()::text)`,[bank,ctx.workspaceId,cash,ctx.actorId]);
 async function credit(amount='3.00',customerId='fixture-customer',documentNumber,bankId=bank){
  const invoice=await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId,description:'Customer services',quantity:1,unitAmount:'20.00',issueDate:today,idempotencyKey:randomUUID(),documentNumber});
  const row=(await db.query('SELECT * FROM accounting_customer_invoices WHERE id=$1',[invoice.id])).rows[0];
  const source=(await require('../../src/accounting/postgres-banking').importOne(db,ctx,bankId,{transactionDate:today,amount,description:row.invoice_number,externalId:randomUUID()})).transaction;
  return {invoice:row,source};
 }
 const balance=async x=>Number((await db.query('SELECT balance_minor FROM accounting_customer_invoices WHERE id=$1',[x.invoice.id])).rows[0].balance_minor),count=async()=>Number((await db.query("SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1 AND direction='CUSTOMER_RECEIPT'",[ctx.workspaceId])).rows[0].n);
 let revision=0;async function mode(value){await modes.save(db,ctx,103,{mode:value,revision});revision++;}
 const first=await credit();assert.deepEqual(await receipts.run(db,ctx.workspaceId),{matched:0,waiting:0,skipped:0});assert.equal(await balance(first),2000,'Global automatic work alone cannot silently enable receipt matching.');
 await mode('routine');await subscribe('growth');const held=await receipts.run(db,ctx.workspaceId);assert.equal(held.waiting,1);assert.equal(await count(),0);
 const example=(await db.query("SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type='customer_payment.match_bank_line'",[ctx.workspaceId])).rows[0];
 await assistant.executeProposal(db,ctx,example.id);await authority.save(db,ctx,example.id,{mode:'save',maximum:'5.00',revision:0});
 const routine=await credit();const ran=await auto.run(db,{...ctx,actorId:'untrusted-worker-actor'});assert.equal(ran.customerReceipts.matched,1);assert.equal(await balance(routine),1700);assert.equal(await count(),2);
 assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await count(),2,'A repeated scheduler run never creates a second payment.');
 const waiting=await credit();await auto.pause(db,ctx,{role:'owner'},'Owner paused');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(waiting),2000);await auto.resume(db,ctx,{role:'owner'});
 await mode('ask');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);await mode('watch');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);await mode('routine');
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await subscribe('starter');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(waiting),2000);await subscribe('growth');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);
 const excessive=await credit('6.00');for(const tier of ['growth','pro','enterprise']){await subscribe(tier);assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(excessive),2000,'Every plan honors a lower limit the owner explicitly chose.');}
 const normal=await credit('2.00');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);assert.equal(await balance(normal),1800);
 const atomic=await credit('1.00'),banking=require('../../src/accounting/postgres-banking'),originalMatch=banking.match,beforeAtomic=await count();
 try{
  banking.match=async()=>{throw new(require('../../src/domain/errors').ValidationError)('Simulated hold after recording receipt');};
  const failed=await db.transaction(c=>receipts.run({query:c.query.bind(c),transaction:fn=>fn(c)},ctx.workspaceId));assert(failed.waiting>0);
  assert.equal(await count(),beforeAtomic);assert.equal(await balance(atomic),2000,'A late validation hold rolls back all payment, allocation and ledger writes even inside the worker transaction.');
 }finally{banking.match=originalMatch;}
 const actualWorker=await db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({workspaceId:ctx.workspaceId,id:randomUUID(),payload:{actorId:ctx.actorId,requestedByUser:true}},c));
 assert.equal(actualWorker.customerReceipts.matched,1);assert.equal(await balance(atomic),1900);
 for(const tier of ['pro','enterprise']){
  const otherBank=randomUUID();await db.query(`INSERT INTO accounting_bank_accounts(id,workspace_id,name,account_kind,currency,ledger_account_id,active,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Other receipt bank '||$5,'BANK','USD',$3,1,$4,now()::text,now()::text)`,[otherBank,ctx.workspaceId,cash,ctx.actorId,tier]);
  const untrained=await credit('1.00','fixture-customer',undefined,otherBank);await subscribe('growth');assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(untrained),2000,'Growth cannot reuse another bank account’s teaching.');
  await subscribe(tier);assert.equal((await receipts.run(db,ctx.workspaceId)).matched,1);assert.equal(await balance(untrained),1900,'Pro and Custom can run clear matches without a new taught scope.');
 }
 const time=require('../../src/autopilot/time-saved'),unmeasured=(await time.report(db,ctx)).rows.find(r=>r.key==='customer-receipt');assert.equal(unmeasured.count,await count());assert.equal(unmeasured.minutes,null);
 await time.sample(db,ctx,{activity:'customer-receipt',manualMinutes:5,reviewMinutes:1,requestKey:randomUUID()});
 assert.equal((await time.report(db,ctx)).rows.find(r=>r.key==='customer-receipt').minutes,4*await count(),'Savings use the owner’s timed sample and actual matched receipts only.');
 const customer=randomUUID();await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,'First routine payer','first-routine@example.test','ACTIVE',$3,now()::text,now()::text)",[customer,ctx.workspaceId,ctx.actorId]);
 const newcomer=await credit('1.00',customer);assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(newcomer),2000,'Even Custom cannot automatically accept the first B2B customer receipt.');
 const ambiguous=await credit('1.00','fixture-customer','CASE-SAME');await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId:'fixture-customer',description:'Other invoice',quantity:1,unitAmount:'20.00',issueDate:today,idempotencyKey:randomUUID(),documentNumber:'case-same'});
 assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(ambiguous),2000,'Case-insensitive bank references cannot choose between two distinct invoice numbers.');
 const disabled=await credit('1.00');await db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES($1,now(),'Test disabled owner',$1)",[f.owner.accountId]);assert.equal((await receipts.run(db,ctx.workspaceId)).matched,0);assert.equal(await balance(disabled),2000);
 await assert.rejects(assistant.executeReceiptRoutine(db,ctx,example.id),e=>e.code==='entitlement_required');
 await db.query('DELETE FROM platform_account_access WHERE account_id=$1',[f.owner.accountId]);
 const proposal=(await db.query("SELECT id FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND payload->>'bankTransactionId'=$2",[ctx.workspaceId,excessive.source.id])).rows[0];
 await mode('ask');await assert.rejects(assistant.executeReceiptRoutine(db,ctx,proposal.id),/owner must enable/);await assistant.executeProposal(db,ctx,proposal.id);assert.equal(await balance(excessive),1400,'The actual owner can review and approve an above-limit receipt individually.');
 assert.equal(await f.balance(),3,'Receipt automation never alters physical stock.');
});
