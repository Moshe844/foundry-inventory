'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{chromium}=require('playwright');
test('Connections, Settings and related pages use their real controls without consuming slots on popup close',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t,{units:2}),{db,ctx}=f;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES('connection-browser-plan',$1,'growth','COMP','CUSTOM','ISOLATED_TEST')",[f.owner.accountId]);
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,source) VALUES('connection-browser-accounting',$1,'connections.accounting',1,'Isolated provider UI coverage','ISOLATED_TEST')",[f.owner.accountId]);
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,source) VALUES('connection-browser-payments',$1,'payments.customer',1,'Isolated provider UI coverage','ISOLATED_TEST')",[f.owner.accountId]);
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,source) VALUES('connection-browser-mail',$1,'communications.ai_drafts',1,'Isolated mailbox switch coverage','ISOLATED_TEST')",[f.owner.accountId]);
 const consent=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Provider authorization fixture</title><h1>Authorize your account</h1>');});await new Promise(r=>consent.listen(0,'127.0.0.1',r));
 const names={shopify:'Shopify',woocommerce:'WooCommerce',bigcommerce:'BigCommerce',square:'Square',clover:'Clover',gmail:'Gmail',microsoft365:'Microsoft 365',quickbooks:'QuickBooks',xero:'Xero'},types=Object.keys(names),metadata=type=>({type,name:names[type],description:'Connect your business records.',available:true,authMode:type==='woocommerce'?'application_auth':'oauth',sandboxMode:['square','clover'].includes(type),provides:[]}),providers={catalog:()=>types.map(metadata),inventorySources:()=>types.map(metadata),get:type=>names[type]?{oauthSessionBound:type==='bigcommerce',metadata:()=>metadata(type),authorizationUrl:({state})=>({url:'http://127.0.0.1:'+consent.address().port+'/authorize?state='+state})}:null};
 const priorClient=process.env.STRIPE_CONNECT_CLIENT_ID,priorSecret=process.env.STRIPE_SECRET_KEY;process.env.STRIPE_CONNECT_CLIENT_ID='ca_fixture_connections';process.env.STRIPE_SECRET_KEY='sk_test_fixture_connections';
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'connection-settings-fixture',aiProvider:{draftReply:async()=>{throw Error('Model calls are forbidden in this fixture');}},connectionProviders:providers,paymentOptions:{connect:{testQualifiedConnection:true,authorizeEndpoint:'http://127.0.0.1:'+consent.address().port+'/stripe'}}}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch(),context=await browser.newContext({timezoneId:'America/New_York'}),page=await context.newPage(),base='http://127.0.0.1:'+server.address().port,errors=[];
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>consent.close(r));await app.locals.sessionStore.close();for(const [k,v]of [['STRIPE_CONNECT_CLIENT_ID',priorClient],['STRIPE_SECRET_KEY',priorSecret]])if(v===undefined)delete process.env[k];else process.env[k]=v;});
 page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);await page.goto(base+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const count=async()=>Number((await db.query('SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),before=await count();
 await t.test('every OAuth provider opens an actual popup; closing it leaves count, history and parent unchanged',async()=>{
  for(const type of [...types,'stripe']){
   t.diagnostic('Opening provider '+type);
   await page.goto(base+'/settings/connections');const card=page.locator('[data-integration-card="'+type+'"]');assert(await card.isVisible(),type+' must stay visible');
   if(['shopify','woocommerce','bigcommerce'].includes(type)){
    await card.getByRole('button',{name:'Connect '+names[type],exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Connect '+names[type],exact:true});
    const field=dialog.locator('input:not([type=hidden])').first();await field.fill(type==='shopify'?'example.myshopify.com':'https://example.test');
    const opened=page.waitForEvent('popup');await dialog.locator('form[data-oauth-connect] button[type=submit]').click();const popup=await opened;await popup.waitForURL('**/authorize?**');await popup.close();
   }else{const opened=page.waitForEvent('popup');await card.locator('a[data-provider-connect]').click();const popup=await opened;await popup.waitForURL(type==='stripe'?'**/stripe?**':'**/authorize?**');await popup.close();}
   assert.equal(new URL(page.url()).pathname,'/settings/connections');assert.equal(await count(),before,type+' close must not create a record');
   assert.equal((await require('../../src/connections/postgres-service').list(db,ctx.workspaceId)).filter(c=>!['shippo'].includes(c.provider_type)).length,0);
  }
  const rows=(await db.query('SELECT connector_id,expires_at,created_at FROM connection_authorization_states WHERE workspace_id=$1',[ctx.workspaceId])).rows;assert(rows.length>=9);assert(rows.every(r=>r.connector_id===null));
 });
 await t.test('three desktop columns, single phone column, Sola modal and labelled history',async()=>{
  for(const [width,columns]of [[1440,3],[390,1]]){await page.setViewportSize({width,height:950});await page.goto(base+'/settings/connections');assert.equal(await page.locator('main h1').innerText(),'Connections');assert.equal(await page.locator('.sc-provider-grid').first().evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),columns);assert(await page.locator('.sc-provider-card').evaluateAll(es=>es.every(e=>e.getBoundingClientRect().width>200)));assert(await page.locator('main img').evaluateAll(es=>es.every(e=>e.complete&&e.naturalWidth>0)));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.getByRole('button',{name:'Connect Sola',exact:true}).click();await page.getByRole('dialog',{name:'Connect Sola',exact:true}).waitFor();assert(await page.getByLabel('Private transaction API key').isVisible());await page.getByRole('dialog',{name:'Connect Sola',exact:true}).getByRole('button',{name:'Close',exact:true}).click();
  if(process.env.STOCKCHIEF_NAV_ARTIFACT_DIR){const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(process.env.STOCKCHIEF_NAV_ARTIFACT_DIR,{recursive:true});for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.goto(base+'/settings/connections');await page.screenshot({path:path.join(process.env.STOCKCHIEF_NAV_ARTIFACT_DIR,'connections-'+width+'.png'),fullPage:true});}}
  await page.locator('.sc-connection-history summary').click();assert(await page.locator('.sc-connection-history a').evaluateAll(es=>es.every(e=>e.textContent.trim())));
  await page.goto(base+'/connections');assert.equal(new URL(page.url()).pathname,'/settings/connections');
 });
 await t.test('both mailbox toggles show status and persist owner changes without sending email',async()=>{
  const intent=require('../../src/connections/authorization-intent'),service=require('../../src/connections/postgres-provider-service');
  for(const type of ['gmail','microsoft365']){
   const id=await service.finishAuthorization(db,intent.draft(ctx.workspaceId,ctx.actorId,type,{name:names[type]}),ctx.actorId,{accountId:type+'-fixture@example.test',accountName:type+'-fixture@example.test',credentials:{accessToken:'isolated-fixture'},capabilities:['mail:read']});
   await page.goto(base+'/settings/connections');const row=page.locator('[data-connected-id="'+id+'"]'),toggle=row.getByRole('switch');assert.equal(await toggle.getAttribute('aria-checked'),'false');assert.match(await row.innerText(),/No reply preparation recorded yet/);assert(await toggle.isEnabled(),await row.innerText());
   await Promise.all([page.waitForNavigation(),toggle.click()]);assert.equal(new URL(page.url()).pathname,'/settings/connections');assert.equal(await page.locator('[data-connected-id="'+id+'"] [role=switch]').getAttribute('aria-checked'),'true');
   assert.equal((await db.query('SELECT config::jsonb->>\'replyPreparationEnabled\' enabled FROM workspace_connectors WHERE id=$1',[id])).rows[0].enabled,'true');
   await Promise.all([page.waitForNavigation(),page.locator('[data-connected-id="'+id+'"] [role=switch]').click()]);assert.equal(await page.locator('[data-connected-id="'+id+'"] [role=switch]').getAttribute('aria-checked'),'false');
  }
  assert.equal((await db.query('SELECT count(*)::int n FROM connection_email_messages WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 });
 await t.test('Settings renders one section, and Save enables only after a real change',async()=>{
  for(const section of ['general','team','notifications','ai','data','advanced']){await page.goto(base+'/settings?section='+section);assert.equal(await page.locator('main h1').innerText(),'Settings');assert.equal(await page.locator('[data-settings-section]').getAttribute('data-settings-section'),section);assert((await page.locator('.sc-settings-content').boundingBox()).width<=720);assert((await page.getByRole('button',{name:'Save',exact:true}).count())<=1);assert.doesNotMatch(await page.locator('main').innerText(),/Developer test accounts|Sample and test data|Live operating feed|taught by talking/);}
  await page.goto(base+'/settings?section=general');const save=page.getByRole('button',{name:'Save',exact:true});assert(await save.isDisabled());const name=page.getByLabel('Inventory name',{exact:true}),initial=await name.inputValue();await name.fill(initial+' updated');assert(await save.isEnabled());await name.fill(initial);assert(await save.isDisabled());
  await page.goto(base+'/settings?section=ai');assert(await page.getByLabel('Answer style').isVisible());await page.getByLabel('Answer style').fill('Concise');assert(await page.getByRole('button',{name:'Save',exact:true}).isEnabled());
 });
 await t.test('Settings aliases and legacy links open the canonical section without losing the origin',async()=>{
  const navigation=require('../../src/web/presentation/navigation'),declare=require('../../src/web/presentation/link-destinations').declare;
  for(const [alias,section,hash]of [['/team','team','people'],['/settings/team','team','people'],['/profile','advanced','account'],['/account','advanced','account']]){
   const response=await context.request.get(base+alias+'?q=preserve&section=general',{maxRedirects:0});assert.equal(response.status(),301);
   const target=new URL(response.headers().location,base);assert.equal(target.searchParams.get('q'),'preserve');assert.equal(target.searchParams.get('section'),section);assert.equal(target.hash,'#'+hash);
   const visits=[];const record=request=>{if(request.isNavigationRequest()&&request.frame()===page.mainFrame())visits.push(request.url());};page.on('request',record);
   await page.goto(base+alias);await page.waitForLoadState('networkidle');page.off('request',record);assert.equal(new URL(page.url()).searchParams.get('section'),section);assert.equal(await page.locator('[data-settings-section]').getAttribute('data-settings-section'),section);assert.equal(visits.length,2,'Only the alias and one canonical document may load');assert.equal(await page.locator('a[data-return-to]').count(),0);
  }
  for(const [hash,section]of Object.entries(navigation.settingsSectionHashes)){
   const html=declare('<a href="/settings?q=kept#'+hash+'">Settings control</a>');assert(html.includes('section='+section));assert(html.includes('q=kept'));assert(html.includes('data-dest='));
  }
  const origin='/orders?q=keep-this-filter';await page.goto(base+origin);await page.evaluate(()=>{const a=document.createElement('a');a.href='/profile';a.textContent='Open profile for routing verification';document.querySelector('main').append(a);});await page.getByRole('link',{name:'Open profile for routing verification',exact:true}).click();await page.waitForURL('**/settings?section=advanced#account');assert.equal(await page.locator('a[data-return-to]').getAttribute('href'),origin);await page.locator('a[data-return-to]').click();await page.waitForURL(base+origin);
 });
 await t.test('Orders, Buy, Home, Stock, reports and hero use the requested presentation',async()=>{
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,created_at,updated_at) VALUES('stock-pill-test',$1,$2,$3,2,8,now(),now())`,[ctx.workspaceId,f.item.skuIds[0],f.location.id]);
  await page.goto(base+'/inventory/table');assert.equal(await page.locator('td.sc-stock-selection').count(),1);assert.equal(await page.locator('td .badge').filter({hasText:/^Low$/}).count(),1);
  for(const [url,title]of [['/orders','Orders'],['/purchasing/orders','Purchase orders']]){await page.goto(base+url);assert.equal(await page.locator('main h1').innerText(),title);assert.equal(await page.locator('.sc-section-tabs').count(),1);assert.equal(await page.locator('main a').filter({hasText:/^Picking and packing$/}).count(),0);assert.doesNotMatch(await page.locator('main').innerText(),/Each of these is a story/);}
  await page.goto(base+'/');assert.equal(await page.locator('[data-home-section=suggestions]').count(),0);assert.equal(await page.locator('[data-home-section=activity]').count(),0);
  await page.setViewportSize({width:1440,height:1000});await page.goto(base+'/reports');assert.equal(await page.locator('.report-datasets').evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),3);
  const publicPage=await context.newPage();await publicPage.goto(base+'/login');const publicContext=await browser.newContext({javaScriptEnabled:false}),landing=await publicContext.newPage();await landing.goto(base+'/');assert(await landing.locator('.flow-card').evaluateAll(es=>es.every(e=>getComputedStyle(e).opacity==='1')));await publicContext.close();await publicPage.close();
 });
 assert.deepEqual(errors,[]);t.diagnostic(JSON.stringify({actualBrowser:true,actualPostgreSQL:true,simulatedOAuthConsent:true,allTenOAuthPopups:true,noSlotsConsumed:true,sandboxCardsVisible:true,paidCalls:0}));
});
