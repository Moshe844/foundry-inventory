'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('Phone approval prepares only committed units, physical scanning and packing stay separate, and Pro learns after handoff',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-partial-shipment-fixture').fixture(t),{db,ctx}=f,p=await f.prepare(f.target);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;
 page.setDefaultTimeout(12000);await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await f.subscribe('growth');await page.goto(origin+'/actions/'+p.proposal.id);assert.equal(await page.getByRole('button',{name:'Approve only this change',exact:true}).isEnabled(),false);assert.match(await page.locator('main').innerText(),/Pro/);
 await f.subscribe('pro');await page.reload();const review=await page.getByRole('region',{name:'Proposed changes'}).innerText();
 assert.match(review,/Units ready for picking\s+4/);assert.match(review,/Units still waiting\s+2/);assert.match(review,/\$72.00/);assert.doesNotMatch(review,/Fingerprint|Expected version|[a-f0-9]{64}/i);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve only this change',exact:true}).click()]);
 assert.equal(await f.balance(),5);assert.equal(await page.getByRole('button',{name:'Save pick release rule',exact:true}).count(),0);assert.match(await page.locator('main').innerText(),/physical shipment|physically|handoff/i);
 const stored=await f.assistant.getProposal(db,ctx.workspaceId,p.proposal.id),waveId=stored.result.waveId;
 const line=(await db.query('SELECT l.*,s.code,loc.name location_name FROM fulfillment_wave_lines l JOIN skus s ON s.workspace_id=l.workspace_id AND s.id=l.sku_id JOIN locations loc ON loc.workspace_id=l.workspace_id AND loc.id=l.location_id WHERE l.wave_id=$1',[waveId])).rows[0];
 await page.goto(origin+'/warehouse/waves/'+waveId);await page.getByLabel('Location scan',{exact:true}).fill(line.location_name);await page.getByLabel('Product scan',{exact:true}).fill(line.code);await page.getByLabel('Quantity',{exact:true}).fill('4');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Verify pick',exact:true}).click()]);assert.equal(await f.balance(),5);
 await f.shipping.setPackages(db,ctx,line.shipment_id,[{weightGrams:500,lengthMm:200,widthMm:150,heightMm:100}]);await page.getByLabel('Measured weight in grams').fill('500');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Pack',exact:true}).click()]);assert.equal(await f.balance(),5);
 await f.shipping.handoff(db,ctx,line.shipment_id,{idempotencyKey:randomUUID(),handover:'DELIVERED_BY_US'});assert.equal(await f.balance(),1);
 await page.goto(origin+'/actions/'+p.proposal.id);assert.match(await page.locator('main').innerText(),/Teach partial shipment preparation/);
 await page.locator('[name=draftMaximum]').fill('72.00');await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Test on past reviewed releases',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/1 of 1 completed matching/);
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save pick release rule',exact:true}).click()]);assert.equal(await page.getByRole('button',{name:'Remove routine',exact:true}).count(),1);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/partial-shipment-mobile.png',fullPage:true});
});
