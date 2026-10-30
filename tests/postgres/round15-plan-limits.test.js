'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster'),{openPostgres}=require('../../src/db/postgres'),{migratePostgres}=require('../../src/db/migrate-postgres');
const auth=require('../../src/domain/postgres-auth-service'),invites=require('../../src/domain/postgres-account-lifecycle'),ent=require('../../src/commercial/entitlements'),locations=require('../../src/domain/postgres-location-service');
test('Starter reserves pending seats, paid inventories have their own locations and UI shows plan locks',{timeout:180000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString,{max:5});t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const owner=await auth.createBusiness(db,{name:'Owner',businessName:'Round 15',email:'round15@example.test',password:'Round15-password!'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},scope={accountId:owner.accountId,workspaceId:owner.workspaceId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) SELECT 'round15-sub',$1,'starter',id,'ACTIVE' FROM commercial_plan_versions WHERE plan_id='starter' AND status='ACTIVE'",[owner.accountId]);
 assert.equal((await ent.meterState(db,scope,'members')).hardLimit,3);
 const options={origin:'https://stockchief.example.test',includeToken:true};
 const first=await invites.createInvitation(db,ctx,{email:'one@example.test',name:'One'},options);
 const second=await invites.createInvitation(db,ctx,{email:'two@example.test',name:'Two'},options);
 assert.equal((await ent.meterState(db,scope,'members')).used,3);
 await assert.rejects(invites.createInvitation(db,ctx,{email:'four@example.test'},options),e=>e.code==='entitlement_required');
 const resent=await invites.createInvitation(db,ctx,{email:'one@example.test',name:'One'},options);
 await assert.rejects(invites.acceptInvitation(db,first.token,{password:'Invited-password!'}),/invalid|expired/);
 await invites.acceptInvitation(db,resent.token,{password:'Invited-password!'});
 assert.equal((await ent.meterState(db,scope,'members')).used,3,'accepting a reserved invite must not consume another seat');
 const reports=require('../../src/reports/postgres-service'),reportActor={role:'owner',email:owner.email};for(let i=0;i<3;i++)await reports.save(db,ctx,reportActor,{dataset:'catalogue',title:'Scheduled '+i,columns:['sku','product']},{schedule:{frequency:'daily',hour:8,timeZone:'UTC'}});await assert.rejects(reports.save(db,ctx,reportActor,{dataset:'catalogue',title:'Fourth',columns:['sku','product']},{schedule:{frequency:'daily',hour:8,timeZone:'UTC'}}),/plan limit/);
 await assert.rejects(auth.createWorkspace(db,owner.accountId,{name:'Blocked'}),/plan limit/);
 await locations.createLocation(db,ctx,{name:'First',kind:'warehouse'});await locations.createLocation(db,ctx,{name:'Second',kind:'warehouse'});
 await assert.rejects(locations.createLocation(db,ctx,{name:'Third',kind:'warehouse'}),/plan limit/);
 await db.query("INSERT INTO commercial_capacity_orders(id,account_id,product_id,quantity,units,amount_minor,currency,price_id,stripe_customer_id,status,paid_through,request_key) VALUES('extra',$1,'extra-inventory',1,1,9900,'USD','price_test','cus_test','ACTIVE',now()+interval '1 month','extra')",[owner.accountId]);
 const added=await auth.createWorkspace(db,owner.accountId,{name:'Paid extra'}),extraScope={accountId:owner.accountId,workspaceId:added.workspaceId};
 const extraContext={workspaceId:added.workspaceId,actorId:added.userId},extraLocation=await locations.createLocation(db,extraContext,{name:'Extra warehouse',kind:'warehouse'});
 const extraItem=await require('../../src/domain/postgres-catalog-service').createItem(db,extraContext,{name:'Extra inventory stock',trackingMode:'quantity',purchaseCost:'5',startingQuantity:4,startingLocationId:extraLocation.id});
 assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2',[added.workspaceId,extraItem.skuIds[0]])).rows[0].on_hand),4,'a paid additional inventory can receive stock immediately');
 assert.equal((await ent.meterState(db,extraScope,'locations')).used,1);assert.equal((await ent.meterState(db,scope,'locations')).used,2);assert.equal((await ent.meterState(db,{accountId:owner.accountId},'locations')).used,2,'account downgrade checks use the highest per-inventory count');
 assert.equal((await ent.meterState(db,scope,'members')).used,3,'owner in two inventories consumes one seat');
 await assert.rejects(ent.assertCapability(db,scope,'api.public'),/Pro/);
 const {createPostgresApp}=require('../../src/postgres-app');const app=createPostgresApp({database:db,env:'test',sessionSecret:'round15-browser-long',commercialOptions:{loadInvoices:false}}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch();
 t.after(async()=>{await browser.close();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 await db.query('UPDATE accounts SET last_workspace_id=$2 WHERE id=$1',[owner.accountId,owner.workspaceId]);
 const page=await browser.newPage(),base='http://127.0.0.1:'+server.address().port;await page.goto(base+'/login');await page.getByLabel('Email').fill(owner.email);await page.locator('input[name=password]').fill('Round15-password!');await Promise.all([page.waitForURL(base+'/'),page.getByRole('button',{name:'Sign in'}).click()]);
 await page.goto(base+'/inventories/new');assert.equal(await page.locator('.card').getByRole('link',{name:'Upgrade',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Choose a source',exact:true}).isEnabled(),false);
 await page.goto(base+'/locations');const csrf=await page.locator('[name=_csrf]').first().inputValue();
 for(const [path,ref,form] of [['/locations','/locations',{name:'Blocked third',kind:'warehouse'}],['/reports/save','/reports/builder',{dataset:'catalogue',title:'Blocked fourth',columns:'sku',frequency:'daily',hour:'8',timeZone:'UTC'}],['/settings/people','/settings?section=team',{name:'Blocked fourth',email:'blocked@example.test',role:'staff'}]]){const response=await page.context().request.post(base+path,{form:{_csrf:csrf,...form},headers:{referer:base+ref}});assert.equal(response.status(),200,path);const html=await response.text(),flash=html.slice(html.indexOf('data-flash-stack'),html.indexOf('data-flash-stack')+1600);assert.ok(flash.includes('href="/upgrade"')&&flash.includes('Upgrade'),path+': '+flash);}
 await page.goto(base+'/settings?section=team');assert.match(await page.locator('main').innerText(),/People limit reached|Pending invitation/);assert.equal(await page.getByRole('button',{name:'Resend',exact:true}).count(),1);assert.equal(await page.locator('#people').getByRole('link',{name:'Upgrade',exact:true}).count(),1);
 await page.locator('#people').getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForURL(base+'/settings?section=team');assert.equal((await ent.meterState(db,scope,'members')).used,2);
 for(const [url,key] of [['/settings/connections?section=developers','api.public'],['/autopilot','authority.advanced'],['/warehouse/operations','warehouse.advanced']]){const response=await page.goto(base+url);assert.equal(response.status(),200,url);assert.ok(await page.locator('[data-plan-lock="'+key+'"]').count(),url);}
 const plans=await require('../../src/commercial/service').listPlans(db),offer=require('../../src/commercial/public-offer');for(const plan of plans){await db.query("UPDATE account_subscriptions SET plan_id=$1,plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id=$1 AND status='ACTIVE') WHERE account_id=$2",[plan.id,owner.accountId]);for(const feature of offer.describe(plan).features)assert.equal((await ent.capabilityState(db,scope,feature.capability)).enabled,true,plan.id+':'+feature.capability);for(const allowance of offer.describe(plan).allowances)assert.equal((await ent.meterState(db,scope,allowance.meter)).hardLimit,allowance.meter==='workspaces'&&allowance.units!==null?Number(allowance.units)+1:allowance.units===null?null:Number(allowance.units),plan.id+':'+allowance.meter);}
 await page.goto(base+'/pricing');assert.match(await page.locator('body').innerText(),/Locations per inventory/);assert.match(await page.locator('body').innerText(),/card payment connections require Custom/);
});
