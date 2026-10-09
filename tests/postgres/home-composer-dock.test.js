'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');

test('Home Ask stays in document flow without covering later sections on desktop and mobile',
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
        heroBottom:document.querySelector('.sc-home__hero').getBoundingClientRect().bottom,
        nextTop:element.nextElementSibling.getBoundingClientRect().top,
        documentWidth:document.documentElement.scrollWidth,viewportWidth:innerWidth}));
      await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
      const after=await page.locator('.sc-home__ask').evaluate((element)=>({
        top:element.getBoundingClientRect().top,bottom:element.getBoundingClientRect().bottom,
        scrollY:scrollY}));
      context.diagnostic(JSON.stringify({width,before,after}));
      assert.notEqual(before.position,'fixed');
      assert.ok(before.top>=before.heroBottom-1,'the composer must follow the Home introduction');
      assert.ok(before.bottom<=before.nextTop+1,'the composer must not cover the next Home section');
      assert.ok(after.top<before.top-20,'the composer must scroll away with the document');
      assert.ok(before.documentWidth<=before.viewportWidth+1,'the composer must not create horizontal scrolling');
      assert.ok(after.scrollY>0,'the page should actually scroll in the test');
      context.diagnostic(`${width}px viewport: composer moved with scroll ${Math.round(after.scrollY)}px`);
      await page.evaluate(()=>window.scrollTo(0,0));
    }
  });
