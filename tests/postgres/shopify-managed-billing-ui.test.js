'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),request=require('supertest');
const csrf=html=>html.match(/name="_csrf" value="([^"]+)"/)?.[1];
test('Shopify billing returns activate verified plans and recover expired handoffs without trusting return parameters',{timeout:360000},async t=>{
 const env={...process.env},oldFetch=global.fetch;
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'production',STOCKCHIEF_PRODUCTION_SHOPIFY_PILOTS:'{}',STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED:'0',SHOPIFY_PARTNER_ID:'5146412',SHOPIFY_PUBLIC_APP_ID:'448446889985',SHOPIFY_PARTNER_ACCESS_TOKEN:'fixture-token',SHOPIFY_PUBLIC_CLIENT_ID:'fixture-public-client',SHOPIFY_PUBLIC_CLIENT_SECRET:'fixture-public-secret'});
 Object.assign(process.env,{STOCKCHIEF_CHECKOUT_ENABLED:'true',STOCKCHIEF_BILLING_AUTOMATIC_TAX:'false',STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID:require('../../src/commercial/stripe-live-fee-evidence').accountId});
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);
 await db.query('UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true');await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 const release=require('../../src/commercial/release');assert.equal(await release.isOpen(db),true,'The independently approved Stripe checkout starts open');
 const auth=require('../../src/domain/postgres-auth-service'),billing=require('../../src/commercial/shopify-billing'),ent=require('../../src/commercial/entitlements');
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:crypto.randomUUID(),connectionPublicOrigin:'https://app.stockchiefhq.com'});
 let activeFixture=null,lastAccount=null;const calls=[];
 const sign=q=>({...q,hmac:crypto.createHmac('sha256','fixture-public-secret').update(Object.keys(q).sort().map(k=>k+'='+q[k]).join('&')).digest('hex')});
 global.fetch=async(url,options)=>{
  const u=new URL(url),body=u.pathname==='/admin/oauth/access_token'?{}:JSON.parse(options.body||'{}');calls.push({host:u.hostname,query:body.query});
  if(u.hostname==='partners.shopify.com'){
   assert.equal(options.headers['X-Shopify-Access-Token'],'fixture-token');
   if(body.query.includes('StockChiefManagedSubscription'))return Response.json({data:{activeSubscription:activeFixture.remote}});
   if(body.query.includes('StockChiefBillingHistory'))return Response.json({data:{events:{pageInfo:{hasNextPage:false,endCursor:null},edges:activeFixture.events.map(node=>({node}))}}});
   throw Error('Unexpected Partner operation');
  }
  assert.equal(u.hostname,activeFixture.shop,'Only synthetic Shopify stores are contacted');
  if(u.pathname==='/admin/oauth/access_token')return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,refresh_token_expires_in:7776000,scope:'read_orders,read_products,read_locations,read_inventory,read_fulfillments,write_products,write_inventory'});
  if(body.query===billing.IDENTITY_QUERY)return Response.json({data:{shop:{id:activeFixture.shopId,myshopifyDomain:activeFixture.shop,plan:{partnerDevelopment:activeFixture.developmentStore!==false}},currentAppInstallation:{app:{id:activeFixture.appId||'gid://shopify/App/448446889985',apiKey:'fixture-public-client',handle:'stockchief'}}}});
  if(body.query.includes('StockChiefWebhooks'))return Response.json({data:{webhookSubscriptions:{nodes:[]}}});
  if(body.query.includes('AddWebhook'))return Response.json({data:{webhookSubscriptionCreate:{userErrors:[],webhookSubscription:{id:'gid://shopify/WebhookSubscription/'+calls.length}}}});
  throw Error('Unexpected Admin operation');
 };
 try{
  let fixtureNumber=0;
  for(const plan of ['starter','growth','pro'])await t.test(plan+' from authorization through sign-in, plan selection, verified activation and billing',async()=>{
   const n=++fixtureNumber,shop='ui-billing-'+n+'.myshopify.com',shopId='gid://shopify/Shop/'+n,password='ShopifyBillingUIFixture!42';
   let account=await auth.createPendingAccount(db,{name:'Billing owner '+n,email:'billing-ui-'+n+'@example.test',businessName:'Billing UI '+n,password,planId:plan});await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[account.id]);account=await auth.getAccount(db,account.id);
   lastAccount={email:account.email,password};
   const at=new Date().toISOString(),event={id:'creation-ui-'+n,eventType:'SUBSCRIPTION_CREATED',occurredAt:at,subject:{id:'gid://shopify/App/448446889985'},shop:{id:shopId,myshopifyDomain:shop}};
   activeFixture={shop,shopId,events:[event],remote:{shop:{id:shopId,myshopifyDomain:shop},billingPeriod:'EVERY_30_DAYS',cancelAtEndOfCycle:false,currentBillingCycle:{startTime:at,endTime:new Date(Date.now()+30*86400000).toISOString()},trialEndsAt:null,items:[{handle:plan,price:{__typename:'FlatRatePrice',active:false,currency:'USD',amount:'0.0'}}]}};
   const agent=request.agent(app),start=await agent.get('/integrations/shopify/install').query(sign({shop,timestamp:String(Math.floor(Date.now()/1000))}));assert.equal(start.status,303,start.text);
   const state=new URL(start.headers.location).searchParams.get('state');
   const accepted=await agent.get('/integrations/shopify/callback').query(sign({shop,state,code:'fixture-authorization',timestamp:String(Math.floor(Date.now()/1000))}));assert.equal(accepted.status,303,accepted.text);
   const login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:account.email,password,next:'/integrations/shopify/connect'});
   const signup=await agent.get('/complete-signup');assert.equal(signup.headers.location,'/integrations/shopify/connect','Shopify signups must not enter Stripe checkout');
   const page=await agent.get('/integrations/shopify/connect');assert.equal(page.status,200,page.text);assert.match(page.text,/Choose a plan in Shopify/);
   const selection=await agent.post('/integrations/shopify/billing/start').type('form').send({_csrf:csrf(page.text)});assert.equal(selection.status,303,selection.text);assert.equal(selection.headers.location,'https://admin.shopify.com/store/ui-billing-'+n+'/charges/stockchief/pricing_plans');
   const returned=await agent.get('/integrations/shopify/connect').query({shop,plan_handle:plan==='pro'?'starter':'pro',charge_id:'unsigned-untrusted-value'});assert.equal(returned.status,200,returned.text);assert.match(returned.text,/Your inventory/);
   const mismatched=await agent.get('/integrations/shopify/connect').query({shop:'different-owner.myshopify.com'});assert.equal(mismatched.status,400);assert(!mismatched.headers.location,'A valid proof for another store must be rejected, not recovered');
   const sub=await ent.subscriptionFor(db,account.id);assert.equal(sub.plan_id,plan,'Unsigned return parameters cannot change the verified provider plan');assert.equal(sub.source,'SHOPIFY');assert.equal(sub.stripe_subscription_id,null);
   const linked=await agent.post('/integrations/shopify/connect').type('form').send({_csrf:csrf(returned.text),workspaceId:sub.workspace_id||(await db.query('SELECT id FROM workspaces WHERE owner_account_id=$1',[account.id])).rows[0].id});assert.equal(linked.status,303,linked.text);
   const connector=(await db.query("SELECT c.* FROM workspace_connectors c JOIN workspaces w ON w.id=c.workspace_id WHERE w.owner_account_id=$1 AND c.provider_type='shopify'",[account.id])).rows[0];assert.equal(connector.status,'connected','A fresh reviewer store can attach without a hard-coded pilot entry');
   assert.equal(await release.isOpen(db),true,plan+' reviewer attachment must preserve independently approved public Stripe checkout');
   const grant=await require('../../src/connections/postgres-credential-store').get(db,connector.workspace_id,connector.id,'provider');assert.equal(grant.shopifyShopId,shopId,'The trusted identity is retained for signed uninstall delivery');
   const context=await require('../../src/connections/launch-policy').resolveWorkspaceContext(db,{workspaceId:connector.workspace_id,actorId:connector.created_by});assert.equal(require('../../src/connections/launch-policy').reason('shopify',context),null);
   await assert.rejects(()=>require('../../src/connections/launch-policy').assertWorkspaceConnection(db,'shopify',context,{shop:'foreign-review.myshopify.com'}),/assigned|private Shopify test/);
   const connectPage=await agent.get('/settings/connections');assert(!/name="shop"/.test(connectPage.text),'Customers do not have to type their Shopify domain');
   const open=await agent.get('/integrations/shopify/open?shop=foreign-review.myshopify.com');assert.equal(open.status,303,open.text);assert.equal(open.headers.location,'https://admin.shopify.com/store/ui-billing-'+n+'/apps/stockchief','Only the server-owned store is offered');
   const reopen=await agent.get('/integrations/shopify/install').query(sign({shop,timestamp:String(Math.floor(Date.now()/1000))}));assert.equal(reopen.headers.location,'/integrations/shopify/connect','A connected development store reopens without minting a second grant');
   const bill=await agent.get('/settings/billing');assert.equal(bill.status,200,bill.text);assert.match(bill.text,/subscription is managed through Shopify/);assert.match(bill.text,/Development-store test subscription/);assert(!bill.text.includes('action="/billing/checkout"'));
   const portal=await agent.post('/billing/portal').type('form').send({_csrf:csrf(bill.text)});assert.equal(portal.headers.location,selection.headers.location);
   assert.equal((await agent.get('/complete-signup')).headers.location,'/billing','A Shopify-paid account never returns to the card entry form');
  });
  await t.test('checkout qualification requires the exact public app, store and workspace owner identity',async()=>{
   const connector=(await db.query("SELECT * FROM workspace_connectors WHERE provider_type='shopify' AND provider_account_id='ui-billing-1.myshopify.com'")).rows[0],binding=(await db.query('SELECT * FROM commercial_shopify_subscriptions WHERE shop=$1',[connector.provider_account_id])).rows[0];
   assert.equal(await release.isOpen(db),true);
   for(const change of [{field:'app_id',value:'gid://shopify/App/0'},{field:'shop',value:'foreign-binding.myshopify.com'},{field:'development_store',value:false}]){
    await db.query('UPDATE commercial_shopify_subscriptions SET '+change.field+'=$2 WHERE account_id=$1',[binding.account_id,change.value]);assert.equal(await release.isOpen(db),false,change.field+' mismatch must close checkout');
    await db.query('UPDATE commercial_shopify_subscriptions SET '+change.field+'=$2 WHERE account_id=$1',[binding.account_id,binding[change.field]]);assert.equal(await release.isOpen(db),true);
   }
   const foreign=await auth.createPendingAccount(db,{name:'Foreign billing owner',email:'foreign-billing-owner@example.test',businessName:'Foreign billing',password:'ForeignBillingFixture!42',planId:'starter'});
   await db.query('UPDATE commercial_shopify_subscriptions SET account_id=$2 WHERE account_id=$1',[binding.account_id,foreign.id]);assert.equal(await release.isOpen(db),false,'Another account billing identity cannot qualify this workspace');await db.query('UPDATE commercial_shopify_subscriptions SET account_id=$2 WHERE account_id=$1',[foreign.id,binding.account_id]);assert.equal(await release.isOpen(db),true);
   await db.query('UPDATE commercial_shopify_subscriptions SET development_store=false WHERE account_id=$1',[binding.account_id]);process.env.STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED='1';assert.equal(await release.isOpen(db),true,'Approved public distribution may qualify a correctly bound public app without a development-store exception');
   for(const change of [{shopifyClientId:'foreign-client'},{shopifyProfile:'legacy'},{shopifyClientId:null},{shopifyProfile:null}]){await db.query('UPDATE workspace_connectors SET config=$2 WHERE id=$1',[connector.id,JSON.stringify({...JSON.parse(connector.config),...change})]);assert.equal(await release.isOpen(db),false,'Public approval requires an exact client and public profile, including for missing values');await db.query('UPDATE workspace_connectors SET config=$2 WHERE id=$1',[connector.id,connector.config]);}
   process.env.STOCKCHIEF_SHOPIFY_PUBLIC_APPROVED='0';assert.equal(await release.isOpen(db),false);await db.query('UPDATE commercial_shopify_subscriptions SET development_store=true WHERE account_id=$1',[binding.account_id]);assert.equal(await release.isOpen(db),true);
   await db.query("UPDATE commercial_shopify_subscriptions SET status='CANCELLED' WHERE account_id=$1",[binding.account_id]);assert.equal(await release.isOpen(db),true,'A cancelled reviewer subscription retains its qualified provider identity without closing other customer checkout');
   await db.query('UPDATE workspaces SET deletion_requested_at=now() WHERE id=$1',[connector.workspace_id]);assert.equal(await release.isOpen(db),true,'Pending workspace deletion does not erase the matched fee identity or close checkout globally');await db.query('UPDATE workspaces SET deletion_requested_at=NULL WHERE id=$1',[connector.workspace_id]);await db.query('UPDATE commercial_shopify_subscriptions SET status=$2 WHERE account_id=$1',[binding.account_id,binding.status]);
  });
  await t.test('fresh signed live stores and a foreign app cannot pass the development review gate',async()=>{
   const prior=activeFixture;
   const before=(await db.query('SELECT count(*)::int n FROM workspace_connectors')).rows[0].n;
   for(const variant of [{developmentStore:false},{appId:'gid://shopify/App/0'}]){
    activeFixture={shop:'rejected-review.myshopify.com',shopId:'gid://shopify/Shop/900',...variant};const agent=request.agent(app);
    const start=await agent.get('/integrations/shopify/install').query(sign({shop:activeFixture.shop,timestamp:String(Math.floor(Date.now()/1000))}));assert.equal(start.status,303,start.text);
    const query=sign({shop:activeFixture.shop,state:new URL(start.headers.location).searchParams.get('state'),code:'untrusted-review-code',timestamp:String(Math.floor(Date.now()/1000))});
    const done=await agent.get('/integrations/shopify/callback').query(query);assert.equal(done.status,400,done.text);assert.match(done.text,/approval|another app or store/);
    const row=(await db.query('SELECT status,ciphertext FROM shopify_public_installs WHERE shop=$1 ORDER BY created_at DESC LIMIT 1',[activeFixture.shop])).rows[0];assert.equal(row.status,'FAILED');assert.equal(row.ciphertext,null);
   }
   assert.equal((await db.query('SELECT count(*)::int n FROM workspace_connectors')).rows[0].n,before);
   activeFixture=prior;
  });
  await t.test('expired or missing browser proof recovers through Shopify instead of granting access from a charge ID',async()=>{
   const before=(await db.query('SELECT count(*)::int n FROM account_subscriptions')).rows[0].n;
   for(const plan of ['starter','growth','pro']){const r=await request(app).get('/integrations/shopify/connect').query({shop:'recovery-fixture.myshopify.com',plan_handle:plan,charge_id:'forged'});assert.equal(r.status,303,r.text);assert.equal(r.headers.location,'https://admin.shopify.com/store/recovery-fixture/apps/stockchief');}
   const unsafe=await request(app).get('/integrations/shopify/connect').query({shop:'attacker.example/path',plan_handle:'pro'});assert.equal(unsafe.status,400);assert(!unsafe.headers.location);
   const hinted=await request(app).get('/integrations/shopify/connect?plan_handle=pro').set('Cookie','stockchief_shopify_store=recovery-fixture.myshopify.com');assert.equal(hinted.status,303);assert.equal(hinted.headers.location,'https://admin.shopify.com/store/recovery-fixture/apps/stockchief');
   const signedIn=request.agent(app),login=await signedIn.get('/login');await signedIn.post('/login').type('form').send({_csrf:csrf(login.text),...lastAccount});
   const owned=await signedIn.get('/integrations/shopify/connect?plan_handle=starter');assert.equal(owned.status,303);assert.equal(owned.headers.location,'https://admin.shopify.com/store/ui-billing-3/apps/stockchief','A bound owner can recover a return with neither a proof cookie nor a shop parameter');
   assert.equal((await db.query('SELECT count(*)::int n FROM account_subscriptions')).rows[0].n,before);
  });
  assert(calls.every(c=>c.host!=='api.stripe.com'),'No Shopify registration or payment return calls Stripe');
  const billingCosts=(await db.query("SELECT provider,amount_minor,detail FROM commercial_cost_events WHERE provider IN('shopify_billing','stripe_billing')")).rows;assert(billingCosts.length>0);assert(billingCosts.every(c=>c.provider==='shopify_billing'&&Number(c.amount_minor)===0&&c.amount_minor!==null),'Shopify billing reads are recorded separately with request-fee evidence, without inventing Stripe cost warnings');
  assert.equal((await db.query("SELECT count(*)::int n FROM commercial_critical_warnings WHERE code='MISSING_COST_RATE' AND status='OPEN' AND detail->>'provider' IN('stripe_billing','shopify_billing')")).rows[0].n,0);
  await t.test('Shopify billing renders usable controls in Chromium',async()=>{
   const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port;
   let browser;try{browser=await require('playwright').chromium.launch();const page=await browser.newPage({viewport:{width:1280,height:900}});await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    await page.goto(base+'/login');await page.locator('input[name="email"]').fill(lastAccount.email);await page.locator('input[name="password"]').fill(lastAccount.password);await page.locator('form[action="/login"] button[type="submit"]').click();
    await page.goto(base+'/settings/billing');await page.getByRole('heading',{name:'Plan & billing',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Manage plan in Shopify',exact:true}).count(),1);assert.equal(await page.locator('form[action="/billing/checkout"]').count(),0);
    await page.screenshot({path:'output/shopify-managed-billing-pro-browser.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.sc-sidebar').getBoundingClientRect().right<=0);await page.screenshot({path:'output/shopify-managed-billing-pro-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'Billing fits a mobile screen');
   }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
  });
  await t.test('an eligible refund request is saved even while the Partner API is unavailable',async()=>{
   const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),...lastAccount});
   const bill=await agent.get('/settings/billing');global.fetch=async()=>{throw Error('Simulated Partner API outage');};
   const result=await agent.post('/billing/refund').type('form').send({_csrf:csrf(bill.text),confirm:'refund'});assert.equal(result.status,303,result.text);
   const row=(await db.query('SELECT r.* FROM commercial_shopify_guarantees r JOIN accounts a ON a.id=r.account_id WHERE a.email=$1',[lastAccount.email])).rows[0];assert.equal(row.status,'REQUESTED');
   assert.equal((await db.query('SELECT count(*)::int n FROM support_requests WHERE request_key=$1',['shopify-guarantee:'+row.id])).rows[0].n,1);
   assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE kind='commercial.shopify-guarantee' AND payload->>'requestId'=$1",[row.id])).rows[0].n,1);
  });
 }finally{global.fetch=oldFetch;await app.locals.sessionStore.close();await db.close();await cluster.stop();process.env=env;}
});
