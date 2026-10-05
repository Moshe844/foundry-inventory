'use strict';
// Real Stripe TEST objects and Stripe-signed CLI deliveries, never mocked events.
// Run only against an isolated sandbox: it must have no registered webhooks.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {spawn}=require('node:child_process');const express=require('express');
const {startCluster}=require('../tests/helpers/postgres-cluster');
const {openPostgres}=require('../src/db/postgres');const {migratePostgres}=require('../src/db/migrate-postgres');
const stripe=require('../src/commercial/stripe-billing');const auth=require('../src/domain/postgres-auth-service');
const commercial=require('../src/commercial/service');const addons=require('../src/commercial/addons');
const usage=require('../src/commercial/entitlements');const release=require('../src/commercial/release');
const {createPostgresApp}=require('../src/postgres-app');const {chromium}=require('playwright');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,timeout=60000){const deadline=Date.now()+timeout;while(Date.now()<deadline){const result=await fn();if(result)return result;await delay(500);}throw Error(`Timed out: ${label}`);}
async function main(){
 const secret=process.env.STOCKCHIEF_BILLING_STRIPE_SECRET_KEY;
 if(!/^(sk|rk|rkcs)_test_/.test(secret||'')||process.env.NODE_ENV!=='test')throw Error('Explicit NODE_ENV=test and a TEST sandbox key are required');
 const cli=process.env.STOCKCHIEF_STRIPE_CLI;if(!cli)throw Error('STOCKCHIEF_STRIPE_CLI is required for genuine signed webhook delivery');
 const cliConfig=process.env.STOCKCHIEF_STRIPE_CLI_CONFIG;
 const providerOptions=cliConfig?{fetch:require('../tests/helpers/stripe-cli-transport').createStripeCliTransport({cli,config:cliConfig})}:{};
 const call=(route,values,method=values?'POST':'GET')=>stripe.__internal.call(route,{...providerOptions,values,method,secretKey:secret,idempotencyKey:method==='POST'?`cert:${runId}:${crypto.randomUUID()}`:undefined});
 const runId=`commercial-${Date.now()}`;const report={runId,startedAt:new Date().toISOString(),liveMode:false,tests:[],blocked:[],objects:{},cleanup:[]};
 const check=(name,detail={})=>{report.tests.push({name,passed:true,...detail});console.log('PASS',name,JSON.stringify(detail));};
 if(secret.startsWith('rkcs_test_')&&!cliConfig){
  // A newly provisioned, unclaimed CLI sandbox cannot list webhook endpoints.
  // Its restricted key remains subject to Stripe's permissions on every call.
  if(!process.env.STOCKCHIEF_CERTIFICATION_SANDBOX_ID)throw Error('Record the freshly provisioned sandbox identity first');
  report.sandboxAccountId=process.env.STOCKCHIEF_CERTIFICATION_SANDBOX_ID;
 }else{
  const endpoints=await call('/webhook_endpoints?limit=100');
  if(endpoints.data.length)throw Error('Refusing shared Stripe account: use an isolated sandbox with no registered webhook endpoints');
  const account=await call('/account');report.sandboxAccountId=account.id;
  if(account.id!==process.env.STOCKCHIEF_CERTIFICATION_SANDBOX_ID)throw Error('Authorized CLI account differs from the isolated certification sandbox');
 }
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString,{applicationName:'real-stripe-certification'});
 let server,listener,clock,product,customer,webApp,browser;let held=true;const deliveries=[];const queue=[];const extraCustomers=[];
 try{
  await migratePostgres(db);
  const business=await auth.createBusiness(db,{name:'Stripe Certification',businessName:runId,email:`${runId}@example.test`,password:'Certification-only-password!'});
  const scope={accountId:business.accountId,workspaceId:business.workspaceId};
  const app=express();app.post('/stripe-delivery',express.raw({type:'application/json'}),async(req,res)=>{
   const event=JSON.parse(req.body);const entry={id:event.id,type:event.type,raw:req.body,signature:req.headers['stripe-signature'],event};deliveries.push(entry);
   if(held){queue.push(entry);return res.json({queued:true});}
   try{const result=await forward(entry);res.status(result.status).json({forwarded:true});}catch{res.status(503).end();}
  });
  webApp=createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomBytes(32).toString('hex'),
   commercialOptions:{testMode:true,billingProvider:stripe,providerOptions,publicOrigin:'request'}});
  app.use(webApp);
  server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function forward(entry){const response=await fetch(origin+'/webhooks/stockchief-billing/stripe',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':entry.signature},body:entry.raw});entry.status=response.status;entry.response=await response.json();return entry;}
  async function flush(){held=false;for(const entry of queue.splice(0))await forward(entry);
   for(let i=0;i<4;i++){const failed=deliveries.filter(x=>x.status&&x.status!==200);if(!failed.length)break;await delay(500);for(const entry of failed)await forward(entry);}}
  const events=['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed',
   'customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed',
   'payment_intent.succeeded','payment_intent.payment_failed','charge.succeeded','charge.updated','refund.created','refund.updated','refund.failed',
   'charge.dispute.created','charge.dispute.updated','charge.dispute.closed'];
  const listenerEnv={...process.env};if(cliConfig)delete listenerEnv.STRIPE_API_KEY;else listenerEnv.STRIPE_API_KEY=secret;
  listener=spawn(cli,[...(cliConfig?['--config',cliConfig]:[]),'listen','--latest','--events',events.join(','),'--forward-to',origin+'/stripe-delivery','--skip-update'],{
   env:listenerEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let listenerFailure='';const consume=chunk=>{const output=chunk.toString();const signing=output.match(/whsec_[A-Za-z0-9]+/);if(signing)process.env.STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET=signing[0];
   if(/error|failed|forbidden/i.test(output))listenerFailure=output.replace(/(?:whsec_|(?:sk|rk|rkcs)_test_)[A-Za-z0-9]+/g,'[redacted]').slice(0,300);};
  listener.stdout.on('data',consume);listener.stderr.on('data',consume);
  await until(()=>process.env.STOCKCHIEF_BILLING_STRIPE_WEBHOOK_SECRET,'Stripe CLI signing secret: '+listenerFailure,30000);
  product=await call('/products',{name:`StockChief isolated ${runId}`});report.objects.product=product.id;
  const prices={};for(const [plan,amount] of [['starter',100],['growth',200],['pro',300]]){
   const price=await call('/prices',{product:product.id,currency:'usd',unit_amount:amount,'recurring[interval]':'month'});prices[plan]=price.id;
   await db.query("UPDATE commercial_plans SET stripe_monthly_price_id=$2,monthly_amount_minor=$3,packaging_status='APPROVED',trial_days=0 WHERE id=$1",[plan,price.id,amount]);
  }
  const packPrice=await call('/prices',{product:product.id,currency:'usd',unit_amount:100});
  await db.query("UPDATE commercial_usage_packs SET stripe_price_id=$1,amount_minor=100,units=10 WHERE id='ai-500-v1'",[packPrice.id]);
  try{clock=await call('/test_helpers/test_clocks',{frozen_time:Math.floor(Date.now()/1000),name:runId});report.objects.clock=clock.id;}
  catch(error){if(!secret.startsWith('rkcs_test_')||!/limited permissions/.test(error.message))throw error;
   report.blocked.push('Stripe sandbox must be claimed to run test-clock renewal and downgrade execution');console.log('BLOCKED test clocks: sandbox claim required');}
  customer=await call('/customers',{name:runId,email:`${runId}@example.test`,test_clock:clock?.id});report.objects.customer=customer.id;
  const method=await call('/payment_methods/pm_card_visa/attach',{customer:customer.id});
  await call(`/customers/${customer.id}`,{'invoice_settings[default_payment_method]':method.id});
  const sub=await call('/subscriptions',{customer:customer.id,'items[0][price]':prices.starter,default_payment_method:method.id,
   'metadata[stockchief_account_id]':business.accountId,'metadata[stockchief_plan_id]':'starter',payment_behavior:'error_if_incomplete'});
  report.objects.subscription=sub.id;
  assert.equal(await usage.subscriptionFor(db,business.accountId),null);
  await until(()=>queue.some(x=>x.type==='customer.subscription.created')&&queue.some(x=>x.type==='invoice.paid'),'initial signed Stripe events');
  await flush();await until(async()=> (await usage.subscriptionFor(db,business.accountId))?.status==='ACTIVE','subscription activation');
  check('Real paid subscription activates only after signed webhook',{subscriptionId:sub.id,customerId:customer.id});
  const duplicate=deliveries.find(x=>x.type==='customer.subscription.created');
  await Promise.all(Array.from({length:5},()=>forward(duplicate)));assert.equal(Number((await db.query('SELECT count(*) FROM commercial_billing_events WHERE provider_event_id=$1',[duplicate.id])).rows[0].count),1);
  check('Concurrent duplicate signed webhook is idempotent',{eventId:duplicate.id});
  await assert.rejects(()=>release.assertCheckoutOpen(db),/closed/);check('Public checkout remains locked');
  const options={testMode:true,providerOptions};held=true;
  const pack=await addons.beginPurchase(db,scope,{packId:'ai-500-v1',idempotencyKey:'real-buy-more',origin},options);
  report.objects.packCheckout=pack.purchase.id;
  assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count),0);
  check('Real Buy More Checkout Session created without premature grant',{purchaseId:pack.purchase.id});
  browser=await chromium.launch();const page=await browser.newPage();
  page.on('pageerror',error=>console.log('Browser error:',error.message.slice(0,250)));
  page.on('requestfailed',request=>{const url=new URL(request.url());console.log('Browser request failure:',url.hostname,request.failure()?.errorText);});
  async function payCheckout(url,cardNumber='4242424242424242'){
   await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
   const cardChoice=page.getByText('Card',{exact:true}).first();
   await until(async()=>await page.locator('#cardNumber').isVisible()||await cardChoice.isVisible(),'Stripe card controls',30000);
   // Stripe expands the hit area with a zero-sized button's CSS pseudo-element.
   // Click the rendered Card label; the intended overlaid button receives it.
   if(!await page.locator('#cardNumber').isVisible()){
    const cardBox=await cardChoice.boundingBox();await page.mouse.click(cardBox.x+cardBox.width/2,cardBox.y+cardBox.height/2);
   }
   const saveLink=page.locator('#enableStripePass');if(await saveLink.count()&&await saveLink.isChecked())
    await page.getByText('Save my information for faster checkout',{exact:true}).click();
   await page.locator('#cardNumber').waitFor({state:'visible',timeout:30000});
   await page.locator('#cardNumber').fill(cardNumber);
   await page.locator('#cardExpiry').fill('1230');await page.locator('#cardCvc').fill('123');
   for(const [selector,value] of [['#billingName','Certification Test'],['#billingPostalCode','10001'],['#email',`${runId}@example.test`]]){
    const field=page.locator(selector);if(await field.count()&&await field.isVisible()&&await field.isEditable())await field.fill(value);
   }
   await page.locator('button[type="submit"]').filter({hasText:/Pay|Subscribe|Start trial|Start subscription/i}).last().click();
   await page.waitForURL(url=>url.origin===origin,{timeout:60000});
  }
  await payCheckout(pack.url);
  assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count),0);
  await until(()=>queue.some(x=>x.type==='checkout.session.completed'&&x.event.data.object.metadata?.stockchief_purchase_id===pack.purchase.id),'Buy More signed checkout event');
  await flush();await until(async()=>Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count)===1,'Buy More grant');
  const packPaid=deliveries.find(x=>x.type==='checkout.session.completed'&&x.event.data.object.metadata?.stockchief_purchase_id===pack.purchase.id);
  await Promise.all(Array.from({length:4},()=>forward(packPaid)));
  assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count),1);
  check('Real browser Buy More payment grants once only after signed webhook',{eventId:packPaid.id});
  held=true;
  // Test the exact off-session payment path with a real card and genuine webhooks.
  await usage.recordUsage(db,scope,{meter:'ai_work_credits',units:510,idempotencyKey:'real-topup-exhaustion'});
  await addons.saveTopup(db,scope,{enabled:true,explicitConsent:true,category:'ai_work_credits',packId:'ai-500-v1',monthlyCapMinor:100},options);
  const topups=await Promise.all(Array.from({length:4},()=>addons.runTopup(db,scope,'ai_work_credits',options)));
  assert.equal(topups.filter(x=>x.triggered).length,1);
  assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count),1);
  await until(()=>queue.some(x=>x.type==='payment_intent.succeeded'&&x.event.data.object.metadata?.stockchief_purchase_id),'top-up signed payment event');
  await flush();await until(async()=>Number((await db.query('SELECT count(*) FROM commercial_usage_grants')).rows[0].count)===2,'exactly one top-up grant');
  await usage.recordUsage(db,scope,{meter:'ai_work_credits',units:10,idempotencyKey:'consume-real-topup'});
  assert.equal((await addons.runTopup(db,scope,'ai_work_credits',options)).triggered,false);
  check('Real auto-top-up payment, exactly-once grant, concurrency and monthly cap');
  held=true;const change=await commercial.requestSubscriptionChange(db,business.accountId,{planId:'pro',interval:'monthly',idempotencyKey:'real-upgrade'},options);
  assert.equal((await usage.subscriptionFor(db,business.accountId)).plan_id,'starter');
  await until(()=>queue.some(x=>x.type==='customer.subscription.updated'&&x.event.data.object.items.data[0].price.id===prices.pro),'upgrade signed event');
  await flush();await until(async()=>(await usage.subscriptionFor(db,business.accountId)).plan_id==='pro','upgrade activation');
  check('Real prorated upgrade activates through webhook',{changeId:change.changeId});
  const down=await commercial.requestSubscriptionChange(db,business.accountId,{planId:'starter',interval:'monthly',idempotencyKey:'real-downgrade'},options);
  assert.equal((await usage.subscriptionFor(db,business.accountId)).plan_id,'pro');
  const remote=await stripe.retrieveSubscription(sub.id,providerOptions);const periodEnd=remote.items.data[0].current_period_end||remote.current_period_end;
  if(clock){await call(`/test_helpers/test_clocks/${clock.id}/advance`,{frozen_time:periodEnd+3660});
   await until(async()=> (await call(`/test_helpers/test_clocks/${clock.id}`)).status==='ready','Stripe clock advance',90000);
   await until(async()=> (await usage.subscriptionFor(db,business.accountId)).plan_id==='starter','scheduled downgrade event',90000);
   check('Real scheduled downgrade executes at renewal',{changeId:down.changeId});
   async function collectRenewal(expectSuccess){
    const current=await stripe.retrieveSubscription(sub.id,providerOptions);
    const invoiceId=typeof current.latest_invoice==='string'?current.latest_invoice:current.latest_invoice.id;
    let invoice=await call(`/invoices/${invoiceId}`);
    assert.equal(invoice.billing_reason,'subscription_cycle');
    // Finalization timing depends on account settings; explicit collection is
    // still a real renewal invoice and a real provider payment attempt.
    if(invoice.status==='draft')invoice=await call(`/invoices/${invoiceId}/finalize`,{auto_advance:false});
    if(invoice.status==='open'){
     try{await call(`/invoices/${invoiceId}/pay`,{});}catch(error){if(expectSuccess)throw error;}
    }
    return invoiceId;
   }
   const renewedInvoice=await collectRenewal(true);
   await until(()=>deliveries.some(x=>x.type==='invoice.paid'&&x.event.data.object.id===renewedInvoice&&x.status===200),'signed renewal invoice');
   const resetUsage=await usage.meterState(db,scope,'ai_work_credits',{now:new Date((periodEnd+3660)*1000)});
   assert.equal(resetUsage.includedRemaining,500);
   check('Real renewal payment grants a fresh included period',{invoiceId:renewedInvoice});
   const declinedRenewal=await call('/payment_methods/pm_card_chargeCustomerFail/attach',{customer:customer.id});
   await call(`/subscriptions/${sub.id}`,{default_payment_method:declinedRenewal.id});
   const nextTerm=await stripe.retrieveSubscription(sub.id,providerOptions);
   const nextEnd=nextTerm.items.data[0].current_period_end||nextTerm.current_period_end;
   await call(`/test_helpers/test_clocks/${clock.id}/advance`,{frozen_time:nextEnd+3660});
   await until(async()=>(await call(`/test_helpers/test_clocks/${clock.id}`)).status==='ready','failed renewal clock advance',90000);
   const failedInvoice=await collectRenewal(false);
   const failedRenewal=await until(()=>deliveries.find(x=>x.type==='invoice.payment_failed'&&x.event.data.object.id===failedInvoice&&x.status===200),'signed failed renewal');
   const grace=await usage.subscriptionFor(db,business.accountId);assert.equal(grace.status,'GRACE');
   await Promise.all([forward(failedRenewal),forward(failedRenewal)]);
   assert.equal(new Date((await usage.subscriptionFor(db,business.accountId)).grace_ends_at).getTime(),new Date(grace.grace_ends_at).getTime());
   const expiredAt=new Date(new Date(grace.grace_ends_at).getTime()+1);
   assert.equal((await usage.capabilityState(db,scope,'inventory.core',{now:expiredAt})).enabled,false);
   assert.equal((await usage.capabilityState(db,scope,'inventory.core',{now:expiredAt,allowReadOnly:true})).enabled,true);
   check('Real failed renewal starts fixed grace; application clock boundary enforces read-only',{invoiceId:failedInvoice,graceExpiryTest:'injected application evaluation time'});
   await call(`/subscriptions/${sub.id}`,{default_payment_method:method.id});
   await call(`/invoices/${failedInvoice}/pay`,{payment_method:method.id});
   await until(async()=>(await usage.subscriptionFor(db,business.accountId)).status==='ACTIVE','paid renewal restores access');
   check('Real renewal recovery restores operational access');
  }else check('Real downgrade schedule created; execution awaiting sandbox claim',{changeId:down.changeId});
  // Complete the public acquisition path against real hosted Stripe Checkout.
  process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';held=false;
  await page.goto(origin+'/pricing');await page.getByRole('link',{name:'Choose Growth',exact:true}).click();
  const signupEmail=`signup-${runId}@example.test`;
  await page.getByLabel('Business name').fill('Real Stripe Browser Fixture');await page.getByLabel('Your name').fill('Certification Buyer');
  await page.getByLabel('Work email').fill(signupEmail);await page.locator('#password').fill('Certification-browser-password!');
  await page.getByRole('button',{name:'Create account',exact:true}).click();await page.waitForURL(/\/verify-email\/pending/);
  const signup=(await db.query('SELECT id FROM accounts WHERE email=$1',[signupEmail])).rows[0];
  assert.equal(Number((await db.query('SELECT count(*) FROM workspaces WHERE owner_account_id=$1',[signup.id])).rows[0].count),0);
  const emails=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send' AND payload->>'messageType'='email_verification'")).rows;
  const message=emails.map(x=>require('../src/connections/credentials').decrypt({...x.payload.sealed,auth_tag:x.payload.sealed.authTag})).find(x=>x.to===signupEmail);
  assert.ok(message,'Verification email captured in local outbox; no external email sent');
  const verification=new URL(message.text.match(/https?:\/\/\S+/)[0]);
  await page.goto(origin+verification.pathname+verification.search);await page.getByRole('button',{name:'Verify and continue'}).click();
  await page.locator('#activation-plan').selectOption('growth');
  await page.getByRole('button',{name:'Continue to secure checkout'}).click();
  await page.waitForURL(url=>url.hostname==='checkout.stripe.com',{timeout:45000});
  await payCheckout(page.url());
  const signupSub=await until(async()=>{const row=await usage.subscriptionFor(db,signup.id);return row?.status==='ACTIVE'?row:null;},'browser signup signed activation');
  extraCustomers.push(signupSub.stripe_customer_id);
  const attempt=(await db.query('SELECT stripe_checkout_session_id FROM commercial_checkout_attempts WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1',[signup.id])).rows[0];
  await page.goto(origin+'/billing/checkout/complete?session_id='+encodeURIComponent(attempt.stripe_checkout_session_id));
  await page.waitForURL(/\/onboarding/);await page.goto(origin+'/billing');
  assert.match(await page.locator('body').innerText(),/Growth/);
  assert.equal(Number((await db.query('SELECT count(*) FROM workspaces WHERE owner_account_id=$1',[signup.id])).rows[0].count),1);
  await assert.rejects(()=>addons.beginPurchase(db,{accountId:signup.id,workspaceId:business.workspaceId},
   {packId:'ai-500-v1',idempotencyKey:'foreign-purchase',origin},options),/another commercial account/);
  check('Real browser pricing, signup, verified email handoff, Stripe payment and entitlement',{subscriptionId:signupSub.stripe_subscription_id,externalEmailDeliveryTested:false});
  check('Tenant isolation blocks a foreign inventory purchase');
  const signupRemote=await stripe.retrieveSubscription(signupSub.stripe_subscription_id,providerOptions);
  const savedMethod=typeof signupRemote.default_payment_method==='string'?signupRemote.default_payment_method:signupRemote.default_payment_method?.id;
  assert.ok(savedMethod,'Checkout subscription retains its customer-owned payment method');
  const declined=await call('/payment_methods/pm_card_chargeCustomerFail/attach',{customer:signupSub.stripe_customer_id});
  await call(`/subscriptions/${signupSub.stripe_subscription_id}`,{default_payment_method:declined.id});
  await commercial.requestSubscriptionChange(db,signup.id,{planId:'pro',interval:'monthly',idempotencyKey:'declined-real-upgrade'},options);
  const failure=await until(()=>deliveries.find(x=>x.type==='invoice.payment_failed'&&x.event.data.object.customer===signupSub.stripe_customer_id),'real failed upgrade invoice');
  await until(()=>failure.status===200,'failed-upgrade webhook handled');
  const unchanged=await usage.subscriptionFor(db,signup.id);assert.equal(unchanged.plan_id,'growth');assert.equal(unchanged.status,'ACTIVE');
  check('Real failed upgrade does not revoke an already-paid tier',{invoiceId:failure.event.data.object.id});
  await call(`/subscriptions/${signupSub.stripe_subscription_id}`,{default_payment_method:savedMethod});
  await call(`/invoices/${failure.event.data.object.id}/pay`,{payment_method:savedMethod});
  await until(async()=>(await usage.subscriptionFor(db,signup.id)).plan_id==='pro','failed upgrade recovery signed event');
  check('Real failed upgrade recovers after successful payment and signed activation');
  // Stripe retries out-of-order deliveries. Replay the genuine signed payloads
  // after ownership exists, then require every delivery to have been accepted.
  await flush();assert.ok(deliveries.every(x=>x.status===200));
  check('Out-of-order genuine webhook retries reconcile after subscription ownership');
  if(process.env.STOCKCHIEF_CERTIFICATION_EDGE_CASES==='true'){
   const signupScope={accountId:signup.id,workspaceId:(await db.query('SELECT id FROM workspaces WHERE owner_account_id=$1',[signup.id])).rows[0].id};
   const available=await usage.meterState(db,signupScope,'ai_work_credits');
   await usage.recordUsage(db,signupScope,{meter:'ai_work_credits',units:available.remaining,idempotencyKey:'authentication-topup-exhaustion'});
   const requiresAuth=await call('/payment_methods/pm_card_authenticationRequired/attach',{customer:signupSub.stripe_customer_id});
   await call(`/subscriptions/${signupSub.stripe_subscription_id}`,{default_payment_method:requiresAuth.id});
   await addons.saveTopup(db,signupScope,{enabled:true,explicitConsent:true,category:'ai_work_credits',packId:'ai-500-v1',monthlyCapMinor:100},options);
   const authTopup=await addons.runTopup(db,signupScope,'ai_work_credits',options);assert.equal(authTopup.triggered,true);
   await until(async()=>['REVIEW','FAILED'].includes((await db.query("SELECT status FROM commercial_usage_purchases WHERE account_id=$1 AND kind='AUTO'",[signup.id])).rows[0]?.status),'authentication-required top-up retained');
   assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_grants WHERE account_id=$1',[signup.id])).rows[0].count),0);
   assert.equal((await addons.runTopup(db,signupScope,'ai_work_credits',options)).triggered,false);
   await call(`/subscriptions/${signupSub.stripe_subscription_id}`,{default_payment_method:savedMethod});
   check('Real authentication-required auto-top-up grants no usage and cannot repeatedly charge');
   for(const outcome of ['won','lost']){
    const disputedPack=await addons.beginPurchase(db,signupScope,{packId:'ai-500-v1',idempotencyKey:`dispute-${outcome}`,origin},options);
    await payCheckout(disputedPack.url,'4000000000000259');
    const hold=await until(async()=>{const row=(await db.query(`SELECT g.*,d.id AS dispute_id FROM commercial_usage_grants g
     JOIN commercial_usage_disputes d ON d.purchase_id=g.purchase_id WHERE g.purchase_id=$1`,[disputedPack.purchase.id])).rows[0];
     return row&&Number(row.dispute_hold_units)===10?row:null;},'signed dispute holds purchased funding',90000);
    await call(`/disputes/${hold.dispute_id}`,{'evidence[uncategorized_text]':outcome==='won'?'winning_evidence':'losing_evidence',submit:true});
    await until(async()=>{const row=(await db.query(`SELECT g.*,d.status AS dispute_status FROM commercial_usage_grants g
     JOIN commercial_usage_disputes d ON d.purchase_id=g.purchase_id WHERE g.id=$1`,[hold.id])).rows[0];
     return row.dispute_status===outcome&&Number(row.dispute_hold_units)===0&&Number(row.revoked_units)===(outcome==='lost'?10:0);},`signed ${outcome} dispute funding adjustment`,90000);
    check(`Real ${outcome} dispute adjusts purchased funding through signed events`,{disputeId:hold.dispute_id});
   }
   for(const [outcome,card] of [['failed','4000000000005126'],['succeeded','4000000000007726']]){
    const asyncPack=await addons.beginPurchase(db,signupScope,{packId:'ai-500-v1',idempotencyKey:`async-refund-${outcome}`,origin},options);
    await payCheckout(asyncPack.url,card);
    const funded=await until(async()=>{const row=(await db.query('SELECT * FROM commercial_usage_purchases WHERE id=$1',[asyncPack.purchase.id])).rows[0];
      return row.status==='PAID'?row:null;},'asynchronous-refund pack funding');
    const asynchronous=await call('/refunds',{payment_intent:funded.stripe_payment_intent_id});
    await until(async()=>{const row=(await db.query('SELECT * FROM commercial_stripe_refunds WHERE id=$1',[asynchronous.id])).rows[0];
      return row?.status===outcome?row:null;},`real asynchronous refund ${outcome}`,360000);
    await flush();
    const genuine=deliveries.filter(x=>x.type.startsWith('refund.')&&x.event.data.object.id===asynchronous.id);
    assert.ok(genuine.length>=2);assert.ok(genuine.every(x=>x.status===200));
    // Reverse delivery order using the original Stripe-signed payloads, then duplicate concurrently.
    for(const entry of [...genuine].reverse())await forward(entry);
    await Promise.all(genuine.flatMap(entry=>[forward(entry),forward(entry)]));
    const adjusted=(await db.query('SELECT revoked_units FROM commercial_usage_grants WHERE purchase_id=$1',[funded.id])).rows[0];
    assert.equal(Number(adjusted.revoked_units),outcome==='failed'?0:10);
    const ledger=(await db.query("SELECT count(*) AS n,COALESCE(SUM(amount_minor),0) AS total FROM commercial_revenue_events WHERE detail->>'refundId'=$1",[asynchronous.id])).rows[0];
    assert.equal(Number(ledger.total),outcome==='failed'?0:-100);
    assert.equal(Number(ledger.n),outcome==='failed'?2:1);
    check(`Real asynchronous refund ${outcome} conserves funding and cash across reversed duplicate signed deliveries`,{refundId:asynchronous.id,ledgerRows:Number(ledger.n)});
   }
   await flush();assert.ok(deliveries.every(x=>x.status===200));
  }
  const packIntent=(await db.query('SELECT stripe_payment_intent_id FROM commercial_usage_purchases WHERE id=$1',[pack.purchase.id])).rows[0].stripe_payment_intent_id;
  const refund=await call('/refunds',{payment_intent:packIntent});
  await until(()=>deliveries.some(x=>x.type.startsWith('refund.')&&x.event.data.object.id===refund.id&&x.status===200),'real refund signed ledger');
  const refundEvent=deliveries.find(x=>x.type.startsWith('refund.')&&x.event.data.object.id===refund.id&&x.status===200);
  await Promise.all([forward(refundEvent),forward(refundEvent)]);
  assert.equal(Number((await db.query("SELECT count(*) FROM commercial_revenue_events WHERE source_id=$1",[`refund:${refund.id}`])).rows[0].count),1);
  assert.equal((await db.query('SELECT status FROM commercial_usage_purchases WHERE id=$1',[pack.purchase.id])).rows[0].status,'REFUNDED');
  check('Real purchased-pack refund is recorded exactly once and spent funding is flagged');
  const pendingFinancialJobs=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='commercial.stripe-invoice-sync'")).rows;
  for(const job of pendingFinancialJobs)await require('../src/commercial/stripe-financials').syncInvoice(db,job,{providerOptions});
  const balanceJobs=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='commercial.stripe-financial-sync'")).rows;
  let balancePermissionBlocked=false;
  for(const job of balanceJobs){try{await require('../src/commercial/stripe-financials').sync(db,job,{providerOptions});}
   catch(error){if(!secret.startsWith('rkcs_test_')||!/limited permissions/.test(error.message))throw error;
    balancePermissionBlocked=true;report.blocked.push('Claimed sandbox credentials are required for direct balance-transaction reconciliation');break;}}
  const paymentFees=(await db.query("SELECT count(*) AS n FROM commercial_revenue_events WHERE kind='FEE'")).rows[0];
  assert.ok(Number(paymentFees.n)>0);check('Actual Stripe invoice payments and balance-transaction fees reconciled',{invoices:pendingFinancialJobs.length,feeRows:Number(paymentFees.n)});
  const unresolvedStripe=(await db.query("SELECT code FROM commercial_critical_warnings WHERE status='OPEN' AND code IN ('MISSING_STRIPE_FEE','MISSING_STRIPE_PAYMENT_BINDING','BILLING_EVENT_RECONCILIATION_REQUIRED','UNATTRIBUTED_STRIPE_ADJUSTMENT')")).rows;
  assert.deepEqual(unresolvedStripe.filter(x=>!balancePermissionBlocked||x.code!=='MISSING_STRIPE_FEE'),[]);
  if(!balancePermissionBlocked)check('No unresolved Stripe fee, payment-binding or delivery warnings');
  report.deliveries=deliveries.map(x=>({id:x.id,type:x.type,status:x.status}));
  report.revenue=(await db.query('SELECT source_id,kind,amount_minor,currency,detail FROM commercial_revenue_events ORDER BY occurred_at')).rows;
  report.criticalWarnings=(await db.query("SELECT code,count(*) FROM commercial_critical_warnings WHERE status='OPEN' GROUP BY code")).rows;
  report.passed=true;report.complete=report.blocked.length===0;
 }catch(error){report.passed=false;report.error=error.message.replace(/(?:sk_|rk_|rkcs_|whsec_)[^\s'"]+/g,'[redacted]');report.deliveries=deliveries.map(x=>({id:x.id,type:x.type,status:x.status,error:x.response?.error?.message}));
  if(browser){const page=browser.contexts()[0]?.pages()[0];if(page){await page.screenshot({path:'data/commercial-stripe-browser-failure.png',fullPage:true});
   for(const frame of page.frames())console.log('Frame fields:',JSON.stringify({host:frame.url().startsWith('http')?new URL(frame.url()).hostname:frame.url(),
    fields:await frame.locator('input').evaluateAll(nodes=>nodes.map(n=>({id:n.id,name:n.name,type:n.type,placeholder:n.placeholder})))}));
   console.log('Browser controls:',JSON.stringify(await page.locator('input,button,select').evaluateAll(nodes=>nodes.map(n=>({tag:n.tagName,id:n.id,name:n.getAttribute('name'),type:n.getAttribute('type'),label:n.getAttribute('aria-label'),text:n.tagName==='BUTTON'?n.textContent?.slice(0,80):undefined})))));}}
  throw error;
 }finally{
  if(listener)listener.kill();
  for(const row of (await db.query('SELECT DISTINCT stripe_customer_id FROM account_subscriptions WHERE stripe_customer_id IS NOT NULL')).rows)
   if(row.stripe_customer_id!==customer?.id&&!extraCustomers.includes(row.stripe_customer_id))extraCustomers.push(row.stripe_customer_id);
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(webApp)await webApp.locals.sessionStore.close();
  if(clock)try{await call(`/test_helpers/test_clocks/${clock.id}`,undefined,'DELETE');report.cleanup.push({clock:clock.id,deleted:true});}catch(error){report.cleanup.push({clock:clock.id,error:error.message});}
  if(customer&&!clock)try{await call(`/customers/${customer.id}`,undefined,'DELETE');report.cleanup.push({customer:customer.id,deleted:true});}catch(error){report.cleanup.push({customer:customer.id,error:error.message});}
  for(const id of extraCustomers)try{await call(`/customers/${id}`,undefined,'DELETE');report.cleanup.push({customer:id,deleted:true});}catch(error){report.cleanup.push({customer:id,error:error.message});}
  if(product)try{await call(`/products/${product.id}`,{active:'false'});report.cleanup.push({product:product.id,archived:true});}catch(error){report.cleanup.push({product:product.id,error:error.message});}
  report.finishedAt=new Date().toISOString();fs.mkdirSync('data',{recursive:true});
  fs.writeFileSync(path.join('data',`${runId}.json`),JSON.stringify(report,null,2));console.log('Evidence:',`data/${runId}.json`);
  await db.close();cluster.stop();
 }
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
