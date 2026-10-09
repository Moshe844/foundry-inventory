'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {newId,nowIso}=require('../../src/lib/util');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');

test('Connections browser shows launch-qualified providers and retains excluded connection history honestly',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-connections-catalog-browser'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'connections-catalog-browser-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Visible Connections');
    await page.getByLabel('Your name').fill('Connection Owner');
    await page.getByLabel('Work email').fill('visible-connections@example.test');
    await page.locator('input[name="password"]').fill('connections-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('connections-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Visible Connections'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    const place=await locations.createLocation(database,ctx,{name:'Main Store',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Blue Mug',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:8,
      reference:'OPENING',idempotencyKey:'visible-connections-opening'});
    await page.goto(base);
    assert.match(await page.locator('.sc-home__inventory-line').innerText(),
      /1 product · 8 units on hand · 8 available for orders/);
    await page.getByRole('button',{name:'More'}).click();
    const directory=page.getByRole('navigation',{name:'More destinations'});
    await directory.getByRole('heading',{name:'Connections'}).waitFor();
    assert.equal(await directory.getByRole('link',{name:'All connections'}).getAttribute('href'),'/settings/connections');
    await page.getByRole('button',{name:'Visible Connections'}).click();
    assert.equal(await directory.isVisible(),false);
    const switcher=page.locator('#rail-inventory-menu');
    assert.equal(await switcher.isVisible(),true);
    assert.equal(await switcher.getByRole('link',{name:'All inventories'}).count(),1);
    assert.equal(await switcher.getByRole('link',{name:'Everything else'}).count(),0);
    const menuBox=await switcher.boundingBox();const railBox=await page.locator('.rm-rail').boundingBox();
    assert.ok(menuBox.x>=railBox.x+railBox.width-4 && menuBox.x+menuBox.width<=1281,
      JSON.stringify({menuBox,railBox}));
    await page.getByRole('button',{name:'More'}).click();
    assert.equal(await switcher.isVisible(),false);
    await page.keyboard.press('Escape');
    assert.equal(await directory.isVisible(),false);
    const id=newId('con');const at=nowIso();
    await database.query(`INSERT INTO workspace_connectors
      (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
       expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
      VALUES($1,$2,$3,'Former Shop','shopify','disconnected','[]','[]','{}',60,'DISCONNECTED',$4,$5,$5)`,
    [id,owner.workspace_id,`shopify:${id}`,owner.actor_id,at]);
    await page.goto(`${base}/settings/connections`);
    const text=await page.locator('main').innerText();
    for(const provider of ['Square','WooCommerce','Gmail','Stripe'])assert.match(text,new RegExp(provider));
    for(const provider of ['QuickBooks','Xero','Clover','Microsoft 365'])
      assert.doesNotMatch(text,new RegExp(provider));
    assert.doesNotMatch(text,/Connect Shopify/);
    assert.match(text,/disconnected or incomplete connection/);
    await page.getByText(/disconnected or incomplete connection/).click();
    assert.match(await page.locator('main').innerText(),/Former Shop/);
    assert.match(await page.locator('main').innerText(),/history retained/);
    assert.equal(await page.getByRole('link',{name:'View record'}).count(),1);
    await page.setViewportSize({width:390,height:844});
    await page.goto(base);
    await page.getByRole('button',{name:'More'}).click();
    const mobilePanel=await page.locator('#rail-more-panel').boundingBox();
    assert.ok(mobilePanel.x>=0 && mobilePanel.x+mobilePanel.width<=391);
    assert.ok(mobilePanel.y>=0 && mobilePanel.y+mobilePanel.height<=845);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Visible Connections'}).click();
    const mobileSwitcher=await page.locator('#rail-inventory-menu').boundingBox();
    assert.ok(mobileSwitcher.x>=0 && mobileSwitcher.x+mobileSwitcher.width<=391,
      JSON.stringify(mobileSwitcher));
    await page.setViewportSize({width:800,height:900});
    await page.goto(base);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
  });
