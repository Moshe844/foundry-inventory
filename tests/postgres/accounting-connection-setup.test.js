'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');

test('accounting catalogue choices stay optional on all plans while real faults and user controls remain visible',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'accounting-setup-fixture-secret'});
 const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 const browser=await require('playwright').chromium.launch(),page=await browser.newPage({viewport:{width:1440,height:1000}});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 const before={},keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_STAGING_CONNECTION_PROVIDERS','STOCKCHIEF_STAGING_CONNECTION_WORKSPACES','XERO_CLIENT_ID','XERO_CLIENT_SECRET'];
 for(const key of keys)before[key]=process.env[key];
 t.after(()=>{for(const key of keys)if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];});
 let providerRequests=0;t.mock.method(global,'fetch',async()=>{providerRequests++;throw Error('Viewing accounting setup must not call a provider');});
 const base='http://127.0.0.1:'+server.address().port,email=randomUUID()+'@example.test';
 page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'/register');await page.getByLabel('Business name').fill('Accounting Setup Fixture');
 await page.getByLabel('Your name').fill('Setup Owner');await page.getByLabel('Work email').fill(email);
 const password='Setup!'+randomUUID();
 await page.locator('input[name="password"]').fill(password);if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill(password);
 const [registered]=await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname==='/register'),page.getByRole('button',{name:'Create account'}).click()]);
 if(registered.status()!==302)assert.fail('Fixture registration returned '+registered.status()+': '+(await registered.text()).replace(/<[^>]*>/g,' ').slice(-2500));
 await page.waitForURL(base+'/onboarding');
 await require('../helpers/postgres-model-fixture').fundAllWorkspaces(db);
 const owner=(await db.query('SELECT w.id AS workspace_id,w.owner_account_id AS account_id,u.id AS actor_id FROM workspaces w JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=w.owner_account_id WHERE a.email=$1',[email])).rows[0];
 Object.assign(process.env,{STOCKCHIEF_RUNTIME_ENV:'staging',STOCKCHIEF_STAGING_CONNECTION_PROVIDERS:'xero',XERO_CLIENT_ID:'setup-fixture',XERO_CLIENT_SECRET:'setup-fixture-secret'});
 process.env.STOCKCHIEF_STAGING_CONNECTION_WORKSPACES=owner.workspace_id;
 const id='con_'+randomUUID().replaceAll('-',''),ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id,accountId:owner.account_id};
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,setup_status,capabilities,provides,config,
   provider_account_id,provider_account_name,authorized_by_user_id,expected_interval_minutes,created_at,updated_at,first_connected_at,last_synced_at)
   VALUES($1,$2,$1,'Xero','xero','connected','CONNECTED','["accounting:read","accounting:shadow"]','[]','{}','fixture-company','Demo Books Fixture',$3,60,now(),now(),now(),now())`,[id,owner.workspace_id,owner.actor_id]);
 const service=require('../../src/connections/postgres-service'),connection=await service.get(db,owner.workspace_id,id);
 await require('../../src/accounting/postgres-integration-sync').initialize(db,connection,owner.actor_id,{label:'Xero company',value:'Demo Books Fixture',externalId:'fixture-company'});
 const records=[{entityType:'location',externalId:'fixture-place',displayName:'Demo Books inventory',providerData:{}}];
 for(let index=1;index<=11;index++)records.push({entityType:'sku',externalId:'fixture-product-'+index,code:'DEMO-'+index,displayName:'Sample product '+index,
  providerData:{itemName:'Sample product '+index,variationName:'',priceMoney:{amount:2500,currency:'USD'},inventoryCounts:[]}});
 await db.transaction(c=>require('../../src/connections/postgres-catalog-cache').cacheRecords(c,connection,records),{isolation:'SERIALIZABLE',retrySafe:true});
 await db.query("INSERT INTO connection_sync_runs(id,workspace_id,connector_id,sync_kind,status,started_at,completed_at) VALUES($1,$2,$3,'CATALOG_AND_LOCATIONS','COMPLETED',$4,$4)",[randomUUID(),owner.workspace_id,id,new Date().toISOString()]);
 const counts=async()=>({products:(await db.query('SELECT count(*)::int n FROM skus WHERE workspace_id=$1',[owner.workspace_id])).rows[0].n,
  mappings:(await db.query('SELECT count(*)::int n FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2',[owner.workspace_id,id])).rows[0].n,
  issues:(await db.query("SELECT count(*)::int n FROM connection_issues WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN'",[owner.workspace_id,id])).rows[0].n});
 const initial=await counts();assert.equal(initial.issues,12);
 const output=path.join(process.cwd(),'output','accounting-connection-setup');fs.mkdirSync(output,{recursive:true});
 for(const plan of ['starter','growth','pro']){
  await db.query("UPDATE account_subscriptions SET plan_id=$2,plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id=$2 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1) WHERE account_id=$1",[owner.account_id,plan]);
  const subscription=(await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.account_id])).rows;
  const saved=await service.get(db,owner.workspace_id,id);
  assert.equal(saved.publicStatus,'Connected');assert.equal(saved.catalogueSetupIssues,12);assert.equal(saved.actionableIssues,0);
  assert.equal(saved.unmatchedProducts,11);assert.equal(saved.unmatchedLocations,1);
  for(const [name,width,height]of [['desktop',1440,1000],['mobile',390,844]]){
   await page.setViewportSize({width,height});await page.goto(base+'/settings/connections/'+id);
   await page.locator('.cx-status').waitFor();assert.equal(await page.locator('.cx-status').innerText(),'Connected');
   const text=await page.locator('main').innerText();assert.match(text,/Read-only access is ready/);assert.match(text,/11 products and 1 location/);
   assert.doesNotMatch(text,/12 problems|12 open|AUTHORITY REQUIRED|READ ONLY VERIFIED|UNKNOWN_SKU|UNKNOWN_LOCATION|This connection needs attention/);
   assert.equal(await page.locator('#catalogue-review').getAttribute('open'),null);assert.equal(await page.locator('#accounting-options').getAttribute('open'),null);
   assert.equal(await page.locator('#connection-issues').count(),0);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'Accounting setup must fit '+name);
   await page.screenshot({path:path.join(output,plan+'-'+name+'.png'),fullPage:true});
  }
  await page.getByRole('link',{name:'Review products and locations',exact:true}).click();
  assert.notEqual(await page.locator('#catalogue-review').getAttribute('open'),null);
  await page.getByRole('button',{name:'Import selected products',exact:true}).waitFor();
  assert.equal(await page.locator('[data-external-product]').count(),11);
  await page.getByLabel('Find provider record').fill('DEMO-2');await page.getByRole('button',{name:'Search catalogue and matches'}).click();
  assert.notEqual(await page.locator('#catalogue-review').getAttribute('open'),null);assert(await page.locator('[data-external-product]').count()>0);
  await page.goto(base+'/settings/connections/'+id);await page.getByRole('link',{name:'Change accounting access'}).click();
  assert.notEqual(await page.locator('#accounting-options').getAttribute('open'),null);
  assert.equal(await page.locator('input[name="authority"][value="OBSERVE"]').isChecked(),true);
  assert.deepEqual(await counts(),initial,'Viewing setup does not import products, create matches or clear issues');
  assert.deepEqual((await db.query('SELECT to_jsonb(s) state FROM account_subscriptions s WHERE account_id=$1',[owner.account_id])).rows,subscription);
 }
 const setupIssue=(await db.query("SELECT id FROM connection_issues WHERE workspace_id=$1 AND connector_id=$2 AND issue_type='UNKNOWN_SKU' LIMIT 1",[owner.workspace_id,id])).rows[0].id;
 await page.goto(base+'/settings/connections/'+id+'?issue='+setupIssue);
 assert.match(page.url(),/reviewProducts=1#catalogue-review$/);assert.notEqual(await page.locator('#catalogue-review').getAttribute('open'),null);
 const fault=randomUUID();await db.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,detail,resolution_hint,candidate_matches,status,created_at,updated_at)
  VALUES($1,$2,$3,'UNKNOWN_SKU',$4,'An imported document needs a product match','A real document cannot continue yet.','Review the affected document.','[]','OPEN',now(),now())`,[fault,owner.workspace_id,id,'document-line:'+randomUUID()]);
 const broken=await service.get(db,owner.workspace_id,id);assert.equal(broken.publicStatus,'Needs attention');assert.equal(broken.actionableIssues,1);
 await page.goto(base+'/settings/connections/'+id);assert.equal(await page.locator('.cx-status').innerText(),'Error');
 assert.match(await page.locator('#connection-issues').innerText(),/An imported document needs a product match/);
 assert.doesNotMatch(await page.locator('#connection-issues').innerText(),/Sample product/);
 await db.query("UPDATE connection_issues SET status='RESOLVED' WHERE id=$1",[fault]);
 await db.query("UPDATE workspace_connectors SET setup_status='REAUTHORIZATION_REQUIRED' WHERE id=$1",[id]);
 await page.goto(base+'/settings/connections/'+id);assert.equal(await page.locator('.cx-status').innerText(),'Error');
 assert.match(await page.locator('main').innerText(),/Sign in again to restore access/);
 assert.equal(providerRequests,0);assert.deepEqual(errors,[]);
});
