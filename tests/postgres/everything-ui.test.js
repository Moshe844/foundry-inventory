'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('real Chromium opens every Everything else destination without migration substitute redirects',
  {timeout:240000},async(context)=>{
    const anthropicApiKey=process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-everything-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-everything-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{if(anthropicApiKey===undefined)delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY=anthropicApiKey;
      await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Everything Certification');
    await page.getByLabel('Your name').fill('Everything Owner');await page.getByLabel('Work email').fill('everything@example.test');
    await page.getByLabel('Password').fill('everything-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/everything`);
    const destinations=await page.locator('.rm-vault__links a').evaluateAll((links)=>links.map((link)=>({
      label:link.textContent.trim(),href:link.getAttribute('href'),
    })));
    assert.ok(destinations.length>=30,`Only ${destinations.length} destinations were exposed.`);
    for(const destination of destinations){
      if(destination.label==='Export everything'){
        const exportResponse=await page.request.get(`${base}${destination.href}`);
        assert.equal(exportResponse.status(),200);
        assert.match(exportResponse.headers()['content-disposition']||'',/attachment/i);
        continue;
      }
      const response=await page.goto(`${base}${destination.href}`);
      assert.ok(response&&response.status()<400,`${destination.label} returned ${response?.status()} at ${page.url()}`);
      const text=await page.locator('#main').innerText();
      assert.ok(text.trim().length>0,`${destination.label} rendered an empty main surface at ${page.url()}`);
      if(destination.label==='Changes prepared for approval')assert.match(page.url(),/\/actions(?:\?|$)/);
      if(destination.label==='How this inventory is configured')assert.match(page.url(),/\/what-you-told-me(?:\?|$)/);
    }
    await page.goto(`${base}/ask`);
    const askText=await page.locator('#main').innerText();
    assert.match(askText,/Grounded questions and deterministic workflows still work without one/);
    assert.doesNotMatch(askText,/needs its model connection before it can read a sentence/);
    assert.deepEqual(errors,[]);
  });
