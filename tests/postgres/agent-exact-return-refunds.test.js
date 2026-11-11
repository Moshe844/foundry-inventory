
'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-return-qualification-fixture');
const payments=require('../../src/payments/postgres-collection');
const stripe=require('../../src/payments/providers/stripe');
const settlement=require('../../src/operations/agent-return-refunds');
const jobs=require('../../src/operations/postgres-job-queue');

test('exact inspected-return credit and original-payment settlement use the actual posted books',{timeout:240000},async t=>{
  const f=await fixture(t),{db,ctx,workflows,returns,assistant}=f;
  const date=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const customer='fixture-customer';
  const readParts=async returnId=>(await db.query(`SELECT part.*,p.payment_number FROM stockchief_runtime.agent_return_refund_parts part
    JOIN stockchief_runtime.agent_return_refund_plans plan ON plan.id=part.plan_id
    JOIN accounting_payments p ON p.id=part.original_payment_id
    WHERE plan.workspace_id=$1 AND plan.customer_return_id=$2 ORDER BY p.payment_number`,[ctx.workspaceId,returnId])).rows;
  const pay=(sale,invoiceId,amountMinor,method)=>workflows.recordCustomerPayment(db,ctx,{
    customerId:customer,customerInvoiceId:invoiceId,salesOrderId:sale.salesOrderId,amountMinor,paymentDate:date,method,idempotencyKey:randomUUID()
  });
  async function received(returnId){
    const row=await returns.getCustomerReturn(db,ctx.workspaceId,returnId);
    await returns.receiveCustomerReturn(db,ctx,returnId,{idempotencyKey:randomUUID(),lines:[{lineId:row.lines[0].id,quantity:1}]});
    await returns.inspectCustomerReturn(db,ctx,returnId,{idempotencyKey:randomUUID(),
      lines:[{lineId:row.lines[0].id,restock:1,restockLocationId:f.location.id}]});
    return returns.getCustomerReturn(db,ctx.workspaceId,returnId);
  }
  async function sale(input={}){
    const sale=await workflows.createSalesOrder(db,ctx,{customerId:customer,deliveryMethod:'PICKUP',
      fulfillmentLocationId:f.location.id,lines:[{skuId:f.skuId,quantity:2,unitPriceMinor:1313}],idempotencyKey:randomUUID(),...input});
    await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
    const fulfillment=await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),
      lines:[{lineId:sale.lineIds[0],locationId:f.location.id,quantity:2}],shipment:{handover:'COLLECTED'}});
    const requested=await returns.requestCustomerReturn(db,ctx,{salesOrderId:sale.salesOrderId,quarantineLocationId:f.quarantine.id,
      resolution:'REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:sale.lineIds[0],quantity:1}]});
    await returns.authorizeCustomerReturn(db,ctx,requested.customerReturnId,{idempotencyKey:randomUUID()});
    return {sale,invoiceId:fulfillment.invoiceId,returnId:requested.customerReturnId};
  }
  const prepare=(returnId,args={})=>assistant.prepareAction(db,ctx,'Review this exact refund.',
    {action:'customer_return.refund',recordReference:returnId,...args});
  async function prepared(returnId,args){
    const result=await prepare(returnId,args);
    assert.equal(result.status,'PREPARED',JSON.stringify(result));
    return assistant.getProposal(db,ctx.workspaceId,result.proposal.id);
  }

  await t.test('Pro draft and owner approval preserve tax, discount, receivable and split offline receipts',async()=>{
    const at=new Date().toISOString();
    await db.query(`INSERT INTO accounting_tax_rates(id,workspace_id,name,jurisdiction,rate_millionths,applies_to,effective_from,active,created_by_user_id,created_at,updated_at)
      VALUES('refund-tax',$1,'Sales tax','Fixture',82500,'SALES','2020-01-01',1,$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
    const r=await sale({taxRateId:'refund-tax',discountMinor:17});
    const {total_minor}= (await db.query('SELECT total_minor FROM accounting_customer_invoices WHERE id=$1',[r.invoiceId])).rows[0];
    const a=await pay(r.sale,r.invoiceId,300,'cash');
    const b=await pay(r.sale,r.invoiceId,Number(total_minor)-300-200,'bank_transfer');
    const row=await received(r.returnId),expected=returns.refundSummary(row);
    assert.equal(expected.cashDueMinor,expected.totalMinor-200);
    assert(expected.discountMinor>0&&expected.taxMinor>0);
    const p=await prepared(r.returnId,{refundPayments:a.paymentNumber+'=2.50\n'+b.paymentNumber+'='+require('../../src/domain/currency').fromMinor(expected.cashDueMinor-250,'USD')});
    const cash=await f.control('CASH');
    assert.equal(p.payload.discountMinor,expected.discountMinor);
    assert.equal(p.payload.taxMinor,expected.taxMinor);
    assert.equal(p.payload.arMinor,200);
    assert.equal(p.payload.invoice.balanceMinor,0);
    assert.deepEqual(p.payload.parts.map(s=>[s.paymentId,s.method,s.amountMinor]),[
      [a.paymentId,'cash',250],[b.paymentId,'bank_transfer',expected.cashDueMinor-250]
    ]);
    assert.equal((await readParts(r.returnId)).length,0);
    assert.equal(await f.control('CASH'),cash);
    await assistant.executeProposal(db,ctx,p.id);
    await assistant.executeProposal(db,ctx,p.id);
    const parts=await readParts(r.returnId);
    assert.deepEqual(parts.map(x=>[x.original_payment_id,Number(x.amount_minor),x.status]),[
      [a.paymentId,250,'SETTLED'],[b.paymentId,expected.cashDueMinor-250,'SETTLED']
    ]);
    for(const part of parts){
      const lines=(await db.query('SELECT account_id,debit_minor,credit_minor FROM accounting_journal_lines WHERE entry_id=$1',[part.journal_entry_id])).rows;
      assert(lines.some(l=>l.account_id===part.cash_account_id&&Number(l.credit_minor)===Number(part.amount_minor)));
    }
    assert.equal(await f.control('CASH'),cash-expected.cashDueMinor);
    assert.equal(await f.control('CUSTOMER_REFUNDS_PAYABLE'),0);
    assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,r.returnId)).status,'COMPLETED');
    await assert.rejects(workflows.voidPayment(db,ctx,a.paymentId,{reason:'Duplicate receipt correction'}),/already uses this original receipt/);
  });

  await t.test('a credit-only proposal is stale after a native invoice payment',async()=>{
    await received(f.returnId);
    const p=await prepared(f.returnId);
    assert.equal(p.payload.amountMinor,0);
    await pay(f.sale,f.fulfilled.invoiceId,300,'cash');
    await assert.rejects(assistant.executeProposal(db,ctx,p.id),/remaining refund changed/);
    const exact=await prepared(f.returnId);
    assert.equal(exact.payload.invoice.balanceMinor,700);
    const cash=await f.control('CASH');
    await assistant.executeProposal(db,ctx,exact.id);
    assert.equal(await f.control('CASH'),cash);
    assert.equal(Number((await f.invoice()).balance_minor),700);
  });

  await t.test('an existing received legacy return credits sales and clears deferred cost in the same individually approved settlement',async()=>{
    const r=await sale();
    await db.query('UPDATE customer_returns SET receipt_credit_policy=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,r.returnId]);
    await pay(r.sale,r.invoiceId,2400,'cash');
    const row=await received(r.returnId);
    assert.equal(row.receiptCredits.length,0);
    const p=await prepared(r.returnId);
    assert.equal(p.payload.arMinor,226);
    assert.equal(p.payload.amountMinor,1087);
    assert(p.payload.legacyCreditFingerprint);
    const cash=await f.control('CASH'),stock=await f.balance();
    await assistant.executeProposal(db,ctx,p.id);
    assert.equal(await f.control('CASH'),cash-1087);
    assert.equal(await f.control('CUSTOMER_RETURN_COST_PENDING'),0);
    assert.equal(await f.balance(),stock);
    assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,r.returnId)).receipt_credit_policy,'RECEIPT_CREDIT_V1');
    assert.equal((await readParts(r.returnId)).length,1);
  });

  await t.test('Custom approval records offline cash, gates the queued online amount, and books only exact confirmed Stripe evidence',async()=>{
    await f.subscribe('enterprise');
    const r=await sale(),at=new Date().toISOString();
    await db.query(`UPDATE customers SET email='exact-refund@example.test' WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,customer]);
    await db.query(`INSERT INTO payment_connect_accounts(id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,connected_by_user_id,created_at,updated_at)
      VALUES($1,$2,'stripe','acct_exact_refund','Test merchant',1,0,$3,$4,$3,$3)`,[randomUUID(),ctx.workspaceId,at,ctx.actorId]);
    const offline=await pay(r.sale,r.invoiceId,300,'check');
    const request=await payments.queueRequest(db,ctx,r.sale.salesOrderId,{provider:'stripe',purpose:'FULL'});
    await payments.executeRequestEffect(db,ctx.workspaceId,request.effectId,{accountContext:()=>({}),provider:{
      ...stripe,createCustomer:async()=>({externalCustomerId:'cus_exact'}),
      createInvoice:async()=>({externalInvoiceId:'in_exact_refund',hostedUrl:'https://payments.example.test/in_exact_refund'})
    }});
    const online=await payments.receiveVerifiedEvent(db,ctx.workspaceId,'stripe',{id:'evt_exact_refund',account:'acct_exact_refund',
      type:'invoice.paid',data:{object:{id:'in_exact_refund',amount_paid:2326,currency:'usd',status:'paid',payment_intent:'pi_exact_refund'}}});
    assert(online.applied);
    await received(r.returnId);
    const p=await prepared(r.returnId);
    assert.deepEqual(p.payload.parts.map(s=>[s.paymentId,s.method,s.amountMinor]),[[offline.paymentId,'check',300],[online.paymentId,'stripe',1013]]);
    const cash=await f.control('CASH');
    await assistant.executeProposal(db,ctx,p.id);
    assert.equal(await f.control('CASH'),cash-300);
    assert.equal((await readParts(r.returnId))[1].status,'APPROVED');
    await assert.rejects(returns.refundCustomerReturn(db,ctx,r.returnId,{destination:'CASH',idempotencyKey:randomUUID()}),/already approved refund/);
    const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='payment.refund.create'",
      [ctx.workspaceId,r.returnId])).rows[0];
    let posts=0,gets=0,providerStatus='pending',providerAmount=1013;
    const options={accountContext:()=>({stripeSecretKey:'sk_test_fixture',stripeAccountId:'acct_exact_refund',stripeFetch:async(url,input)=>{
      assert.equal(input.headers['Stripe-Account'],'acct_exact_refund');
      if(input.method==='POST'){
        posts++;
        assert.match(url,/\/refunds$/);
        assert.match(input.headers['Idempotency-Key'],/^agent-return-refund:/);
        assert.equal(input.body.get('payment_intent'),'pi_exact_refund');
        assert.equal(input.body.get('amount'),'1013');
      }else{gets++;assert.match(url,/\/refunds\/re_exactrefund$/);}
      return new Response(JSON.stringify({id:'re_exactrefund',payment_intent:'pi_exact_refund',amount:providerAmount,
        currency:'usd',status:providerStatus}),{status:200});
    }})};
    await f.subscribe('growth');
    await assert.rejects(payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options),e=>e.code==='entitlement_required');
    assert.equal(posts,0);
    await f.subscribe('enterprise');
    await db.query("UPDATE accounting_periods SET status='CLOSED' WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2",[ctx.workspaceId,date]);
    await assert.rejects(payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options),/closed/);
    assert.equal(posts,0);
    await db.query("UPDATE accounting_periods SET status='OPEN' WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2",[ctx.workspaceId,date]);
    const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{
      paymentProviderResolver:()=>stripe,paymentAccountContext:options.accountContext
    });
    const kind=require('../../src/operations/agent-return-refund-protocol').JOB;
    await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'exact-refund-worker'});
    assert.equal(posts,1);
    assert.equal((await readParts(r.returnId))[1].status,'REVIEW');
    assert.equal(await f.control('CASH'),cash-300);
    assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,r.returnId)).status,'AWAITING_REFUND');
    await assert.rejects(payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options),/uncertain/);
    const part=(await readParts(r.returnId))[1];
    providerStatus='succeeded';
    providerAmount=1012;
    await assert.rejects(settlement.verifyProviderPart(db,ctx,r.returnId,part.id,options),/not confirmed this exact/);
    assert.equal(await f.control('CASH'),cash-300);
    providerAmount=1013;
    await settlement.verifyProviderPart(db,ctx,r.returnId,part.id,options);
    await settlement.verifyProviderPart(db,ctx,r.returnId,part.id,options);
    assert.equal(posts,1);
    assert.equal(gets,2);
    assert.equal(await f.control('CASH'),cash-1313);
    assert.equal((await readParts(r.returnId))[1].external_refund_id,'re_exactrefund');
    assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,r.returnId)).status,'COMPLETED');

    const another=await returns.requestCustomerReturn(db,ctx,{salesOrderId:r.sale.salesOrderId,quarantineLocationId:f.quarantine.id,
      resolution:'REFUND',idempotencyKey:randomUUID(),lines:[{salesOrderLineId:r.sale.lineIds[0],quantity:1}]});
    await returns.authorizeCustomerReturn(db,ctx,another.customerReturnId,{idempotencyKey:randomUUID()});
    await received(another.customerReturnId);
    const fresh=await prepared(another.customerReturnId);
    await payments.receiveVerifiedEvent(db,ctx.workspaceId,'stripe',{id:'evt_prior_external_refund',account:'acct_exact_refund',
      type:'charge.refunded',data:{object:{id:'ch_exact_refund',invoice:'in_exact_refund',payment_intent:'pi_exact_refund',amount_refunded:1113}}});
    await assert.rejects(assistant.executeProposal(db,ctx,fresh.id),/original provider reports another refund/);
    await assert.rejects(prepare(another.customerReturnId),/original provider reports another refund/);
    assert.equal((await readParts(another.customerReturnId)).length,0);
  });

  await t.test('Sola approval uses its verified original sale and its documented refund reference',async()=>{
    const previous=process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED;
    process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED='true';
    t.after(()=>{if(previous===undefined)delete process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED;
      else process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED=previous;});
    const gateway=require('../../src/payments/postgres-cardknox'),adapter=require('../../src/payments/providers/cardknox');
    await gateway.connect(db,ctx,{apiKey:'refund-fixture-key',ifieldsKey:'refund-fixture-ifields',testMode:'true'},{verify:async()=>true});
    const r=await sale();
    const request=await payments.queueRequest(db,ctx,r.sale.salesOrderId,{provider:'cardknox'});
    await payments.executeRequestEffect(db,ctx.workspaceId,request.effectId,{accountContext:async account=>({
      ...await gateway.context(db,account),publicOrigin:'http://127.0.0.1'
    })});
    const native=await payments.get(db,ctx.workspaceId,request.request.id);
    const paid=await gateway.pay(db,new URL(native.hostedUrl).pathname.split('/').at(-1),{
      cardToken:'secure-sut-card-fixture-1234567890',cvvToken:'secure-sut-cvv-fixture-1234567890',expiry:'0130'
    },{sale:async()=>({xResult:'A',xRefNum:'10000016912',xAmount:'26.26',xCurrency:'USD'})});
    assert.equal(paid.applied,true);
    await received(r.returnId);
    const p=await prepared(r.returnId);
    assert.deepEqual(p.payload.parts.map(s=>[s.method,s.amountMinor]),[['cardknox',1313]]);
    const cash=await f.control('CASH');
    await assistant.executeProposal(db,ctx,p.id);
    assert.equal(await f.control('CASH'),cash);
    const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='payment.refund.create'",
      [ctx.workspaceId,r.returnId])).rows[0];
    let calls=0;
    const options={provider:adapter,accountContext:async account=>({...await gateway.context(db,account),cardknoxOptions:{
      fetch:async(url,input)=>{
        calls++;
        assert.match(url,/\/gatewayjson$/);
        const request=JSON.parse(input.body);
        assert.equal(request.xCommand,'cc:refund');
        assert.equal(request.xRefNum,'10000016912');
        assert.equal(request.xAmount,'13.13');
        assert.equal(request.xAllowDuplicate,'FALSE');
        return new Response(JSON.stringify({xResult:'A',xStatus:'Approved',xRefNum:'10000016913',xAuthAmount:'13.13',xCurrency:'USD'}),{status:200});
      }
    }})};
    await payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options);
    await payments.executeRefundEffect(db,ctx.workspaceId,effect.id,options);
    assert.equal(calls,1);
    assert.equal(await f.control('CASH'),cash-1313);
    assert.equal((await readParts(r.returnId))[0].external_refund_id,'10000016913');
    assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,r.returnId)).status,'COMPLETED');
  });
});
