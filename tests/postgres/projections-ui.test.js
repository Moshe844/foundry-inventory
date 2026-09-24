'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const { chromium }=require('playwright');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const locations=require('../../src/domain/postgres-location-service');
const catalog=require('../../src/domain/postgres-catalog-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const ledger=require('../../src/accounting/postgres-ledger');
const connections=require('../../src/connections/postgres-service');
const { newId,nowIso }=require('../../src/lib/util');

test('real Chromium renders PostgreSQL Brief, proactive Needs You count, activity and balanced financial reports',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-projections-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-projections-secret'});
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});const errors=[];
    page.on('pageerror',(error)=>errors.push(error.message));page.setDefaultTimeout(15000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);await page.getByLabel('Business name').fill('Projection Business');
    await page.getByLabel('Your name').fill('Projection Owner');await page.getByLabel('Work email').fill('projection-pg@example.test');
    await page.getByLabel('Password').fill('projection-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id WHERE a.email='projection-pg@example.test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const location=await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Projection Widget',baseCode:'PROJ',trackingMode:'quantity',unitLabel:'unit'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:12,reference:'OPENING-PROJECTION',idempotencyKey:'projection-opening'});
    await ledger.configure(database,ctx,{startDate:'2026-09-01',currency:'USD'});
    await ledger.post(database,ctx,{postingDate:'2026-09-01',sourceKey:'projection-opening-books',description:'Opening balances',
      lines:[{accountKey:'CASH',debitMinor:20000},{accountKey:'INVENTORY_ASSET',debitMinor:4000},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:24000}]});
    await ledger.post(database,ctx,{postingDate:'2026-09-15',sourceKey:'projection-sale',description:'Verified sale',
      lines:[{accountKey:'ACCOUNTS_RECEIVABLE',debitMinor:10000},{accountKey:'SALES_REVENUE',creditMinor:10000},
        {accountKey:'COST_OF_GOODS_SOLD',debitMinor:4000},{accountKey:'INVENTORY_ASSET',creditMinor:4000}]});
    await ledger.post(database,ctx,{postingDate:'2026-09-16',sourceKey:'projection-rent',description:'Rent paid',
      lines:[{accountKey:'RENT_EXPENSE',debitMinor:1000},{accountKey:'CASH',creditMinor:1000}]});
    const feed=await connections.createFeed(database,ctx,{displayName:'Store feed'});const at=nowIso();
    await database.query(`INSERT INTO connection_issues(id,workspace_id,connector_id,issue_type,fingerprint,title,
      detail,resolution_hint,status,created_at,updated_at) VALUES($1,$2,$3,'outage','projection-feed-outage',
      'Store feed stopped updating','No events have arrived since the provider outage.','Reconnect the store feed.','OPEN',$4,$4)`,
    [newId('conissue'),ctx.workspaceId,feed.connection.id,at]);

    await page.goto(`${base}/`);const brief=await page.locator('main').innerText();
    assert.match(brief,/1 exception needs you/);assert.match(brief,/12 units are available/);
    assert.match(brief,/Projection Widget/);assert.match(brief,/OPENING-PROJECTION/);
    assert.equal(await page.locator('a[href="/needs-you"] .nav-count').innerText(),'1');
    await page.locator('.rm-rail__nav a[href="/needs-you"]').click();
    assert.match(await page.locator('main').innerText(),/Store feed stopped updating/);
    assert.match(await page.locator('main').innerText(),/Reconnect the store feed/);
    await page.goto(`${base}/activity`);const activity=await page.locator('main').innerText();
    assert.match(activity,/Activity/);assert.match(activity,/Received 12 × Projection Widget into Main Warehouse/);
    assert.match(activity,/raw movement ledger/i);await page.getByLabel('Search activity').fill('OPENING-PROJECTION');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Search'}).click()]);
    assert.match(await page.locator('main').innerText(),/OPENING-PROJECTION/);
    await page.goto(`${base}/money`);const money=await page.locator('main').innerText();
    assert.match(money,/\$50\.00 net income this period/);assert.match(money,/\$100\.00 revenue/);
    await page.goto(`${base}/accounting/reports/profit-and-loss?from=2026-09-01&to=2026-09-30`);
    const pnl=await page.locator('main').innerText();assert.match(pnl,/Revenue\s*\$100\.00/);assert.match(pnl,/Net income\s*\$50\.00/);
    await page.goto(`${base}/accounting/reports/balance-sheet?asOf=2026-09-30`);
    assert.match(await page.locator('main').innerText(),/Balanced/);
    await page.goto(`${base}/accounting/reports/trial-balance?to=2026-09-30`);
    assert.match(await page.locator('main').innerText(),/Debits equal credits/);
    await page.goto(`${base}/accounting/reports/general-ledger?from=2026-09-01&to=2026-09-30`);
    assert.match(await page.locator('main').innerText(),/Verified sale/);assert.match(await page.locator('main').innerText(),/Rent paid/);
    const accounts=(await database.query(`SELECT id,system_key FROM accounting_accounts WHERE workspace_id=$1
      AND system_key IN ('RENT_EXPENSE','CASH')`,[ctx.workspaceId])).rows;
    const accountIds=Object.fromEntries(accounts.map((account)=>[account.system_key,account.id]));
    await page.goto(`${base}/accounting/adjustments/new`);
    await page.getByLabel('Posting date').fill('2026-09-20');await page.getByLabel('Amount').fill('25.00');
    await page.getByLabel('What is this entry for?').fill('Accountant-directed correction');
    await page.getByLabel('Debit account').selectOption(accountIds.RENT_EXPENSE);
    await page.getByLabel('Credit account').selectOption(accountIds.CASH);
    await page.getByLabel('Reason / supporting reference (optional)').fill('Certification adjustment');
    await Promise.all([page.waitForURL(/\/accounting\/entries\/je_/),page.getByRole('button',{name:'Post adjustment'}).click()]);
    assert.match(await page.locator('main').innerText(),/Accountant-directed correction/);
    await page.getByText('Advanced accounting details',{exact:true}).click();
    assert.match(await page.locator('main').innerText(),/\$25\.00/);
    await page.getByText('Correct this entry',{exact:true}).click();
    await page.getByLabel('Correction date').fill('2026-09-21');await page.getByLabel('Why').fill('Entered for certification only');
    await Promise.all([page.waitForURL(/\/accounting\/entries\/je_/),page.getByRole('button',{name:'Post reversal'}).click()]);
    assert.match(await page.locator('main').innerText(),/Reversal of entry/);
    await page.getByText('Advanced accounting details',{exact:true}).click();
    assert.match(await page.locator('main').innerText(),/Reverses an earlier posted entry/);
    const unbalanced=await database.query(`SELECT e.id FROM accounting_journal_entries e JOIN accounting_journal_lines l ON l.entry_id=e.id
      WHERE e.workspace_id=$1 GROUP BY e.id HAVING SUM(l.debit_minor)<>SUM(l.credit_minor)`,[ctx.workspaceId]);
    assert.equal(unbalanced.rows.length,0);
    assert.deepEqual(errors,[]);
  });
