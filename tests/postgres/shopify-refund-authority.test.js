'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-return-qualification-fixture');
const payments=require('../../src/payments/postgres-collection');

async function inspect(f){
  const row=await f.get();
  await f.returns.receiveCustomerReturn(f.db,f.ctx,f.returnId,{idempotencyKey:randomUUID(),
    lines:[{lineId:row.lines[0].id,quantity:1}]});
  await f.returns.inspectCustomerReturn(f.db,f.ctx,f.returnId,{idempotencyKey:randomUUID(),
    lines:[{lineId:row.lines[0].id,restock:1,restockLocationId:f.location.id}]});
}

async function mapOrder(f,provider='shopify'){
  const id=randomUUID(),at=new Date().toISOString();
  await f.db.query(`INSERT INTO workspace_connectors
    (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
     expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$3,'Refund source',$4,'connected','["WEBHOOKS"]','["customer orders"]','{}',5,'CONNECTED',$5,$6,$7,$7)`,
  [id,f.ctx.workspaceId,provider+':'+id,provider,f.ctx.actorId,'refund-source.myshopify.com',at]);
  await f.db.query(`INSERT INTO connection_mappings
    (id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,approved_by_user_id,created_at,updated_at)
    VALUES($1,$2,$3,'sales_order','gid://shopify/Order/12345',$4,'approved',$5,$6,$6)`,
  [randomUUID(),f.ctx.workspaceId,id,f.sale.salesOrderId,f.ctx.actorId,at]);
  return id;
}

async function financialState(f){
  const tables=['accounting_journal_entries','accounting_journal_lines','accounting_payments',
    'accounting_sale_refunds','accounting_return_receipt_credits','payment_requests','payment_refund_requests','movements'];
  const records={};
  for(const table of tables)records[table]=(await f.db.query('SELECT * FROM '+table+' WHERE workspace_id=$1 ORDER BY id',[f.ctx.workspaceId])).rows;
  return {records,invoice:await f.invoice(),returned:await f.get(),stock:await f.balance(),cash:await f.control('CASH')};
}

test('Shopify connector payments cannot fall through to an offline CASH refund; non-Shopify offline settlement remains available',
  {timeout:240000},async t=>{
    const f=await fixture(t,{paid:true});
    await inspect(f);
    const connectorId=await mapOrder(f),before=await financialState(f);
    assert.equal(before.records.payment_requests.length,0);
    assert.equal(before.returned.status,'AWAITING_REFUND');
    assert.equal(before.returned.receipt_credit_policy,'RECEIPT_CREDIT_V1');
    assert.equal(f.returns.refundSummary(before.returned).cashDueMinor,1000);

    await assert.rejects(payments.queueCustomerReturnRefund(f.db,f.ctx,f.returnId,{}),error=>{
      assert.match(error.message,/Open this order in Shopify.*original payment processor/);
      assert.equal(error.details.provider,'shopify');
      assert.equal(error.details.url,'https://refund-source.myshopify.com/admin/orders/12345');
      return true;
    });
    const page=await f.browser.get('/returns/'+f.returnId);
    assert.equal(page.status,200);
    const rejected=await f.browser.post('/returns/'+f.returnId+'/refund').set('Referer','/returns/'+f.returnId).type('form')
      .send({_csrf:f.csrf(page.text),destination:'CASH'});
    assert.equal(rejected.status,303);
    assert.equal(rejected.headers.location,'/returns/'+f.returnId);
    assert.match((await f.browser.get(rejected.headers.location)).text,/No cash refund was recorded in StockChief/);
    assert.deepEqual(await financialState(f),before,'Rejection cannot settle a credit, post cash, receive stock or create a provider effect');
    assert.equal((await f.db.query("SELECT count(*)::int n FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='payment.refund.create'",[f.ctx.workspaceId])).rows[0].n,0);

    await f.db.query("UPDATE workspace_connectors SET status='disconnected' WHERE id=$1",[connectorId]);
    await assert.rejects(payments.queueCustomerReturnRefund(f.db,f.ctx,f.returnId,{}),/refund through its original payment processor/);
    assert.deepEqual(await financialState(f),before,'Disconnecting Shopify does not erase its original payment authority');

    await f.db.query("UPDATE workspace_connectors SET provider_type='square',status='connected' WHERE id=$1",[connectorId]);
    const square=await payments.queueCustomerReturnRefund(f.db,f.ctx,f.returnId,{});
    assert.equal(square.noProviderPayment,true,'The Shopify-specific guard does not change existing Square return routing');
    assert.deepEqual(await financialState(f),before);
    await f.db.query('DELETE FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2',[f.ctx.workspaceId,connectorId]);
    const offline=await payments.queueCustomerReturnRefund(f.db,f.ctx,f.returnId,{});
    assert.equal(offline.noProviderPayment,true);
    assert.equal(offline.amountMinor,1000);
    const offlinePage=await f.browser.get('/returns/'+f.returnId);
    const settled=await f.browser.post('/returns/'+f.returnId+'/refund').type('form')
      .send({_csrf:f.csrf(offlinePage.text),destination:'CASH'});
    assert.equal(settled.status,303);
    assert.equal((await f.get()).status,'COMPLETED');
    assert.equal(await f.control('CASH'),before.cash-1000,'A non-Shopify offline refund still records its cash accounting');
    assert.equal(await f.balance(),before.stock,'Refund accounting does not receive stock a second time');
    assert.equal((await f.db.query('SELECT count(*)::int n FROM payment_refund_requests WHERE workspace_id=$1',[f.ctx.workspaceId])).rows[0].n,0);
  });

test('verified original Stripe payment evidence still queues its exact provider refund even after Shopify order mapping',
  {timeout:240000},async t=>{
    const f=await fixture(t),at=new Date().toISOString();
    await f.db.query("UPDATE customers SET email='refund-evidence@example.test' WHERE workspace_id=$1 AND id='fixture-customer'",[f.ctx.workspaceId]);
    await f.db.query(`INSERT INTO payment_connect_accounts
      (id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,connected_by_user_id,created_at,updated_at)
      VALUES($1,$2,'stripe','acct_original_refund','Original merchant',1,0,$3,$4,$3,$3)`,
    [randomUUID(),f.ctx.workspaceId,at,f.ctx.actorId]);
    const request=await payments.queueRequest(f.db,f.ctx,f.sale.salesOrderId,{provider:'stripe',purpose:'FULL'});
    await payments.executeRequestEffect(f.db,f.ctx.workspaceId,request.effectId,{accountContext:()=>({}),provider:{
      ...require('../../src/payments/providers/stripe'),
      createCustomer:async()=>({externalCustomerId:'cus_original_refund'}),
      createInvoice:async()=>({externalInvoiceId:'in_original_refund',hostedUrl:'https://payments.example.test/in_original_refund'})
    }});
    const receipt=await payments.receiveVerifiedEvent(f.db,f.ctx.workspaceId,'stripe',{
      id:'evt_original_refund',account:'acct_original_refund',type:'invoice.paid',
      data:{object:{id:'in_original_refund',amount_paid:2000,currency:'usd',status:'paid',payment_intent:'pi_original_refund'}}
    });
    assert.equal(receipt.applied,true);
    await inspect(f);
    await mapOrder(f);
    const before=await financialState(f);
    const queued=await payments.queueCustomerReturnRefund(f.db,f.ctx,f.returnId,{});
    assert.equal(queued.queued,true);
    assert.equal(queued.refund.provider,'stripe');
    assert.equal(queued.refund.external_payment_id,'pi_original_refund');
    assert.equal(queued.refund.payment_request_id,request.request.id);
    assert.equal(Number(queued.refund.amount_minor),1000);
    assert.equal((await f.get()).status,'AWAITING_REFUND');
    assert.equal(await f.control('CASH'),before.cash,'Queueing an original-provider refund cannot post a cash payout');
    assert.equal(await f.balance(),before.stock);
    assert.deepEqual((await financialState(f)).records.accounting_journal_entries,before.records.accounting_journal_entries);
  });
