'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{chromium}=require('playwright');
// Job 36 on a phone and a desktop: choose a key supplier, prepare this week's
// forecast, read it and send it; the plan lock on Starter.
test('supplier forecasts work on a phone and a desktop: key supplier, this week’s forecast, send and stop',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f,ws=ctx.workspaceId;await f.subscribe('growth');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const connector=randomUUID(),at=new Date().toISOString();await db.query("UPDATE suppliers SET email='planner@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ws]);
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,created_at,updated_at) VALUES($1,$2,'fixture-supplier',$3,$4,$4) ON CONFLICT(workspace_id,supplier_id,sku_id) DO UPDATE SET is_active=1`,[randomUUID(),ws,f.item.skuIds[0],at]);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Planning mailbox','gmail','[]','{}','connected','["MAIL_SEND"]','CONNECTED',$3,'planner-mailbox',now(),now())`,[connector,ws,ctx.actorId]);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port,login=async page=>{page.setDefaultTimeout(12000);await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);};
 const fits=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),text=page=>page.locator('main').innerText();
 const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});await login(phone);
 await phone.goto(origin+'/autopilot/reviews/supplier-forecasts');await phone.getByRole('link',{name:'Open',exact:true}).click();assert.equal(new URL(phone.url()).pathname,'/autopilot/supplier-forecasts');
 assert.match(await text(phone),/Choose a key supplier below to start/);assert.match(await text(phone),/Forecasts are sent from Planning mailbox/);
 await phone.getByLabel('Add a key supplier').selectOption('fixture-supplier');await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Add key supplier',exact:true}).click()]);
 assert.match(await text(phone),/Key supplier added/);assert(await phone.getByRole('button',{name:'Stop weekly forecasts to Fixture parts'}).isVisible());
 await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Prepare this week’s forecasts now',exact:true}).click()]);
 assert.match(await text(phone),/Ready to send/);assert.match(await text(phone),/first forecast to planner@example.test/);assert(await fits(phone));
 await Promise.all([phone.waitForNavigation(),phone.locator('#this-week').getByRole('link',{name:'Open',exact:true}).click()]);
 assert.match(await text(phone),/Fixture parts · week of/);assert.match(await text(phone),/Not enough sales history yet/);assert(await fits(phone));
 await phone.getByText('Read the exact email').click();assert.match(await text(phone),/This is for planning only/);
 await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Send this forecast',exact:true}).click()]);
 assert.match(await text(phone),/Forecast sent to planner@example.test/);assert.match(await text(phone),/Sending/);
 const folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await phone.screenshot({path:require('node:path').join(folder,'supplier-forecast-phone.png'),fullPage:true});
 const desk=await browser.newPage({viewport:{width:1600,height:1000}});await login(desk);await desk.goto(origin+'/autopilot/supplier-forecasts');
 assert.match(await text(desk),/Sending/);assert(await fits(desk));await desk.screenshot({path:require('node:path').join(folder,'supplier-forecast-desktop.png'),fullPage:true});
 await Promise.all([desk.waitForNavigation(),desk.getByRole('button',{name:'Stop weekly forecasts to Fixture parts'}).click()]);assert.match(await text(desk),/Weekly forecasts to this supplier are stopped/);assert.match(await text(desk),/No key suppliers yet/);
 // Starter keeps the plan lock.
 await f.subscribe('starter');const locked=await desk.goto(origin+'/autopilot/supplier-forecasts');assert.equal(locked.status(),402);assert.equal(await desk.getByRole('button',{name:'Add key supplier'}).count(),0);
});
