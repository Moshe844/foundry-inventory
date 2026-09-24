'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const catalog=require('../../src/domain/postgres-catalog-service');
const pricing=require('../../src/pricing/postgres-service');

test('real Chromium previews and approves PostgreSQL selling prices and purchase costs without rewriting stale truth',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-pricing-ui'});
    await migratePostgres(database);const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-pricing-secret',
      aiProvider:{complete:async()=>{throw new Error('Use deterministic certification parsing.');}}});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Pricing Certification');
    await page.getByLabel('Your name').fill('Pricing Owner');await page.getByLabel('Work email').fill('pricing-pg@example.test');
    await page.getByLabel('Password').fill('pricing-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w JOIN users u ON u.workspace_id=w.id
      JOIN accounts account ON account.id=u.account_id WHERE account.email='pricing-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const item=await catalog.createItem(database,ctx,{name:'Pricing Widget',baseCode:'PRICE-WIDGET',trackingMode:'quantity'});
    const skuId=item.skuIds[0];

    await page.goto(`${base}/inventory/${item.itemId}`);const emptyPricing=await page.locator('main').innerText();
    assert.match(emptyPricing,/Selling price/i);assert.match(emptyPricing,/Purchase cost/i);
    assert.equal((emptyPricing.match(/Not set/g)||[]).length,2);
    await page.locator(`a[href="/pricing/new?skuId=${skuId}"]`).click();await page.getByLabel(/Selling price per/).fill('24.50');
    await Promise.all([page.waitForURL(/\/pricing\/proposals\//),page.getByRole('button',{name:'Review price change'}).click()]);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM sku_prices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    const pricePreview=await page.locator('main').innerText();assert.match(pricePreview,/Current selling price/i);
    assert.match(pricePreview,/New selling price/i);assert.match(pricePreview,/Not set/);assert.match(pricePreview,/\$24\.50/);
    await Promise.all([page.waitForURL(new RegExp(`/inventory/${item.itemId}`)),page.getByRole('button',{name:'Approve price'}).click()]);
    assert.match(await page.locator('main').innerText(),/\$24\.50/);

    await page.locator(`a[href="/pricing/purchase-costs/new?skuId=${skuId}"]`).click();await page.getByLabel(/Purchase cost per/).fill('12.75');
    await Promise.all([page.waitForURL(/\/pricing\/purchase-costs\/proposals\//),page.getByRole('button',{name:'Review cost change'}).click()]);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM sku_purchase_costs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].count,'0');
    const costPreview=await page.locator('main').innerText();assert.match(costPreview,/New purchase cost/i);
    assert.match(costPreview,/Selling price/i);assert.match(costPreview,/\$12\.75/);assert.match(costPreview,/\$24\.50/);
    await Promise.all([page.waitForURL(new RegExp(`/inventory/${item.itemId}`)),page.getByRole('button',{name:'Approve purchase cost'}).click()]);
    assert.match(await page.locator('main').innerText(),/\$24\.50[\s\S]*\$12\.75/);

    const stale=await pricing.createPriceProposal(database,ctx,{skuId,amount:'30.00',currency:'USD',sourceText:'Stale browser preview'});
    await pricing.setPrice(database,ctx,{skuId,amount:'26.00',currency:'USD',source:'certification'});
    await page.goto(`${base}/pricing/proposals/${stale.id}`);await page.getByRole('button',{name:'Approve price'}).click();
    await page.getByText(/current selling price changed after this preview/i).waitFor();
    assert.match(await page.locator('body').innerText(),/current selling price changed after this preview/i);
    const current=await pricing.currentPrice(database,ctx.workspaceId,skuId);assert.equal(current.amount_minor,2600);
    assert.equal((await database.query('SELECT status FROM price_change_proposals WHERE id=$1',[stale.id])).rows[0].status,'PENDING');

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill('Set the selling price for Pricing Widget to $28.00');
    await Promise.all([page.waitForURL(`${base}/ask#latest`),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/Set Pricing Widget selling price to \$28\.00[\s\S]*Nothing has changed yet/i);
    const actionHref=await page.locator('a[href^="/actions/"]').last().getAttribute('href');assert.ok(actionHref);
    assert.equal((await pricing.currentPrice(database,ctx.workspaceId,skuId)).amount_minor,2600);
    await page.goto(`${base}${actionHref}`);assert.match(await page.locator('main').innerText(),/catalog\.set_price/);
    await page.getByRole('button',{name:'Approve and execute'}).click();await page.waitForURL(`${base}${actionHref}`);
    assert.match(await page.locator('main').innerText(),/EXECUTED/);
    assert.equal((await pricing.currentPrice(database,ctx.workspaceId,skuId)).amount_minor,2800);

    await page.goto(`${base}/ask`);await page.getByLabel('Ask StockChief').fill('Set the purchase cost for Pricing Widget to $14.25');
    await Promise.all([page.waitForURL(`${base}/ask#latest`),page.getByRole('button',{name:'Continue'}).click()]);
    assert.match(await page.locator('main').innerText(),/Set Pricing Widget purchase cost to \$14\.25[\s\S]*Nothing has changed yet/i);
    const costActionHref=await page.locator('a[href^="/actions/"]').last().getAttribute('href');assert.ok(costActionHref);
    assert.equal((await pricing.purchaseCost(database,ctx.workspaceId,skuId)).amount_minor,1275);
    await page.goto(`${base}${costActionHref}`);assert.match(await page.locator('main').innerText(),/catalog\.set_purchase_cost/);
    await page.getByRole('button',{name:'Approve and execute'}).click();await page.waitForURL(`${base}${costActionHref}`);
    assert.match(await page.locator('main').innerText(),/EXECUTED/);
    assert.equal((await pricing.purchaseCost(database,ctx.workspaceId,skuId)).amount_minor,1425);
  });
