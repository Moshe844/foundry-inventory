'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
test('settings tabs, plan-aware imports and immediate team removal work in the browser and on the server',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,auth=require('../../src/domain/postgres-auth-service'),team=require('../../src/operations/postgres-team-access');
 await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[f.owner.accountId]);
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,source) SELECT 'settings-controls',$1,'pro',id,'COMP','ISOLATED_TEST' FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1",[f.owner.accountId]);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 const browser=await require('playwright').chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const proof=process.env.STOCKCHIEF_CUSTOMER_SETTINGS_PROOF_DIR;
 for(const plan of ['starter','growth','pro']){
  await db.query("UPDATE account_subscriptions SET plan_id=$2,plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id=$2 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId,plan]);
  for(const tab of ['general','team','notifications','ai','data','advanced','connections','billing']){
   const target=tab==='connections'?'/settings/connections':tab==='billing'?'/settings/billing':'/settings?section='+tab;
   const response=await page.goto(base+target);assert.equal(response.status(),200,plan+' '+tab);
   assert.equal(await page.locator('.sc-settings-nav [aria-current=page]').innerText(),({general:'General',team:'Team',notifications:'Notifications',ai:'StockChief AI',data:'Data',advanced:'Advanced',connections:'Connections',billing:'Plan & billing'})[tab]);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),plan+' '+tab+' no horizontal overflow');
   if(proof&&plan==='pro'){fs.mkdirSync(proof,{recursive:true});await page.screenshot({path:path.join(proof,'settings-'+tab+'.png'),fullPage:true});}
  }
  if(plan==='pro'){
   await page.setViewportSize({width:390,height:844});
   for(const tab of ['general','team','notifications','ai','data','advanced','connections','billing']){const target=tab==='connections'?'/settings/connections':tab==='billing'?'/settings/billing':'/settings?section='+tab;assert.equal((await page.goto(base+target)).status(),200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'phone '+tab+' has no page overflow');if(proof)await page.screenshot({path:path.join(proof,'settings-'+tab+'-390.png'),fullPage:true});}
   await page.setViewportSize({width:1440,height:1000});
  }
  const policy=await require('../../src/imports/plan-upload-policy').presentation(db,ctx.workspaceId);
  const ent=require('../../src/commercial/entitlements'),scope=await ent.ownerScopeForWorkspace(db,ctx.workspaceId);
  for(const meter of policy.meters){const actual=await ent.meterState(db,scope,meter.meter);assert.equal(meter.remaining,actual.remaining,plan+' '+meter.meter);}
  assert.equal(policy.handwriting,plan!=='starter');
  await page.goto(base+'/onboarding?add=1');assert.match(await page.locator('.setup-plan-allowance').innerText(),new RegExp(plan,'i'));
  const boxes=await page.locator('.setup-source-card:not(.setup-source-card--file)').evaluateAll(es=>es.map(e=>({height:e.getBoundingClientRect().height,button:e.querySelector('button').getBoundingClientRect().top})));
  assert(Math.abs(boxes[0].height-boxes[1].height)<2);assert(Math.abs(boxes[0].button-boxes[1].button)<2);
  await page.locator('[data-setup-details]>summary').click();
  const fields=await page.locator('.setup-details__forms input:not([type=hidden])').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().top));assert(Math.abs(fields[0]-fields[1])<2);
  await page.goto(base+'/settings?section=advanced');await page.locator('#live-event-feed>summary').click();
  const feedGate=(await require('../../src/web/presentation/plan-gates').read(db,scope))['connections.custom_api'];
  if(!feedGate.enabled){assert.equal(await page.getByRole('button',{name:'Create feed token',exact:true}).count(),0);assert.equal(await page.locator('[data-plan-lock="connections.custom_api"]').count(),1);
   const csrf=await page.locator('[name=_csrf]').first().inputValue();await page.request.post(base+'/settings/event-feed/enable',{form:{_csrf:csrf},maxRedirects:0});assert.equal((await db.query("SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1 AND provider_type='reference_webhook' AND status='connected'",[ctx.workspaceId])).rows[0].n,0);
  }
 }
 await db.query("UPDATE account_subscriptions SET plan_id='enterprise',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='enterprise' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId]);
 await page.goto(base+'/settings?section=advanced');await page.locator('#live-event-feed>summary').click();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create feed token',exact:true}).click()]);const feedToken=await page.getByLabel('New live feed token').inputValue();const feedAuth=await require('../../src/connections/postgres-service').authenticate(db,'Bearer '+feedToken);assert.equal(feedAuth.workspaceId,ctx.workspaceId);
 for(const lower of ['starter','growth','pro']){
  await db.query("UPDATE account_subscriptions SET plan_id=$2,plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id=$2 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId,lower]);
  const gate=(await require('../../src/web/presentation/plan-gates').read(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId}))['connections.custom_api'];if(gate.enabled)continue;
  await assert.rejects(require('../../src/connections/postgres-service').authenticate(db,'Bearer '+feedToken),e=>e.code==='entitlement_required');
  const raw={eventId:'downgraded-'+lower,type:'sale.completed',data:{externalSku:'locked-feed',skuCode:(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,locationName:f.location.name,quantity:1}};
  await assert.rejects(require('../../src/connections/postgres-event-ingestion').ingest(db,feedAuth,raw),e=>e.code==='entitlement_required');
  assert.equal((await page.request.post(base+'/api/v1/events',{headers:{Authorization:'Bearer '+feedToken},data:raw})).status(),402);assert.equal(await f.balance(),4);
 }
 await db.query("UPDATE account_subscriptions SET plan_id='enterprise',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='enterprise' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId]);await page.goto(base+'/settings?section=advanced');await page.locator('#live-event-feed>summary').click();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Disconnect live feed',exact:true}).click()]);await assert.rejects(require('../../src/connections/postgres-service').authenticate(db,'Bearer '+feedToken),/invalid|revoked/);
 await db.query("UPDATE account_subscriptions SET plan_id='pro',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId]);
 await page.goto(base+'/settings?section=data');const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Export this inventory',exact:true}).click();const download=await downloadPromise;assert.match(download.suggestedFilename(),/\.zip$/);const chunks=[];for await(const chunk of await download.createReadStream())chunks.push(chunk);assert.equal(Buffer.concat(chunks).subarray(0,2).toString(),'PK');
 await page.goto(base+'/settings?section=general');await page.locator('[name=name]').first().fill('Verified customer business');await page.locator('form[action="/settings/workspace"] button').click();await page.waitForLoadState('load');assert.equal((await db.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0].name,'Verified customer business');
 await page.goto(base+'/settings?section=ai');await page.locator('[name=answerStyle]').fill('Use short practical sentences.');await page.locator('[name=timeZone]').selectOption('America/New_York');await Promise.all([page.waitForNavigation(),page.locator('form[action="/settings/ask-preferences"] button').click()]);assert.equal((await require('../../src/assistant/postgres-answer-preferences').read(db,ctx)).answerStyle,'Use short practical sentences.');
 await page.goto(base+'/settings?section=notifications');await page.locator('[name=minimumSeverity]').selectOption('critical');await Promise.all([page.waitForNavigation(),page.locator('form[action="/settings/email-alerts"] button').click()]);assert.equal((await db.query('SELECT minimum_severity FROM notification_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].minimum_severity,'critical');
 const staffPassword='Team!'+randomUUID(),staff=await auth.createBusiness(db,{name:'Restricted teammate',businessName:'Other inventory',email:randomUUID()+'@example.test',password:staffPassword}),member='removed-'+randomUUID();
 await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Restricted teammate','staff',now())",[member,ctx.workspaceId,staff.accountId]);
 await db.query('UPDATE accounts SET last_workspace_id=$2 WHERE id=$1',[staff.accountId,ctx.workspaceId]);
 const oldSession=await browser.newPage();await oldSession.goto(base+'/login');await oldSession.getByLabel('Work email').fill(staff.email);await oldSession.locator('[name=password]').fill(staffPassword);await Promise.all([oldSession.waitForNavigation(),oldSession.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const oldCsrf=await oldSession.locator('[name=_csrf]').first().inputValue();
 const savedSource=await require('../../src/imports/postgres-source-uploads').enqueue(db,{...ctx,actorId:member},{filename:'queued-before-restriction.csv',buffer:Buffer.from('Name,SKU,Quantity\nMust stay a preview,REVOKED-IMPORT,0'),requestKey:'before-access-change'});
 const role=await team.saveRole(db,ctx,{name:'View only',permissions:['VIEW']});await team.assign(db,ctx,member,{revision:1,customRoleId:role.id,warehouseScope:'SELECTED',warehouseIds:[],approvalLimit:'0',currency:'USD'});
 const restricted=await oldSession.request.get(base+'/orders',{maxRedirects:0});assert.equal(restricted.status(),302);assert.equal(restricted.headers().location,'/warehouse/stock');
 const blockedPost=await oldSession.request.post(base+'/inventory/new',{form:{_csrf:oldCsrf,name:'Must not be saved'},maxRedirects:0});assert.equal(blockedPost.status(),403);
 await assert.rejects(f.workflows.createPurchaseOrder(db,{...ctx,actorId:member},{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'restricted-no-purchase',lines:[{skuId:f.item.skuIds[0],quantityUnits:1,unitCost:1}]}),/permission|warehouse/i);
 await db.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[f.owner.accountId]);
 await assert.rejects(require('../../src/operations/postgres-warehouse-access').assertInventoryWide(db,{...ctx,actorId:member}),/limited to assigned warehouses/);
 await assert.rejects(team.remove(db,{...ctx,actorId:member},ctx.actorId,{confirm:'remove',revision:1}),/Only an inventory owner/);
 await assert.rejects(team.remove(db,ctx,ctx.actorId,{confirm:'remove',revision:1}),/owner cannot be removed/);
 await assert.rejects(team.remove(db,ctx,member,{confirm:'remove',revision:1}),/access changed/);
 const seatsBefore=await require('../../src/commercial/entitlements').meterState(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId},'members');
 await page.goto(base+'/settings?section=team');await page.locator('.sc-remove-person summary').click();await page.locator('.sc-remove-person [name=confirm]').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Remove person',exact:true}).click()]);
 assert.equal(await auth.getMembership(db,ctx.workspaceId,staff.accountId),null);assert.equal(await auth.resolveForAccount(db,staff.accountId,ctx.workspaceId),null);assert(!(await auth.listWorkspacesForAccount(db,staff.accountId)).some(w=>w.id===ctx.workspaceId));
 const revokedPost=await oldSession.request.post(base+'/settings/workspace',{form:{_csrf:oldCsrf,name:'Must not rename another inventory'},maxRedirects:0});assert([403,409].includes(revokedPost.status())||revokedPost.status()===303&&revokedPost.headers().location==='/');
 assert.equal((await db.query('SELECT name FROM workspaces WHERE id=$1',[ctx.workspaceId])).rows[0].name,'Verified customer business');assert.equal((await db.query('SELECT name FROM workspaces WHERE id=$1',[staff.workspaceId])).rows[0].name,'Other inventory');
 assert.equal((await require('../../src/commercial/entitlements').meterState(db,{accountId:f.owner.accountId,workspaceId:ctx.workspaceId},'members')).used,seatsBefore.used-1);
 await assert.rejects(require('../../src/operations/postgres-warehouse-access').scope(db,{...ctx,actorId:member}),/membership could not be verified/);
 const queued=await require('../../src/operations/postgres-job-queue').processOne(db,{'import.analyse-source':require('../../src/operations/postgres-runtime-handlers').create({})['import.analyse-source']},{owner:'revoked-actor-test',kinds:['import.analyse-source']});assert.equal(queued.status,'DEAD');assert.equal((await db.query('SELECT plan_id FROM import_source_uploads WHERE id=$1',[savedSource.id])).rows[0].plan_id,null,'A job queued before revocation cannot finish with old permissions');
 assert((await db.query('SELECT revoked_at FROM users WHERE id=$1',[member])).rows[0].revoked_at,'History keeps the original actor');
 assert.equal((await team.remove(db,ctx,member,{confirm:'remove',revision:2})).removed,true);
 const lifecycle=require('../../src/domain/postgres-account-lifecycle'),invite=await lifecycle.createInvitation(db,ctx,{email:staff.email,name:'Restricted teammate',role:'accountant'},{origin:base,includeToken:true});
 await lifecycle.acceptInvitation(db,invite.token,{accountId:staff.accountId});const restored=await auth.getMembership(db,ctx.workspaceId,staff.accountId);assert.equal(restored.id,member);assert.equal(restored.role,'accountant');assert.equal(restored.permissions,null);assert.equal(restored.warehouse_location_ids,null);
 await lifecycle.createInvitation(db,ctx,{email:randomUUID()+'@example.test',role:'staff'},{origin:base});
 await team.remove(db,ctx,member,{confirm:'remove',revision:restored.access_revision});
 await lifecycle.createInvitation(db,ctx,{email:randomUUID()+'@example.test',role:'staff'},{origin:base});
 await assert.rejects(lifecycle.createInvitation(db,ctx,{email:staff.email,role:'staff'},{origin:base}),e=>e.code==='entitlement_required');
 assert.deepEqual(errors,[]);
 const policy=require('../../src/imports/plan-upload-policy');assert.throws(()=>policy.assertFile({filename:'large.pdf',buffer:Buffer.alloc(32*1048576+1)}),/32 MB/);assert.throws(()=>policy.assertFile({filename:'large.png',buffer:Buffer.alloc(20*1048576+1)}),/20 MB/);
 t.diagnostic(JSON.stringify({settingsTabs:32,plans:['starter','growth','pro'],phoneTabs:8,layoutAligned:true,serverRestrictions:true,removalRevokesAccess:true,queuedWorkRechecked:true,paidCalls:0}));
});
