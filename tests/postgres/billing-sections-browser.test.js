'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
test('billing sections show the correct plan and balances without crowding or creating purchases',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db}=f;
 const oldCheckout=process.env.STOCKCHIEF_CHECKOUT_ENABLED,oldAccount=process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID;t.after(()=>{for(const [key,value]of [['STOCKCHIEF_CHECKOUT_ENABLED',oldCheckout],['STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID',oldAccount]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
 process.env.STOCKCHIEF_CHECKOUT_ENABLED='true';process.env.STOCKCHIEF_BILLING_STRIPE_ACCOUNT_ID=require('../../src/commercial/stripe-live-fee-evidence').accountId;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),commercialOptions:{billingProvider:{listInvoices:async()=>({data:[]})},loadInvoices:false,publicOrigin:'request',testMode:true}}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const browser=await require('playwright').chromium.launch(),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),base='http://127.0.0.1:'+server.address().port;
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
 const folder=path.join(process.cwd(),'output','billing-design');fs.mkdirSync(folder,{recursive:true});
 await db.query('UPDATE commercial_release_control SET checkout_enabled=true,economics_approved_at=now(),readiness_approved_at=now() WHERE singleton=true');
 await db.query("UPDATE commercial_critical_warnings SET status='RESOLVED'");
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 for(const plan of ['starter','growth','pro']){
  await f.subscribe(plan);await db.query("UPDATE account_subscriptions SET stripe_customer_id='cus_layout_fixture',stripe_subscription_id='sub_layout_fixture',current_period_start=now(),current_period_end=now()+interval '1 month' WHERE account_id=$1",[f.owner.accountId]);const before=(await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows;
  await page.goto(base+'/settings/billing');
  const styles=await page.evaluate(()=>Object.fromEntries(['.sc-settings-nav','.sc-billing-limit-grid','.sc-billing-limit','.ox-plan-now','.sc-guarantee'].map(selector=>{const node=document.querySelector(selector);if(!node)return [selector,null];const s=getComputedStyle(node);return [selector,{display:s.display,direction:s.flexDirection,columns:s.gridTemplateColumns,opacity:s.opacity,borderTop:s.borderTopWidth,parent:node.parentElement.className}];})));
  fs.writeFileSync(path.join(folder,plan+'-styles.json'),JSON.stringify(styles,null,2));
  assert.equal(styles['.sc-settings-nav'].direction,'row');assert.equal(styles['.sc-billing-limit-grid'].columns.split(' ').length,3);assert.match(await page.locator('#plan-now-title').innerText(),new RegExp(plan,'i'));assert.doesNotMatch(await page.locator('#billing-overview').innerText(),/included Inventories/,'An account capacity limit is not presented as monthly usage');
  for(const [label,id]of [['Overview','billing-overview'],['Add capacity','billing-capacity'],['Change plan','billing-plans'],['Billing history','billing-history']]){
   await page.getByRole('link',{name:label,exact:true}).click();assert(await page.locator('#'+id).isVisible(),label+' shows its content');assert.equal(await page.getByRole('link',{name:label,exact:true}).getAttribute('aria-current'),'page');
  }
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.goto(base+'/settings/billing');assert(await page.locator('#billing-overview').isVisible());await page.locator('h1').scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(folder,plan+'-overview-'+width+'.png'),fullPage:true});}
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(base+'/settings/billing?add=ai#ai-credit-packs');assert(await page.locator('#ai-credit-packs').isVisible());assert.equal(await page.getByRole('link',{name:'Add capacity',exact:true}).getAttribute('aria-current'),'page');
  await page.screenshot({path:path.join(folder,plan+'-capacity.png'),fullPage:true});
  assert.deepEqual((await db.query('SELECT * FROM account_subscriptions WHERE account_id=$1',[f.owner.accountId])).rows,before);
 }
});
