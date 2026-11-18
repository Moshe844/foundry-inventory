'use strict';

// Opt-in provider certification. Uses real Stripe test APIs and disposable,
// loopback PostgreSQL only. Never load production connections or billing keys.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs');
async function main(){
 assert.equal(process.env.STOCKCHIEF_CERTIFY_STRIPE_SANDBOX,'1','Explicit sandbox certification opt-in required');
 assert.equal(process.env.NODE_ENV,'test');
 assert.notEqual(process.env.STOCKCHIEF_RUNTIME_ENV,'production');
 assert(!process.env.FOUNDRY_DATABASE_URL&&!process.env.DATABASE_URL,'Production database configuration is forbidden');
 assert(!process.env.STOCKCHIEF_BILLING_STRIPE_SECRET_KEY,'Subscription billing credentials are forbidden');
 const key=process.env.STOCKCHIEF_SANDBOX_STRIPE_KEY;
 assert(/^(rkcs|sk|rk)_test_/.test(key||''),'Only a Stripe sandbox key is accepted');
 process.env.STRIPE_SECRET_KEY=key;
 let providerRequests=0;const realFetch=global.fetch;
 global.fetch=async(input,options={})=>{
  const url=new URL(input);
  assert.equal(url.origin,'https://api.stripe.com','Certification cannot contact another provider');
  assert.equal(options.headers?.Authorization,'Bearer '+key,'Only the sandbox key can leave this process');
  providerRequests++;return realFetch(input,options);
 };
 const cluster=await require('../tests/helpers/postgres-cluster').startCluster();
 assert(['127.0.0.1','localhost'].includes(new URL(cluster.connectionString).hostname));
 const db=require('../src/db/postgres').openPostgres(cluster.connectionString);
 const results=[];
 try{
  await require('../src/db/migrate-postgres').migratePostgres(db);
  async function api(path,values,idempotencyKey){
   const response=await fetch('https://api.stripe.com/v1'+path,{method:values?'POST':'GET',headers:{Authorization:'Bearer '+key,...(values?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},body:values?new URLSearchParams(values):undefined,signal:AbortSignal.timeout(30000)});
   const body=await response.json();
   if(!response.ok)throw Error('Stripe sandbox API '+response.status+' '+(body.error?.code||body.error?.type||'unknown'));
   assert.notEqual(body.livemode,true);return body;
  }
  const account=await api('/account');assert(/^acct_[A-Za-z0-9]+$/.test(account.id));
  const auth=require('../src/domain/postgres-auth-service'),collection=require('../src/payments/postgres-collection');
  const locations=require('../src/domain/postgres-location-service'),catalog=require('../src/domain/postgres-catalog-service');
  const commerce=require('../src/operations/postgres-commerce'),workflows=require('../src/operations/postgres-business-workflows');
  const returns=require('../src/operations/postgres-returns'),provider=require('../src/payments/providers/stripe');
  const jobs=require('../src/operations/postgres-job-queue'),handlers=require('../src/operations/postgres-runtime-handlers').create();
  const run=crypto.randomUUID();
  for(const plan of ['starter','growth','pro']){
   const owner=await auth.createBusiness(db,{name:'Sandbox Owner',businessName:'Sandbox '+plan,email:plan+'-'+run+'@example.test',password:'Test!'+crypto.randomUUID()});
   const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
   await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[crypto.randomUUID(),owner.accountId,plan]);
   const subscriptions=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[owner.accountId])).rows;
   await db.query(`INSERT INTO payment_connect_accounts(id,workspace_id,provider,provider_account_id,display_name,charges_enabled,livemode,checked_at,connected_by_user_id,created_at,updated_at)
    VALUES($1,$2,'stripe',$3,'Isolated Stripe sandbox',1,0,now(),$4,now(),now())`,[crypto.randomUUID(),owner.workspaceId,account.id,owner.userId]);
   const location=await locations.createLocation(db,ctx,{name:'Warehouse',kind:'warehouse'});
   const item=await catalog.createItem(db,ctx,{name:'Sandbox item',baseCode:'SANDBOX-'+plan,trackingMode:'quantity'});
   const supplier=await commerce.createSupplier(db,ctx,{name:'Sandbox supplier',email:'supplier@example.test'});
   const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:supplier.id,destinationLocationId:location.id,idempotencyKey:'po-'+plan,lines:[{skuId:item.skuIds[0],quantityUnits:3,unitCost:5}]});
   await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'approve-'+plan});
   await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'place-'+plan});
   await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'receive-'+plan,reference:'SANDBOX',lines:[{lineId:po.lineIds[0],quantity:3,locationId:location.id}]});
   const customer=await commerce.createCustomer(db,ctx,{name:'Sandbox Customer',email:'customer-'+plan+'-'+run+'@example.test'});
   const order=await workflows.createSalesOrder(db,ctx,{customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:'order-'+plan,lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
   await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'confirm-'+plan});
   await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'fulfill-'+plan,lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:2}]});
   const queued=await collection.queueRequest(db,ctx,order.salesOrderId,{provider:'stripe',purpose:'FULL'});assert(queued.queued);
   await jobs.processOne(db,{'provider.effect':handlers['provider.effect']},{owner:'sandbox-invoice-'+plan,leaseMs:60000});
   const prepared=await collection.get(db,owner.workspaceId,queued.request.id);assert.equal(prepared.status,'OPEN',prepared.lastError);assert(prepared.hostedUrl);assert.equal(prepared.amountMinor,2400);
   const method=await api('/payment_methods/pm_card_visa/attach',{customer:prepared.externalCustomerId},run+':method:'+plan);
   const paid=await api('/invoices/'+prepared.externalInvoiceId+'/pay',{payment_method:method.id},run+':pay:'+plan);assert.equal(paid.status,'paid');assert.equal(paid.amount_paid,2400);
   const paymentContext={stripeSecretKey:key,stripeAccountId:account.id};
   const invoice=await provider.readInvoice(paymentContext,{externalInvoiceId:prepared.externalInvoiceId});
   const event=provider.eventFromInvoice(invoice);assert(event);event.account=account.id;event.livemode=false;
   const evidence=provider.readEvent(event);assert(evidence.externalPaymentId);assert.equal(evidence.amountMinor,2400);
   const applied=await collection.receiveVerifiedEvent(db,owner.workspaceId,'stripe',event);assert.equal(applied.applied,true);
   assert.equal((await collection.receiveVerifiedEvent(db,owner.workspaceId,'stripe',event)).replayed,true);
   assert.equal((await collection.get(db,owner.workspaceId,prepared.id)).paidMinor,2400);
   const quarantine=await locations.createLocation(db,ctx,{name:'Returns',kind:'staging',parentLocationId:location.id});
   const refundResults=[];
   for(const number of [1,2]){
    const requested=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,quarantineLocationId:quarantine.id,resolution:'REFUND',reason:'Stripe sandbox certification',lines:[{salesOrderLineId:order.lineIds[0],quantity:1}],idempotencyKey:'return-'+plan+'-'+number});
    await returns.authorizeCustomerReturn(db,ctx,requested.customerReturnId,{idempotencyKey:'authorize-'+plan+'-'+number});
    const lineId=(await returns.getCustomerReturn(db,owner.workspaceId,requested.customerReturnId)).lines[0].id;
    await returns.receiveCustomerReturn(db,ctx,requested.customerReturnId,{lines:[{lineId,quantity:1}],idempotencyKey:'received-'+plan+'-'+number});
    await returns.inspectCustomerReturn(db,ctx,requested.customerReturnId,{lines:[{lineId,restock:1,scrap:0,repair:0,restockLocationId:location.id}],idempotencyKey:'inspect-'+plan+'-'+number});
    const refund=await collection.queueCustomerReturnRefund(db,ctx,requested.customerReturnId,{});assert(refund.queued);
    // Exercise the exact production refund implementation with real sandbox
    // responses, while keeping the process/database explicitly in test mode.
    const completedRefund=await jobs.processOne(db,{'provider.effect':Object.assign(async(job,client)=>{
     const effect=await require('../src/operations/postgres-provider-effects').get(client,job.workspaceId,job.payload.effectId);
     return require('../src/payments/stripe-return-refunds').execute(client,effect);
    },{externalEffect:true})},{owner:'sandbox-refund-'+plan+'-'+number,leaseMs:60000});
    assert.equal(completedRefund?.status,'COMPLETED',completedRefund?.lastError);
    let saved=(await db.query('SELECT * FROM payment_refund_requests WHERE id=$1',[refund.refund.id])).rows[0];
    if(saved.status!=='SUCCEEDED'){
     const effect=(await db.query('SELECT status,error_code,error_message FROM stockchief_runtime.provider_effects WHERE id=$1',[refund.effectId])).rows[0];
     console.log('STRIPE_SANDBOX_REFUND_REVIEW '+JSON.stringify({plan,number,status:saved.status,error:saved.last_error,effect}).replace(/(?:rkcs|sk|rk|pk)_(?:live|test)_\S+/g,'[private key]'));
     await require('../src/payments/stripe-return-refunds').verify(db,owner.workspaceId,refund.effectId,{system:true});
     saved=(await db.query('SELECT * FROM payment_refund_requests WHERE id=$1',[refund.refund.id])).rows[0];
    }
    assert.equal(saved.status,'SUCCEEDED',saved.last_error);
    const actual=await provider.retrieveRefund(paymentContext,{externalRefundId:saved.external_refund_id,externalPaymentId:evidence.externalPaymentId});
    assert.equal(actual.status,'succeeded');assert.equal(actual.amountMinor,1200);assert.equal(actual.currency,'usd');assert.equal(actual.originalPaymentId,evidence.externalPaymentId);
    assert.equal((await require('../src/payments/stripe-return-refunds').verify(db,owner.workspaceId,refund.effectId,{system:true})).replayed,true);
    refundResults.push({id:actual.externalRefundId,status:actual.status,amountMinor:actual.amountMinor});
   }
   const charge=await api('/payment_intents/'+evidence.externalPaymentId+'?expand[]=latest_charge');assert.equal(charge.latest_charge.amount_refunded,2400);
   assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2',[owner.workspaceId,order.salesOrderId])).rows[0].n),1);
   assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_sale_refunds WHERE workspace_id=$1',[owner.workspaceId])).rows[0].n),2);
   assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[owner.accountId])).rows,subscriptions);
   results.push({plan,invoiceId:prepared.externalInvoiceId,paymentId:evidence.externalPaymentId,paidMinor:2400,refundedMinor:2400,refunds:refundResults,subscriptionUnchanged:true});
   console.log('STRIPE_SANDBOX_PLAN '+JSON.stringify(results.at(-1)));
  }
  const proof={checkedAt:new Date().toISOString(),sandboxAccountId:account.id,liveTransactions:0,providerRequests,source:'actual Stripe sandbox APIs and disposable PostgreSQL',webhookDelivery:'separately qualified; this run reconciles authenticated provider API reads',plans:results};
  fs.mkdirSync('output',{recursive:true});fs.writeFileSync('output/stripe-sandbox-financial-proof.json',JSON.stringify(proof,null,2));
  console.log('STRIPE_SANDBOX_VERIFIED '+JSON.stringify(proof));
 }finally{global.fetch=realFetch;await db.close();await cluster.stop();}
}
main().catch(error=>{console.error('STRIPE_SANDBOX_FAILED '+String(error.message).replace(/(?:rkcs|sk|rk|pk)_(?:live|test)_\S+/g,'[private key]'));process.exitCode=1;});
