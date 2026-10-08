'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('Home Ask stays fixed at the bottom while scrolling on desktop and mobile',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-home-dock'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'home-dock-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Dock Business');
    await page.getByLabel('Your name').fill('Dock Owner');
    await page.getByLabel('Work email').fill('dock@example.test');
    await page.getByLabel('Password').fill('dock-test-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(base);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      const before=await page.locator('.sc-home__ask').evaluate((element)=>({
        position:getComputedStyle(element).position,top:element.getBoundingClientRect().top,
        bottom:element.getBoundingClientRect().bottom,viewport:innerHeight,
        documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}));
      await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
      const after=await page.locator('.sc-home__ask').evaluate((element)=>({
        top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,
        scrollY:scrollY}));
      context.diagnostic(JSON.stringify({width,before,after}));
      assert.equal(before.position,'fixed');
      assert.ok(Math.abs(before.bottom-after.bottom)<2,'the composer must not move with the document');
      assert.ok(before.viewport-before.bottom<=20,'the composer must stay near the viewport bottom');
      assert.ok(before.documentWidth<=before.viewportWidth+1,'the dock must not create horizontal scrolling');
      assert.ok(after.scrollY>0,'the page should actually scroll in the test');
      context.diagnostic(`${width}px viewport: dock bottom ${Math.round(after.bottom)}px, scroll ${Math.round(after.scrollY)}px`);
      await page.evaluate(()=>window.scrollTo(0,0));
    }
  });
