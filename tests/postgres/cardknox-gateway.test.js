'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
process.env.NODE_ENV='test';
test('Sola adapter uses isolated encrypted merchant keys and canonical payment accounting',{timeout:120000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,gateway=require('../../src/payments/postgres-cardknox'),payments=require('../../src/payments/postgres-collection');
 const previous=process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED;process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED='true';t.after(()=>{if(previous===undefined)delete process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED;else process.env.STOCKCHIEF_CARDKNOX_PAYMENTS_ENABLED=previous;});
 let verified=0;await gateway.connect(db,ctx,{apiKey:'private-fixture-key-one',ifieldsKey:'public-fixture-ifields',testMode:'true'},{verify:async key=>{assert.equal(key,'private-fixture-key-one');verified++;}});
 await t.test('only the owner can connect; credentials are encrypted and never inherited',async()=>{
  assert.equal(verified,1);const rows=(await db.query("SELECT ciphertext FROM connection_credentials WHERE workspace_id=$1 AND credential_kind='provider'",[ctx.workspaceId])).rows;assert.ok(rows.every(r=>!r.ciphertext.includes('private-fixture')));
  await assert.rejects(gateway.connect(db,{workspaceId:ctx.workspaceId,actorId:'other-tenant-user'},{apiKey:'other',ifieldsKey:'public'},{verify:async()=>{throw Error('must not call provider');}}),/Only an owner/);
  await assert.rejects(payments.accountFor(db,'another-workspace','cardknox'),/own payment account/);assert.deepEqual(await payments.availableProviders(db,ctx.workspaceId),['cardknox']);
 });
 async function request(key){const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:key,lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]});await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:key+'-confirm'});await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:key+'-fulfill',lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:1}]});
  const queued=await payments.queueRequest(db,ctx,order.salesOrderId,{provider:'cardknox'});await payments.executeRequestEffect(db,ctx.workspaceId,queued.effectId,{accountContext:async account=>({...await gateway.context(db,account),publicOrigin:'http://127.0.0.1'})});const row=await payments.get(db,ctx.workspaceId,queued.request.id);return {row,token:new URL(row.hostedUrl).pathname.split('/').at(-1)};}
 const tokens={cardToken:'secure-sut-card-fixture-1234567890',cvvToken:'secure-sut-cvv-fixture-1234567890',expiry:'0130'};
 const first=await request('sola-first');
 await t.test('two submissions produce one gateway sale and one canonical receipt',async()=>{
  let calls=0;const sale=async(held,input)=>{assert.equal(held.cardknoxApiKey,'private-fixture-key-one');assert.equal(input.amountMinor,1200);calls++;return {xResult:'A',xRefNum:'sola-test-transaction-1',xAmount:'12.00',xCurrency:'USD'};};
  await Promise.all([gateway.pay(db,first.token,tokens,{sale}),gateway.pay(db,first.token,tokens,{sale})]);await gateway.pay(db,first.token,{}, {sale});assert.equal(calls,1);
  const row=await payments.get(db,ctx.workspaceId,first.row.id);assert.equal(row.status,'PAID');assert.equal(row.paidMinor,1200);
  const posted=(await db.query("SELECT count(*) n,sum(amount_minor) amount FROM accounting_payments WHERE workspace_id=$1 AND method='cardknox' AND direction='CUSTOMER_RECEIPT'",[ctx.workspaceId])).rows[0];assert.equal(Number(posted.n),1);assert.equal(Number(posted.amount),1200);
 });
 const second=await request('sola-uncertain');
 await t.test('unknown network outcomes retain the attempt and never charge again automatically',async()=>{
  let calls=0;const sale=async()=>{calls++;throw Error('timeout after provider accepted');};assert.equal((await gateway.pay(db,second.token,tokens,{sale})).status,'UNKNOWN');assert.equal((await gateway.pay(db,second.token,tokens,{sale})).status,'UNKNOWN');assert.equal(calls,1);assert.equal((await payments.get(db,ctx.workspaceId,second.row.id)).paidMinor,0);
 });
 const third=await request('sola-invalid');
 await t.test('raw PAN/CVV and changed invoice balances stop before any gateway call',async()=>{
  let calls=0;const sale=async()=>{calls++;};await assert.rejects(gateway.pay(db,third.token,{...tokens,cardToken:'4444333322221111'},{sale}),/secure Sola/);
  await db.query('UPDATE accounting_customer_invoices SET balance_minor=1000 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,third.row.invoiceId]);await assert.rejects(gateway.pay(db,third.token,tokens,{sale}),/balance changed/);assert.equal(calls,0);
 });
 await t.test('return refunds follow the original Sola payment and post once after confirmation',async()=>{
  const returns=require('../../src/operations/postgres-returns'),line=(await db.query('SELECT id FROM sales_order_lines WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,first.row.salesOrderId])).rows[0];
  const r=await returns.requestCustomerReturn(db,ctx,{salesOrderId:first.row.salesOrderId,quarantineLocationId:f.location.id,resolution:'REFUND',lines:[{salesOrderLineId:line.id,quantity:1}],idempotencyKey:'sola-rma'});await returns.authorizeCustomerReturn(db,ctx,r.customerReturnId,{idempotencyKey:'sola-rma-authorize'});const record=await returns.getCustomerReturn(db,ctx.workspaceId,r.customerReturnId);
  await returns.receiveCustomerReturn(db,ctx,record.id,{lines:[{lineId:record.lines[0].id,quantity:1}],idempotencyKey:'sola-rma-receive'});await returns.inspectCustomerReturn(db,ctx,record.id,{lines:[{lineId:record.lines[0].id,restock:1,restockLocationId:f.location.id}],idempotencyKey:'sola-rma-inspect'});
  const queued=await payments.queueCustomerReturnRefund(db,ctx,record.id,{});assert.equal(queued.refund.provider,'cardknox');let calls=0;
  const options={accountContext:account=>gateway.context(db,account),provider:{refundPayment:async(context,input)=>{assert.equal(context.cardknoxApiKey,'private-fixture-key-one');assert.equal(input.externalPaymentId,'sola-test-transaction-1');assert.equal(input.amountMinor,1200);calls++;return {externalRefundId:'sola-test-refund-1'};}}};
  await payments.executeRefundEffect(db,ctx.workspaceId,queued.effectId,options);await payments.executeRefundEffect(db,ctx.workspaceId,queued.effectId,options);assert.equal(calls,1);assert.equal((await returns.getCustomerReturn(db,ctx.workspaceId,record.id)).status,'COMPLETED');
 });
 await t.test('merchant changes invalidate older payment links instead of using a new merchant key',async()=>{
  const mismatch=await request('sola-receipt-mismatch');const result=await gateway.pay(db,mismatch.token,tokens,{sale:async()=>({xResult:'A',xRefNum:'review-reference',xAmount:'12.00',xCurrency:'USD',xInvoice:'different-invoice'})});assert.equal(result.status,'UNKNOWN');assert.equal((await payments.get(db,ctx.workspaceId,mismatch.row.id)).paidMinor,0);
  await gateway.connect(db,ctx,{apiKey:'private-fixture-key-two',ifieldsKey:'public-fixture-second',testMode:'true'},{verify:async()=>{}});
  await assert.rejects(gateway.session(db,second.token),/expired or the merchant disconnected/);
 });
});
