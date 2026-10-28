'use strict';process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');

test('the friendly Expenses source reports only posted expense lines and traces their journals',
  {timeout:120000},async t=>{
    const {db,ctx,email,password}=await require('../helpers/postgres-shipping-fixture').fixture(t);
    const ledger=require('../../src/accounting/postgres-ledger');
    await ledger.post(db,ctx,{postingDate:'2026-10-28',sourceKey:'report-expense-fixture',
      description:'Office supplies',currency:'USD',lines:[
        {accountKey:'OPERATING_EXPENSE',debitMinor:250},
        {accountKey:'CASH',creditMinor:250}]});
    const actor=(await db.query(`SELECT u.role,u.permissions,a.email FROM users u
      JOIN accounts a ON a.id=u.account_id WHERE u.workspace_id=$1 AND u.id=$2`,
      [ctx.workspaceId,ctx.actorId])).rows[0];
    const reports=require('../../src/reports/postgres-service');
    const details=await reports.run(db,ctx,actor,{dataset:'expenses',
      columns:['posting_date','category','description','amount_minor','currency'],sort:'posting_date'});
    assert.equal(details.rows.length,1);
    assert.equal(details.rows[0].amount_minor,'250');
    assert.match(details.rows[0].href,/^\/accounting\/entries\//);
    const grouped=await reports.run(db,ctx,actor,{dataset:'expenses',groups:['category','currency'],
      aggregate:'sum',measure:'amount_minor',sort:'total'});
    assert.equal(grouped.rows.length,1);assert.equal(grouped.rows[0].total,'250');
    assert.equal(grouped.displayRows[0].total,'$2.50');
    const filtered=async(filter)=>reports.run(db,ctx,actor,{dataset:'expenses',
      columns:['description','amount_minor'],filters:[filter],sort:'description'});
    assert.equal((await filtered({field:'amount_minor',operator:'greater_than',value:'200'})).rows.length,1);
    assert.equal((await filtered({field:'amount_minor',operator:'less_than',value:'200'})).rows.length,0);
    assert.equal((await filtered({field:'description',operator:'is_not',value:'Office supplies'})).rows.length,0);
    assert.equal((await filtered({field:'counterparty',operator:'is_empty'})).rows.length,1);
    assert.equal((await filtered({field:'counterparty',operator:'not_empty'})).rows.length,0);
    const registry=require('../../src/reports/postgres-registry');
    assert.equal(registry.get('expenses').label,'Recorded operating expenses');
    await ledger.post(db,ctx,{postingDate:'2026-10-28',sourceKey:'report-expense-second',
      description:'Delivery supplies',currency:'USD',lines:[
        {accountKey:'SHIPPING_EXPENSE',debitMinor:300},
        {accountKey:'CASH',creditMinor:300}]});
    const {createPostgresApp}=require('../../src/postgres-app');
    const app=createPostgresApp({database:db,env:'test',sessionSecret:'expense-report-test'});
    const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
    const {chromium}=require('playwright'),browser=await chromium.launch();
    t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
    const page=await browser.newPage({viewport:{width:390,height:844}}),origin='http://127.0.0.1:'+server.address().port;
    await page.goto(origin+'/login');await page.getByLabel('Work email',{exact:true}).fill(email);
    await page.locator('[name=password]').fill(password);
    await Promise.all([page.waitForURL(origin+'/'),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(origin+'/reports/builder?dataset=expenses');
    await page.getByRole('link',{name:'Groups and chart',exact:true}).click();await page.getByLabel('Show only the first results').fill('1');
    await page.locator('[data-report-preview-status]').getByText(/1 row shown/).waitFor();
    assert.equal(await page.locator('[data-report-preview-table] tbody tr').count(),1);
    await Promise.all([page.waitForURL('**/reports/run',{waitUntil:'domcontentloaded'}),
      page.getByRole('button',{name:'Run report'}).click()]);
    assert.equal(await page.locator('.report-results tbody tr').count(),1);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  });
