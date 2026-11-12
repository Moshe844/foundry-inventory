'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('delivery QC rule, suggested hold, inspection, write-off and teaching work on a phone and a desktop with visible plan locks', {timeout:300000},async t=>{
 const f=await require('../helpers/agent-quality-fixture').fixture(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;page.setDefaultTimeout(12000);
 const fits=async()=>assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal scroll at '+page.viewportSize().width+' px');
 const main=()=>page.locator('main').innerText();
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await f.subscribe('starter');assert.equal((await page.goto(origin+'/autopilot/delivery-quality')).status(),200);assert.equal(await page.getByRole('button',{name:'Save QC rule',exact:true}).count(),0);assert.equal(await page.locator('main').getByRole('link',{name:'Upgrade',exact:true}).count(),1);await fits();
 // Growth: a supplier-wide rule that suggests each hold.
 await f.subscribe('growth');await page.reload();
 await page.getByLabel('Supplier name (leave empty for any supplier)',{exact:true}).fill('Fixture parts');
 await page.getByLabel('Physical checks, one per line (up to ten)',{exact:true}).fill(f.scope.checklist.join('\n'));await page.getByLabel('Most units of one product per delivery it may hold on its own',{exact:true}).fill('10');
 await page.locator('form[action="/autopilot/delivery-quality-rules"] [name=confirmed]').check();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save QC rule',exact:true}).click()]);assert.match(await main(),/Fixture parts · any product · any owned location/);assert.match(await main(),/Suggests a hold for each matching delivery/);
 // Receiving without ticking the hold leaves the decision to the owner.
 const po=await f.order();await page.goto(origin+'/purchasing/orders/'+po.purchaseOrderId+'/receive');assert.equal(await page.locator('[name=qcConfirmed]').count(),1);await fits();
 await page.locator('[name="qty_'+po.lineIds[0]+'"]').fill('10');await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Receive this delivery',exact:true}).last().click()]);
 assert.equal(await f.balance(),18);assert.equal((await f.available()).available,18);
 const hold=(await db.query('SELECT id FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 await page.goto(origin+'/autopilot/delivery-quality/'+hold.id);assert.match(await main(),/Suggested hold/);assert(!(await main()).includes(hold.id));await fits();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Hold for inspection',exact:true}).click()]);assert.equal((await f.available()).available,8);
 // Two units fail; the owner writes them off and the rest pass.
 await page.locator('[name=decision]').selectOption('FAIL');await page.locator('[name=note]').fill('Two cartons crushed');await page.locator('[name=damagedQuantity]').fill('2');await page.locator('[name=physicallyChecked]').check();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record physical inspection',exact:true}).click()]);assert.match(await main(),/Inspection failed/);await fits();
 const writeOff=page.locator('form[action$="/write-off"]');await writeOff.locator('[name=quantity]').fill('2');await writeOff.locator('[name=note]').fill('Crushed cartons');await writeOff.locator('[name=confirmed]').check();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Write off failed goods',exact:true}).click()]);assert.equal(await f.balance(),16);assert.equal((await f.available()).available,8);assert.match(await main(),/2 units written off/);
 for(const index of ['0','1'])await page.locator('[name=checks][value="'+index+'"]').check();await page.locator('[name=decision]').selectOption('PASS');await page.locator('[name=physicallyChecked]').check();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record physical inspection',exact:true}).click()]);assert.equal((await f.available()).available,16);assert.match(await main(),/Released by the person who recorded the pass/);
 // Teach the rule from that completed delivery.
 await page.goto(origin+'/autopilot/delivery-quality');await page.locator('[name=exampleId]').selectOption(hold.id);await page.locator('form[action$="/settings"] [name=confirmed]').check();
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Teach it to hold on its own',exact:true}).click()]);assert.match(await main(),/Holds matching deliveries on its own/);await fits();
 require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/delivery-quality-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:900});await page.goto(origin+'/autopilot/delivery-quality/'+hold.id);await fits();assert.match(await main(),/Write-offs/);await page.screenshot({path:'output/delivery-quality-desktop.png',fullPage:true});
});
