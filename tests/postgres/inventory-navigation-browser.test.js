'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const workflows=require('../../src/operations/postgres-business-workflows');

test('inventory summary links reach understandable, working destinations in a real browser',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-inventory-navigation-browser'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'inventory-navigation-browser-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage({viewport:{width:1365,height:900}});
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Navigation Workshop');
    await page.getByLabel('Your name').fill('Workshop Owner');
    await page.getByLabel('Work email').fill('navigation-workshop@example.test');
    await page.locator('input[name="password"]').fill('navigation-test-password');
    if(await page.locator('input[name="confirmPassword"]').count())
      await page.locator('input[name="confirmPassword"]').fill('navigation-test-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Navigation Workshop'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const place=await locations.createLocation(database,ctx,{name:'Main Workshop',kind:'warehouse'});
    const available=await catalog.createItem(database,ctx,{name:'Ready Clamp',trackingMode:'quantity'});
    const empty=await catalog.createItem(database,ctx,{name:'Unstocked Hinge',trackingMode:'quantity'});
    const incoming=await catalog.createItem(database,ctx,{name:'Ordered Bracket',trackingMode:'quantity'});
    const variant=await catalog.createItem(database,ctx,{name:'Sized Glove',trackingMode:'quantity',
      hasVariants:true,options:[{name:'Size',values:['Small','Large']}]});
    await inventory.receive(database,ctx,{skuId:available.skuIds[0],locationId:place.id,quantity:9,
      reference:'COUNT-OPENING',idempotencyKey:'navigation-opening-count'});
    await inventory.receive(database,ctx,{skuId:variant.skuIds[0],locationId:place.id,quantity:1,
      reference:'COUNT-GLOVE',idempotencyKey:'navigation-glove-count'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Workshop Supply'});
    const order=await workflows.createPurchaseOrder(database,ctx,{supplierId:supplier.id,
      destinationLocationId:place.id,idempotencyKey:'navigation-po-create',
      lines:[{skuId:incoming.skuIds[0],quantityUnits:4,unitCost:3}]});
    await workflows.approvePurchaseOrder(database,ctx,order.purchaseOrderId,{idempotencyKey:'navigation-po-approve'});
    await workflows.placePurchaseOrder(database,ctx,order.purchaseOrderId,{idempotencyKey:'navigation-po-place'});

    const overview=await page.goto(`${base}/inventory`);
    assert.equal(overview.status(),200);
    assert.match(await page.locator('main').innerText(),/4 products tracked/);
    assert.match(await page.locator('main').innerText(),/Purchase cost is missing for 10 units/);
    assert.doesNotMatch(await page.locator('main').innerText(),/amount above is not the full inventory value/);
    assert.match(await page.locator('main').innerText(),/A product may appear in more than one group/);
    assert.match(await page.locator('main a[href="/inventory/table?group=healthy"]').innerText(),/2 products/);
    const expected=[
      {group:'empty',name:'Nothing on hand',item:'Unstocked Hinge'},
      {group:'incoming',name:'On the way',item:'Ordered Bracket'},
      {group:'healthy',name:'Available now',item:'Ready Clamp'},
    ];
    for(const entry of expected){
      const link=page.locator(`main a[href="/inventory/table?group=${entry.group}"]`);
      assert.match(await link.innerText(),new RegExp(entry.name));
      await link.click();
      assert.equal(new URL(page.url()).searchParams.get('group'),entry.group);
      const text=await page.locator('main').innerText();
      assert.match(text,new RegExp(entry.item));
      assert.doesNotMatch(text,/Something went wrong|We could not find that/i);
      await page.goto(`${base}/inventory`);
    }
    await page.goto(`${base}/inventory/table?group=healthy`);
    assert.match(await page.locator('main').innerText(),/Sized Glove/);
    await page.goto(`${base}/inventory/table?group=empty`);
    assert.doesNotMatch(await page.locator('main').innerText(),/Sized Glove/,
      'a product with one stocked variant must not be counted as empty');
    for(const path of ['/inventory?group=empty','/inventory/table?group=shortage',
      '/inventory/table?group=incoming&sort=stock_desc','/inventory/table?group=unknown']){
      const response=await page.goto(`${base}${path}`);
      assert.equal(response.status(),200,`${path} did not render`);
      assert.doesNotMatch(await page.locator('main').innerText(),/Something went wrong|We could not find that/i,path);
    }
    await page.goto(`${base}/inventory`);
    const activity=page.getByRole('link',{name:'Tell StockChief about a stock change'});
    await activity.click();
    assert.match(page.url(),/\/ask\?from=%2Finventory&task=stock-activity$/);
    const guidance=await page.getByRole('region',{name:'Record a stock change'}).innerText();
    assert.match(guidance,/what arrived, left, moved, or was counted/i);
    assert.doesNotMatch(await page.locator('main').innerText(),/Operating outcomes|Recently carried out/i);
    assert.equal(await page.locator('#ask-question').inputValue(),'');

    const roots=['/','/inventory','/inventory/table','/purchasing','/orders','/money',
      '/needs-you','/ask','/everything'];
    const hrefs=new Set();
    for(const root of roots){
      const response=await page.goto(`${base}${root}`);
      assert.equal(response.status(),200,`Core page ${root} did not open`);
      for(const href of await page.locator('main a[href^="/"]').evaluateAll((anchors)=>
        anchors.map((anchor)=>anchor.getAttribute('href')).filter(Boolean)))
        if(!href.startsWith('//'))hrefs.add(href);
    }
    for(const href of hrefs){
      if(href==='/settings/export')continue; // An attachment, certified by settings-ui.test.js, not a page.
      const destination=await page.goto(`${base}${href}`);
      if(destination)assert.equal(destination.status(),200,`Visible link ${href} returned ${destination.status()}`);
      const content=await page.locator('main').innerText();
      assert.doesNotMatch(content,/Something went wrong|We could not find that/i,`Visible link ${href} is broken`);
    }
    assert.ok(hrefs.size>20,`Only ${hrefs.size} visible links were audited`);
    context.diagnostic(`Audited ${hrefs.size} visible destinations across ${roots.length} core pages; one download endpoint was excluded.`);
    assert.equal(empty.skuIds.length,1);
  });
