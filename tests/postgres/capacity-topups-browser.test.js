'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('credit warnings open the correct monthly capacity checkout and verified add-ons preserve every plan',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,
  ent=require('../../src/commercial/entitlements'),capacity=require('../../src/commercial/capacity-addons'),config=require('../../src/config');
 const keys=['STOCKCHIEF_CHECKOUT_ENABLED','STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID'];
 const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=require('../../src/commercial/stripe-live-fee-evidence').accountId;
 t.after(()=>{for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];});
 await db.query("UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true");
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[f.owner.accountId]);
 await db.query("UPDATE commercial_capacity_products SET stripe_price_id='fixture_'||id WHERE id<>'agent-monthly-credits'");
 const calls=[],provider={listInvoices:async()=>({data:[]}),
  retrievePrice:async id=>({id,active:true,type:'recurring',currency:'usd',unit_amount:4900,recurring:{interval:'month'}}),
  createCapacityCheckout:async input=>{calls.push(input);return {id:'cs_'+input.orderId,url:'https://billing.example.test/fixture'};},
  setCancellation:async input=>({id:input.subscriptionId,customer:input.customerId,cancel_at_period_end:true})};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),commercialOptions:{billingProvider:provider,loadInvoices:false,publicOrigin:'request',testMode:true}}),
  server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const screenshotDir=require('node:path').join(process.cwd(),'data','capacity-topups');require('node:fs').mkdirSync(screenshotDir,{recursive:true});
 const base='http://127.0.0.1:'+server.address().port,page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://billing.example.test/**',r=>r.fulfill({status:200,body:'Synthetic checkout. No charge.'}));
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const scope={accountId:f.owner.accountId,workspaceId:ctx.workspaceId};
 for(const plan of ['starter','growth','pro'])await t.test(plan,async()=>{
  await f.subscribe(plan);await db.query("UPDATE account_subscriptions SET stripe_customer_id='cus_capacity',stripe_subscription_id='sub_main' WHERE account_id=$1",[scope.accountId]);
  await db.query("DELETE FROM commercial_usage_allocations WHERE event_id IN (SELECT id FROM commercial_usage_events WHERE account_id=$1 AND meter='ai_work_credits')",[scope.accountId]);
  await db.query("DELETE FROM commercial_usage_events WHERE account_id=$1 AND meter='ai_work_credits'",[scope.accountId]);
  await db.query("DELETE FROM commercial_usage_grants WHERE account_id=$1",[scope.accountId]);
  const ai=await ent.meterState(db,scope,'ai_work_credits'),used=Math.ceil(ai.included*.8),event=randomUUID();
  await ent.recordUsage(db,scope,{meter:'ai_work_credits',units:used-1,idempotencyKey:event});
  await page.goto(base+'/ask');assert.equal(await page.locator('[data-ai-credit-notice]').isVisible(),false,'No premature warning');
  await ent.recordUsage(db,scope,{meter:'ai_work_credits',units:1,idempotencyKey:event+':threshold'});
  await page.waitForFunction(()=>!document.querySelector('[data-ai-credit-notice]').hidden,{},{timeout:22000});const banner=page.locator('[data-ai-credit-notice]');assert(await banner.isVisible(),'80% usage is visible outside the collapsed credit details');
  const link=banner.getByRole('link',{name:'Add more AI credits'});assert.equal(await link.getAttribute('href'),'/settings/billing?add=ai#ai-credit-packs');
  await link.click();await page.waitForURL('**/settings/billing?add=ai#ai-credit-packs');
  assert.equal(await page.locator('#extra-capacity').getAttribute('open'),'');assert(await page.locator('#ai-credit-packs').isVisible());
  assert(await page.locator('#ai-credit-packs button').isDisabled(),'Unqualified AI packs cannot take payment');
  assert.equal(await page.getByRole('heading',{name:'Auto-top-up',exact:true}).count(),0,'No empty legacy auto-top-up controls');
  assert.equal(await page.locator('[data-capacity-product=agent-location-inventory]').count(),plan==='pro'?0:1);
  assert.equal(await page.locator('[data-capacity-product=agent-pro-edi]').count(),plan==='pro'?1:0);
  const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[scope.accountId])).rows;
  const doc=page.locator('#document-packs');await doc.locator('[name=quantity]').fill('2');assert.match(await doc.locator('[data-capacity-total]').innerText(),/98\.00/);
  for(const width of [1440,390]){
   const preview=await page.context().newPage();await preview.setViewportSize({width,height:1000});await preview.goto(base+'/settings/billing?add=ai#ai-credit-packs');
   assert(await preview.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),plan+' fits '+width);
   await preview.locator('#extra-capacity').screenshot({path:require('node:path').join(screenshotDir,plan+'-'+width+'.png')});await preview.close();
  }
  await page.setViewportSize({width:1440,height:1000});
  const formInfo=await doc.locator('form').evaluate(form=>({action:form.action,valid:form.checkValidity(),invalid:[...form.elements].filter(e=>e.willValidate&&!e.validity.valid).map(e=>({name:e.name,message:e.validationMessage})),confirmation:form.getAttribute('data-confirm'),buttonType:form.querySelector('button').type,method:form.method,buttonAction:form.querySelector('button').form?.action}));assert.equal(formInfo.valid,true,JSON.stringify(formInfo));assert.equal(new URL(formInfo.buttonAction).pathname,'/billing/capacity',JSON.stringify(formInfo));
  await Promise.all([page.waitForURL('https://billing.example.test/fixture'),doc.getByRole('button',{name:'Review secure checkout'}).click()]);
  assert.equal(calls.at(-1).quantity,2);
  const order=(await capacity.list(db,scope.accountId)).find(o=>o.id===calls.at(-1).orderId);assert(order);assert.equal(Number(order.units),1000);
  const at=Math.floor(Date.now()/1000),invoice={id:'in_'+order.id,status:'paid',currency:'usd',total:9800,customer:'cus_capacity',subscription:'sub_'+order.id,metadata:{stockchief_capacity_order_id:order.id,stockchief_account_id:scope.accountId},lines:{has_more:false,data:[{quantity:2,price:{id:order.price_id},period:{start:at-10,end:at+86400}}]}};
  const priorDocs=(await ent.meterState(db,scope,'agent_documents')).remaining;
  const paid=()=>db.transaction(c=>capacity.receive(c,{id:'evt_'+order.id,created:at,type:'invoice.paid',data:{object:invoice}}));await paid();await paid();
  assert.equal((await ent.meterState(db,scope,'agent_documents')).remaining,priorDocs+1000,'Payment adds exactly 2 document packs once');
  await capacity.cancel(db,scope.accountId,order.id,{provider});assert.equal((await ent.meterState(db,scope,'agent_documents')).remaining,priorDocs+1000,'Cancellation preserves paid-through capacity');
  await page.goto(base+'/settings/billing?add=documents#document-packs');assert(await page.getByText(/This add-on ends on/).first().isVisible());
  assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[scope.accountId])).rows,before,'Main subscription and feature plan are unchanged');
  await ent.recordUsage(db,scope,{meter:'ai_work_credits',units:ai.included-used,idempotencyKey:event+':exhausted'});await page.goto(base+'/ask');assert.equal(await page.locator('[data-ai-credit-notice]').getAttribute('data-ai-credit-notice'),'exhausted');
  // Synthetic balance fixture exercises warning recovery; actual paid AI grant delivery is tested separately in agent-plan-addons.
  await db.query("UPDATE commercial_usage_grants SET category='ai_work_credits',units=$2 WHERE capacity_invoice_id=$1",[invoice.id,Math.max(5000,Math.ceil(ai.included*.25))]);
  assert.equal((await require('../../src/commercial/ai-spending-limits').availability(db,ctx.workspaceId,ctx.actorId)).creditWarning,false);
  await page.waitForFunction(()=>document.querySelector('[data-ai-credit-notice]').hidden,{},{timeout:22000});assert.equal(await page.locator('[data-ai-credit-notice]').isVisible(),false,'Purchased credits clear the exhausted warning');
 });
 await t.test('restricted staff cannot purchase or change shared billing',async()=>{
  const ai=await ent.meterState(db,scope,'ai_work_credits');
  await ent.recordUsage(db,scope,{meter:'ai_work_credits',units:ai.remaining,idempotencyKey:'staff-credit-exhaustion'});
  await db.query("UPDATE users SET role='staff' WHERE id=$1",[ctx.actorId]);
  await page.goto(base+'/ask');const notice=page.locator('[data-ai-credit-notice]');assert(await notice.isVisible());assert.match(await notice.innerText(),/account owner/);assert.equal(await notice.getByRole('link',{name:'Add more AI credits'}).count(),0);
  const denied=await f.browser.get('/settings/billing?add=ai');assert.equal(denied.status,403);
  const ask=await f.browser.get('/ask'),before=calls.length;
  const ordersBefore=(await capacity.list(db,scope.accountId)).length,refused=await f.browser.post('/billing/capacity').type('form').send({_csrf:f.csrf(ask.text),productId:'agent-monthly-documents',quantity:1,purchaseKey:'staff-blocked'});
  assert([403,303].includes(refused.status),'The native refusal may render or redirect with a permission message');assert.equal(calls.length,before,'No checkout is created for staff');assert.equal((await capacity.list(db,scope.accountId)).length,ordersBefore,'Restricted requests cannot save a hidden purchase');
  await db.query("UPDATE users SET role='owner' WHERE id=$1",[ctx.actorId]);
 });
 assert.deepEqual(errors,[]);
});

