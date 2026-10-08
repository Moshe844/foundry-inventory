'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {fixture}=require('../helpers/postgres-model-fixture');

test('Home opens Ask immediately and shows the question there while the backend works',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-home-ask-handoff'});
    await migratePostgres(database);
    let releaseModel;
    const modelGate=new Promise((resolve)=>{releaseModel=resolve;});
    const aiProvider=fixture({name:'handoff-fixture',model:'fixture',async complete(){
      await modelGate;
      return {data:{intent:'lookup',view:'inventory_summary',search:null},usage:{}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'home-ask-handoff-secret',aiProvider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{releaseModel();await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Handoff Business');
    await page.getByLabel('Your name').fill('Handoff Owner');
    await page.getByLabel('Work email').fill('handoff-owner@example.test');
    await page.getByLabel('Password').fill('handoff-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(base);
    await page.getByRole('textbox',{name:'Ask StockChief'}).fill('How many products do we have?');
    await page.getByRole('button',{name:'Continue'}).click();
    await page.waitForURL(`${base}/ask`);
    assert.equal(new URL(page.url()).pathname,'/ask');
    await page.getByText('Reading your records…').waitFor({timeout:2500});
    assert.match(await page.locator('main').innerText(),/How many products do we have\?/);
    releaseModel();
    await page.waitForURL(`${base}/ask?latest=1#latest`);
    await page.getByText(/No products have ever been recorded in StockChief; you have 0 units on hand/).waitFor();
    assert.match(await page.locator('main').innerText(),/No products have ever been recorded in StockChief; you have 0 units on hand/);
    assert.equal(await page.locator('.rm-composer__attach').count(),0);
  });

test('Home Ask follows the server-selected destination for a navigation request',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-home-navigation'});
    await migratePostgres(database);
    const aiProvider=fixture({name:'navigation-fixture',model:'fixture',async complete(){
      return {data:{navigate:'suppliers'},usage:{}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'home-navigation-secret',aiProvider});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Navigation Business');
    await page.getByLabel('Your name').fill('Navigation Owner');
    await page.getByLabel('Work email').fill('navigation-owner@example.test');
    await page.getByLabel('Password').fill('navigation-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(base);
    await page.getByRole('textbox',{name:'Ask StockChief'}).fill('Could you open the supplier directory for me?');
    await page.getByRole('button',{name:'Continue'}).click();
    await page.waitForURL(`${base}/suppliers`);
    assert.equal(new URL(page.url()).pathname,'/suppliers');
    await page.goto(`${base}/ask`);
    assert.match(await page.locator('main').innerText(),/Could you open the supplier directory for me\?/);
    assert.match(await page.locator('main').innerText(),/Opening Suppliers\./);
  });
