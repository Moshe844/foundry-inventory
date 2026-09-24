'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const imports=require('../../src/imports/postgres-service');

test('real Chromium previews, approves, imports and reconciles PostgreSQL inventory with duplicate and rollback safety',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-imports-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-imports-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{
      await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();
    });
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(20000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Import Business');
    await page.getByLabel('Your name').fill('Import Owner');
    await page.getByLabel('Work email').fill('imports-pg@example.test');
    await page.getByLabel('Password').fill('imports-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    await page.goto(`${base}/locations`);
    await page.getByRole('button',{name:'Add your first location'}).click();
    await page.getByLabel('Name',{exact:true}).fill('Main Warehouse');
    await page.getByLabel('Type',{exact:true}).selectOption('warehouse');
    await Promise.all([page.waitForNavigation(),page.locator('#modal-location').getByRole('button',{name:'Add location'}).click()]);
    await page.goto(`${base}/onboarding`);
    const source=Buffer.from('Product,SKU,Size,Location,Quantity\nTrail Shoe,SHOE-8,8,Main Warehouse,7\nTrail Shoe,SHOE-9,9,Main Warehouse,5\n');
    await page.getByLabel('Inventory spreadsheets').setInputFiles({name:'opening-stock.csv',mimeType:'text/csv',buffer:source});
    await page.waitForURL(/\/imports\/imp_/);
    assert.match(await page.locator('main').innerText(),/2 rows read · 2 ready · 0 need correction/);
    assert.match(await page.locator('main').innerText(),/No inventory changed yet/);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='imports-pg@example.test'`)).rows[0];
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1',[identity.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve 2 rows'}).click()]);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1',[identity.workspace_id])).rows[0].count,'0');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import and verify'}).click()]);
    const main=await page.locator('main').innerText();
    assert.match(main,/Verified/);assert.match(main,/2 rows created 1 products, 2 SKUs and 12 opening units/);
    const truth=(await database.query(`SELECT COUNT(DISTINCT i.id) AS items,COUNT(DISTINCT s.id) AS skus,
      COALESCE(SUM(b.on_hand),0) AS units,COALESCE(SUM(m.quantity_delta),0) AS ledger_units
      FROM items i JOIN skus s ON s.item_id=i.id LEFT JOIN balances b ON b.sku_id=s.id
      LEFT JOIN movements m ON m.sku_id=s.id WHERE i.workspace_id=$1`,[identity.workspace_id])).rows[0];
    assert.deepEqual(truth,{items:'1',skus:'2',units:'12',ledger_units:'12'});

    await page.goto(`${base}/onboarding?add=1`);
    await page.getByLabel('Inventory spreadsheets').setInputFiles({name:'opening-stock.csv',mimeType:'text/csv',buffer:source});
    await page.waitForURL(/\/imports\/imp_/);
    assert.match(await page.locator('main').innerText(),/This exact source was already imported/);
    assert.equal(await page.getByRole('button',{name:'Approve 2 rows'}).isDisabled(),true);
    assert.deepEqual((await database.query(`SELECT COUNT(*) AS items,COALESCE((SELECT SUM(on_hand) FROM balances
      WHERE workspace_id=$1),0) AS units FROM items WHERE workspace_id=$1`,[identity.workspace_id])).rows[0],
    {items:'1',units:'12'});

    const failing=await imports.analyse(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},{
      text:'Product,SKU,Location,Quantity\nRollback One,RB-1,Main Warehouse,3\nRollback Two,RB-2,Main Warehouse,4\n',
      filename:'rollback.csv'});
    await imports.approve(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},failing.id,failing.integrityHash);
    await assert.rejects(imports.execute(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},failing.id,{
      beforeGroup:({itemsCreated})=>{if(itemsCreated===1)throw new Error('simulated process failure');},
    }),/simulated process failure/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM items WHERE workspace_id=$1
      AND name IN ('Rollback One','Rollback Two')`,[identity.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements WHERE workspace_id=$1
      AND reference LIKE 'Import rollback.csv%'`,[identity.workspace_id])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT status FROM import_executions WHERE import_id=$1`,[failing.id])).rows[0].status,'FAILED');
    assert.deepEqual(errors,[]);
  });
