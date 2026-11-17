'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const priorEnvironment={...process.env};
const platformId=require('../../src/commercial/stripe-live-fee-evidence').accountId;
Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_CHECKOUT_ENABLED:'true',
 STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:platformId,STOCKCHIEF_STRIPE_CONNECT_PLATFORM_ACCOUNT_ID:platformId,
 STRIPE_CONNECT_CLIENT_ID:'ca_Fixture',STRIPE_SECRET_KEY:'sk_live_isolated_fixture',STRIPE_WEBHOOK_SECRET:'whsec_isolated_fixture',
 STOCKCHIEF_STRIPE_CONNECT_ENABLED:'0',STOCKCHIEF_STRIPE_CONNECT_PILOT_WORKSPACES:''});
test('production Stripe OAuth proves each paid plan, preserves billing and refuses unsafe merchant grants',{timeout:240000},async t=>{
 const originalFetch=global.fetch,cluster=await require('../helpers/postgres-cluster').startCluster();
 const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const connect=require('../../src/payments/postgres-connect'),release=require('../../src/commercial/release');
 const auth=require('../../src/domain/postgres-auth-service'),qualification=require('../../src/payments/stripe-live-qualification');
 const accounts=new Map(),grants=new Map(),calls=[],invoices=new Map();
 global.fetch=async(input,options={})=>{
  const url=new URL(input);assert(['api.stripe.com','connect.stripe.com'].includes(url.hostname),'Synthetic fixture forbids all other provider calls');
  calls.push({host:url.hostname,path:url.pathname,method:options.method||'GET'});
  if(url.hostname==='connect.stripe.com'&&url.pathname==='/oauth/token'){
   const code=new URLSearchParams(options.body).get('code');assert(grants.has(code),'Only fixture authorization codes are allowed');
   return Response.json({...grants.get(code),access_token:'sk_live_child_fixture_must_never_be_retained',refresh_token:'rt_child_fixture'});
  }
  if(url.hostname==='api.stripe.com'&&url.pathname.startsWith('/v1/accounts/')){
   const id=url.pathname.split('/').at(-1);assert(accounts.has(id));return Response.json(accounts.get(id));
  }
  if(url.hostname==='api.stripe.com'){
   const merchant=options.headers['Stripe-Account'];assert(accounts.has(merchant),'Every financial API request must belong to its own merchant');
   assert(options.headers['Idempotency-Key'],'Financial writes require idempotency');
   const form=new URLSearchParams(options.body);
   if(url.pathname==='/v1/customers')return Response.json({id:merchant.replace(/^acct_/,'cus_')});
   if(url.pathname==='/v1/invoices'){const id=merchant.replace(/^acct_/,'in_');invoices.set(id,{id,total:0,status:'draft'});return Response.json({id});}
   if(url.pathname==='/v1/invoiceitems'){const invoice=invoices.get(form.get('invoice'));assert(invoice);invoice.total=Number(form.get('amount'));return Response.json({id:'ii_'+merchant});}
   if(url.pathname==='/v1/invoices/'+merchant.replace(/^acct_/,'in_')+'/finalize'){const invoice=invoices.get(merchant.replace(/^acct_/,'in_'));invoice.status='open';return Response.json({...invoice,hosted_invoice_url:'https://invoice.stripe.com/i/'+invoice.id});}
  }
  throw Error('Unexpected Stripe operation '+url.pathname);
 };
 t.after(async()=>{global.fetch=originalFetch;process.env=priorEnvironment;await db.close();await cluster.stop();});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID()});
 t.after(async()=>{await app.locals.sessionStore.close();});
 await db.query('UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true');
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 const fixtures=[];
 async function fixture(plan,suffix=plan){
  const owner=await auth.createBusiness(db,{name:'Owner',businessName:'Stripe '+suffix,email:crypto.randomUUID()+'@example.test',password:'Test!'+crypto.randomUUID()});
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[crypto.randomUUID(),owner.accountId,plan]);
  const f={owner,ctx:{workspaceId:owner.workspaceId,actorId:owner.userId},plan,accountId:'acct_Merchant'+suffix.replaceAll('-','')};
  assert(f.ctx.actorId,'Fixture needs the real owner user ID');fixtures.push(f);
  process.env.STOCKCHIEF_STRIPE_CONNECT_PILOT_WORKSPACES=fixtures.map(x=>x.owner.workspaceId).join(',');
  accounts.set(f.accountId,{id:f.accountId,type:'standard',charges_enabled:true,controller:{type:'account'},business_profile:{name:'Fixture '+suffix}});
  return f;
 }
 async function begin(f){return connect.begin(db,f.ctx,{publicOrigin:'https://app.stockchiefhq.com',requestOrigin:'https://app.stockchiefhq.com'});}
 async function complete(f,extra={},started=null){
  const url=new URL((started||await begin(f)).redirectUrl),code=crypto.randomUUID();
  grants.set(code,{stripe_user_id:f.accountId,livemode:true,scope:'read_write',...extra});
  return connect.complete(db,{state:url.searchParams.get('state'),code});
 }
 for(const plan of ['starter','growth','pro'])await t.test(plan+' connects and refreshes its own Standard account without closing subscription checkout',async()=>{
  const f=await fixture(plan),before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
  const done=await complete(f);assert.equal(done.connected,true);assert.equal(done.liveMode,true);assert.equal(done.chargesEnabled,true);
  const row=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[done.connectorId])).rows[0];
  const config=JSON.parse(row.config);assert(qualification.valid(config.stripeConnectEvidence,f.accountId));
  assert.equal(row.credential_ref,null);assert(!JSON.stringify(row).includes('sk_live_child'));assert(!JSON.stringify(row).includes('rt_child'));
  assert.equal(await release.isOpen(db),true,'A qualified merchant must not close paid signup');
  const refreshed=await connect.refresh(db,f.owner.workspaceId);assert.equal(refreshed.liveMode,true,'V1 Account omits livemode; retain the verified OAuth mode');
  assert.equal(await release.isOpen(db),true);
  assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before);
 });
 async function webhook(event,valid=true){
  const raw=JSON.stringify(event),timestamp=String(Math.floor(Date.now()/1000));
  const signature=crypto.createHmac('sha256',valid?process.env.STRIPE_WEBHOOK_SECRET:'wrong-fixture-key').update(timestamp+'.'+raw).digest('hex');
  return require('supertest')(app).post('/webhooks/payments/stripe').set('stripe-signature','t='+timestamp+',v1='+signature).type('application/json').send(raw);
 }
 for(const f of fixtures.slice(0,3))await t.test(f.plan+' runs the real invoice worker and records one signed merchant payment without touching the subscription',async()=>{
  const locations=require('../../src/domain/postgres-location-service'),catalog=require('../../src/domain/postgres-catalog-service');
  const commerce=require('../../src/operations/postgres-commerce'),workflows=require('../../src/operations/postgres-business-workflows');
  const collection=require('../../src/payments/postgres-collection');
  const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
  const location=await locations.createLocation(db,f.ctx,{name:'Warehouse',kind:'warehouse'});
  const item=await catalog.createItem(db,f.ctx,{name:'Merchant fixture item',baseCode:'PAY-'+f.plan,trackingMode:'quantity'});
  const supplier=await commerce.createSupplier(db,f.ctx,{name:'Supplier',email:'supplier@example.test'});
  const po=await workflows.createPurchaseOrder(db,f.ctx,{supplierId:supplier.id,destinationLocationId:location.id,idempotencyKey:'po-'+f.plan,lines:[{skuId:item.skuIds[0],quantityUnits:3,unitCost:5}]});
  await workflows.approvePurchaseOrder(db,f.ctx,po.purchaseOrderId,{idempotencyKey:'approve-'+f.plan});
  await workflows.placePurchaseOrder(db,f.ctx,po.purchaseOrderId,{idempotencyKey:'place-'+f.plan});
  await workflows.receivePurchaseOrder(db,f.ctx,po.purchaseOrderId,{idempotencyKey:'receive-'+f.plan,reference:'FIXTURE',lines:[{lineId:po.lineIds[0],quantity:3,locationId:location.id}]});
  const customer=await commerce.createCustomer(db,f.ctx,{name:'Customer',email:'customer@example.test'});
  const order=await workflows.createSalesOrder(db,f.ctx,{customerId:customer.id,deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,idempotencyKey:'order-'+f.plan,lines:[{skuId:item.skuIds[0],quantity:2,unitPriceMinor:1200}]});
  await workflows.confirmSalesOrder(db,f.ctx,order.salesOrderId,{idempotencyKey:'confirm-'+f.plan});
  await workflows.fulfillSalesOrder(db,f.ctx,order.salesOrderId,{idempotencyKey:'fulfill-'+f.plan,lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:2}]});
  const queued=await collection.queueRequest(db,f.ctx,order.salesOrderId,{provider:'stripe',purpose:'FULL'});assert(queued.queued);
  await require('../../src/operations/postgres-job-queue').processOne(db,{'provider.effect':require('../../src/operations/postgres-runtime-handlers').create()['provider.effect']},{owner:'stripe-'+f.plan,leaseMs:30000});
  const prepared=await collection.get(db,f.owner.workspaceId,queued.request.id);assert.equal(prepared.status,'OPEN');assert.equal(prepared.externalInvoiceId,f.accountId.replace(/^acct_/,'in_'));assert.equal(prepared.amountMinor,2400);
  const event={id:'evt_paid_'+f.plan,account:f.accountId,livemode:true,created:Math.floor(Date.now()/1000),type:'invoice.paid',data:{object:{id:prepared.externalInvoiceId,payment_intent:'pi_'+f.plan,amount_paid:2400,currency:'usd',status_transitions:{paid_at:Math.floor(Date.now()/1000)}}}};
  assert.equal((await webhook(event,false)).status,401);assert.equal((await collection.get(db,f.owner.workspaceId,queued.request.id)).paidMinor,0);
  const paid=await webhook(event);assert.equal(paid.status,200,paid.text);assert.equal(paid.body.applied,true);
  const replay=await webhook(event);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);
  assert.equal((await collection.get(db,f.owner.workspaceId,queued.request.id)).paidMinor,2400);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM accounting_payments WHERE workspace_id=$1 AND sales_order_id=$2',[f.owner.workspaceId,order.salesOrderId])).rows[0].n),1);
  assert.equal(await release.isOpen(db),true,'Financial requests and signed reconciliation must not close subscription signup');
  assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before);
 });
 await t.test('signed test events are ignored and deauthorization cannot be reversed by a later profile update',async()=>{
  const f=fixtures[0],created=Math.floor(Date.now()/1000)+10;
  const base={account:f.accountId,created,livemode:true,type:'account.updated',data:{object:accounts.get(f.accountId)}};
  const before=(await db.query('SELECT count(*) AS n FROM payment_provider_events')).rows[0].n;
  const ignored=await webhook({...base,id:'evt_test',livemode:false});assert.equal(ignored.status,200);assert.equal(ignored.body.ignored,'test_event');assert.equal((await db.query('SELECT count(*) AS n FROM payment_provider_events')).rows[0].n,before);
  const changed=await webhook({...base,id:'evt_account'});assert.equal(changed.status,200,changed.text);
  const revoked=await webhook({...base,id:'evt_revoked',created:created+1,type:'account.application.deauthorized',data:{object:{id:process.env.STRIPE_CONNECT_CLIENT_ID}}});assert.equal(revoked.status,200,revoked.text);
  assert.equal(Number((await connect.rowFor(db,f.owner.workspaceId)).charges_enabled),0);
  const stale=await webhook({...base,id:'evt_stale'});assert.equal(stale.status,200);assert.equal(Number((await connect.rowFor(db,f.owner.workspaceId)).charges_enabled),0);
  const newer=await webhook({...base,id:'evt_newer_profile',created:created+2});assert.equal(newer.status,200);assert.equal(Number((await connect.rowFor(db,f.owner.workspaceId)).charges_enabled),0);
  assert.equal(await release.isOpen(db),true);
 });
 await t.test('a test-mode or read-only grant cannot activate a live payment account',async()=>{
  for(const extra of [{livemode:false},{scope:'read_only'}]){
   const f=await fixture('growth','unsafe'+fixtures.length);
   await assert.rejects(complete(f,extra),/live merchant|permissions/);
   assert.equal(await connect.rowFor(db,f.owner.workspaceId),null);
  }
 });
 await t.test('a revoked owner cannot exchange a saved authorization code',async()=>{
  const f=await fixture('pro','revoked'),started=await begin(f),before=calls.length;
  await db.query('UPDATE users SET revoked_at=now() WHERE id=$1',[f.ctx.actorId]);
  await assert.rejects(complete(f,{},started),/no longer has permission/);assert.equal(calls.length,before);
 });
 await t.test('one merchant account cannot be claimed by another inventory',async()=>{
  const f=await fixture('growth','duplicate');f.accountId=fixtures[0].accountId;
  await assert.rejects(complete(f),/already connected to another inventory/);
  assert.equal(await connect.rowFor(db,f.owner.workspaceId),null);assert.equal((await connect.rowFor(db,fixtures[0].owner.workspaceId)).provider_account_id,f.accountId);
 });
 await t.test('proof from another platform closes the release while pausing new sign-ins preserves verified contracts',async()=>{
  process.env.STOCKCHIEF_STRIPE_CONNECT_PILOT_WORKSPACES='';assert.equal(await release.isOpen(db),true);
  const row=await connect.rowFor(db,fixtures[1].owner.workspaceId);
  await db.query("UPDATE workspace_connectors SET config=jsonb_set(config::jsonb,'{stripeConnectEvidence,platformAccountId}','\"acct_Foreign\"'::jsonb)::text WHERE id=$1",[row.connector_id]);
  assert.equal(await release.isOpen(db),false,'Unqualified merchant fees must not be silently exempted');
 });
});
