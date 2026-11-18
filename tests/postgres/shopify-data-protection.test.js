'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const access=require('../../src/operations/postgres-data-access');

test('privacy controls and scoped access review work on Starter, Growth and Pro without changing subscriptions',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx,browser}=f;
 for(const plan of ['starter','growth','pro']){
  await f.subscribe(plan);
  const subscription=await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId]);
  const page=await browser.get('/sales/customers/fixture-customer?token=never-log-this&q=customer-secret').expect(200);
  assert.match(page.text,/Customer privacy · Credit decisions/);
  await browser.post('/sales/customers/fixture-customer/decision-preference').type('form').send({_csrf:f.csrf(page.text),mode:'manual',expected:'true'}).expect(303);
  assert.equal((await db.query("SELECT automated_credit_decisions FROM customers WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId])).rows[0].automated_credit_decisions,false);
  const manual=await browser.get('/sales/customers/fixture-customer').expect(200);
  assert.match(manual.text,/opted for manual credit decisions/);
  const log=await browser.get('/settings/privacy/access').expect(200);
  assert.match(log.text,/Recent access/);
  await browser.post('/settings/privacy/access-review').type('form').send({_csrf:f.csrf(log.text),reviewed:'yes'}).expect(303);
  await browser.post('/sales/customers/fixture-customer/decision-preference').type('form').send({_csrf:f.csrf(manual.text),mode:'rules',expected:'false'}).expect(303);
  assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,subscription.rows,'A privacy choice must never create or modify billing on '+plan);
 }
 const rows=(await db.query('SELECT * FROM stockchief_runtime.data_access_events WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert(rows.some(r=>r.area==='sales'&&r.account_id===f.owner.accountId&&r.actor_id===ctx.actorId));
 assert(!JSON.stringify(rows).includes('never-log-this'));
 assert(!JSON.stringify(rows).includes('customer-secret'));
 assert(!JSON.stringify(rows).includes(f.email));
 const foreign={...ctx,workspaceId:randomUUID()};
 assert.equal((await access.review(db,foreign)).rows.length,0);
 const holds=require('../../src/sales/agent-credit-holds');
 await assert.rejects(holds.saveCustomerChoice(db,foreign,'fixture-customer',{mode:'manual',expected:'true'}),e=>e.code==='forbidden');
 await assert.rejects(holds.saveCustomerChoice(db,ctx,'fixture-customer',{mode:'manual',expected:'false'}),/changed/);
 await db.query("UPDATE account_subscriptions SET status='CANCELLED' WHERE account_id=$1",[f.owner.accountId]);
 const readonly=await browser.get('/sales/customers/fixture-customer').expect(200);
 await browser.post('/sales/customers/fixture-customer/decision-preference').type('form').send({_csrf:f.csrf(readonly.text),mode:'manual',expected:'true'}).expect(303);
 const readonlyReview=await browser.get('/settings/privacy/access').expect(200);
 await browser.post('/settings/privacy/access-review').type('form').send({_csrf:f.csrf(readonlyReview.text),reviewed:'yes'}).expect(303);
 assert.equal((await db.query('SELECT status FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows[0].status,'CANCELLED','Privacy rights cannot reactivate billing.');

 // Verify no anonymous token/URL is copied into the event and recent history is
 // protected even from an accidental application UPDATE/DELETE.
 await access.record(db,ctx,{channel:'PRIVATE_LINK',area:'customer_order',reference:'opaque-record'});
 const current=(await db.query('SELECT id FROM stockchief_runtime.data_access_events ORDER BY id DESC LIMIT 1')).rows[0].id;
 await assert.rejects(db.query('UPDATE stockchief_runtime.data_access_events SET area=$2 WHERE id=$1',[current,'other']),/immutable/);
 await assert.rejects(db.query('DELETE FROM stockchief_runtime.data_access_events WHERE id=$1',[current]),/immutable/);
 await db.query("INSERT INTO stockchief_runtime.data_access_events(workspace_id,channel,area,method,created_at) VALUES($1,'APP','sales','GET',now()-interval '181 days')",[ctx.workspaceId]);
 const ordersBefore=(await db.query('SELECT count(*)::int n FROM sales_orders')).rows[0].n;
 const cleanup=await require('../../src/operations/postgres-retention').run(db);
 assert.equal(cleanup.dataAccessEvents,1);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders')).rows[0].n,ordersBefore);
 const checkpoint=await require('../../src/operations/postgres-checkpoints').get(db,'security.retention');
 assert.equal(checkpoint.status,'PASS');assert.equal(checkpoint.detail.policyVersion,'2026-11-18');
 assert((await db.query('SELECT id FROM stockchief_runtime.data_access_events WHERE id=$1',[current])).rowCount);
 // Exercise the actual rendered controls on desktop and phone, including a
 // read-only subscription, without using a real merchant account or provider.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port,fs=require('node:fs'),path=require('node:path'),folder=path.join(process.cwd(),'output','shopify-data-protection');fs.mkdirSync(folder,{recursive:true});
 for(const [name,viewport] of [['desktop',{width:1366,height:900}],['phone',{width:390,height:844}]]){
  const page=await chrome.newPage({viewport});page.setDefaultTimeout(15000);
  await page.goto(origin+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const [route,heading,file] of [['/sales/customers/fixture-customer','Customer privacy · Credit decisions','customer'],['/settings/privacy/access','Personal data access','access'],['/security/data-protection','Data protection policy','policy']]){
   await page.goto(origin+route);assert(await page.getByRole('heading',{name:heading,exact:true}).isVisible());
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' overflows on '+name);
   await page.screenshot({path:path.join(folder,file+'-'+name+'.png'),fullPage:true});
  }
  await page.close();
 }
});

test('a failed access-log write prevents authenticated disclosure and leaves public health and webhooks independent',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:2});await f.subscribe('starter');
 const db=new Proxy(f.db,{get(target,key){if(key==='query')return(sql,...args)=>String(sql).includes('INSERT INTO stockchief_runtime.data_access_events')?Promise.reject(Object.assign(new Error('fixture audit outage'),{code:'fixture_outage'})):target.query(sql,...args);const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 f.cleanup(()=>app.locals.sessionStore.close());const browser=require('supertest').agent(app);
 const login=await browser.get('/login').expect(200);
 await browser.post('/login').type('form').send({_csrf:f.csrf(login.text),email:f.email,password:f.password}).expect(302);
 const denied=await browser.get('/sales/customers').expect(503);assert.doesNotMatch(denied.text,/fixture-customer|Customer details|fixture audit outage/);
 await browser.get('/healthz').expect(200);
 await require('supertest')(app).get('/privacy').expect(200);
});
