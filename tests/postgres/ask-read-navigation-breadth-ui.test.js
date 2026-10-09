'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {registry}=require('../../src/assistant/postgres-capability-registry');
const {destinationById}=require('../../src/web/postgres-navigation');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');

test('real browser traverses every registered page and asks every registered read without mutating business records',
  {timeout:600000},async(t)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'ask-read-navigation-breadth'});
    await migratePostgres(database);
    const cases=new Map();
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(['stockchief_capability_fit','stockchief_governed_report_fit'].includes(input.schemaName))
        return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(['stockchief_postgres_evidence_answer','stockchief_postgres_general_answer'].includes(input.schemaName)){
        const evidence=JSON.parse(input.prompt).evidence||[];
        const keys=Object.keys(evidence);
        return {data:{answer:keys.length?'The recorded business evidence is available for review.':
          'A reorder point is the stock level that triggers replenishment.',
          supported:true,evidenceKeys:keys},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_capability_answer'){
        const evidence=JSON.parse(input.prompt).evidence||[];
        return {data:{answer:evidence.map(row=>row.recordedAnswer||'No matching recorded evidence.').join(' '),
          supported:true,usedSteps:evidence.map((_,index)=>index)},usage:pricedUsage()};
      }
      if(input.schemaName==='stockchief_governed_report')return {data:{dataset:'stock',title:'Current stock report',
        columns:['product'],groups:[],aggregate:'count',measure:'',filters:[],sort:'product',
        direction:'asc',chart:'table'},usage:pricedUsage()};
      assert.equal(input.schemaName,'stockchief_capability_plan');
      const message=JSON.parse(input.prompt).message;
      assert.ok(cases.has(message),`No browser fixture for ${message}`);
      return {data:{steps:[{capability:cases.get(message),arguments:[],dependsOn:[],continuesPending:false}],
        clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-breadth-secret',aiProvider:provider});
    const server=await new Promise(resolve=>{const listening=app.listen(0,'127.0.0.1',()=>resolve(listening));});
    const browser=await chromium.launch();
    t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage();
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Ask Breadth Business');
    await page.getByLabel('Your name').fill('Ask Breadth Owner');
    await page.getByLabel('Work email').fill('ask-breadth@example.test');
    await page.locator('input[name="password"]').fill('ask-breadth-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('ask-breadth-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),
      page.getByRole('button',{name:'Create account'}).click()]);
    const workspaceId=(await database.query(`SELECT w.id FROM workspaces w JOIN users u ON u.workspace_id=w.id
      JOIN accounts a ON a.id=u.account_id WHERE a.email='ask-breadth@example.test'`)).rows[0].id;
    const businessCounts=async()=>(await database.query(`SELECT
      (SELECT COUNT(*)::int FROM items WHERE workspace_id=$1) AS items,
      (SELECT COUNT(*)::int FROM sales_orders WHERE workspace_id=$1) AS orders,
      (SELECT COUNT(*)::int FROM movements WHERE workspace_id=$1) AS movements,
      (SELECT COUNT(*)::int FROM accounting_journal_entries WHERE workspace_id=$1) AS journals`,
    [workspaceId])).rows[0];
    const before=await businessCounts();
    let pagesChecked=0;
    for(const contract of registry.list('navigation').filter(row=>row.destinationId)){
      const destination=destinationById(contract.destinationId);
      const message=`Open the ${destination.label} area`;
      cases.set(message,contract.name);
      await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
      assert.ok(page.url().startsWith(`${base}${destination.href}`),
        `${contract.name} did not open ${destination.href}: ${page.url()}`);
      assert.ok((await page.locator('body').innerText()).length>0,`${contract.name} blank destination`);
      pagesChecked++;
    }
    await page.goto(`${base}/sales/customers/new`);
    await page.locator('input[name="name"]').fill('Browser Navigation Customer');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create customer'}).click()]);
    assert.ok(page.url().startsWith(`${base}/customers`));
    const savedCustomer=(await database.query(`SELECT id FROM customers WHERE workspace_id=$1 AND name=$2`,
      [workspaceId,'Browser Navigation Customer'])).rows[0];
    assert.ok(savedCustomer,'customer form did not persist the customer');
    for(const [message,href] of [
      ['Open customers tab','/customers'],
      ['Please go to the customer directory page','/customers'],
      ['Open the sales orders page','/orders'],
      ['Open suppliers tab','/suppliers'],
    ]){
      await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
      assert.ok(page.url().startsWith(`${base}${href}`),`${message} went to ${page.url()}`);
      if(href==='/customers')assert.match(await page.locator('main').innerText(),/Browser Navigation Customer/);
      const interaction=(await database.query(`SELECT status,intent FROM stockchief_runtime.assistant_interactions
        WHERE workspace_id=$1 AND message=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [workspaceId,message])).rows[0];
      assert.equal(interaction?.status,'ANSWERED');
      assert.equal(interaction?.intent?.controlPlane?.capability,
        href==='/customers'?'navigate.customers':href==='/orders'?'navigate.sales':'navigate.suppliers');
    }
    let readsChecked=0;
    for(const contract of registry.list('read')){
      const message={
        'read.business_analysis':'How have customer orders changed this month compared with last month?',
        'read.general_knowledge':'Explain what a stock reorder point means in general.',
      }[contract.name]||`Tell me the verified ${contract.name} information for this business`;
      cases.set(message,contract.name);
      await page.goto(`${base}/ask`);
      await page.getByLabel('Ask StockChief').fill(message);
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue'}).click()]);
      const interaction=(await database.query(`SELECT status,intent FROM stockchief_runtime.assistant_interactions
        WHERE workspace_id=$1 AND message=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [workspaceId,message])).rows[0];
      assert.ok(interaction,`${contract.name} did not persist an Ask response`);
      assert.equal(interaction.intent?.controlPlane?.capability,contract.name,
        `${contract.name} was not the capability used for this answer`);
      assert.equal(interaction.status,'ANSWERED',
        `${contract.name} did not produce a verified read answer`);
      assert.ok((await page.locator('main').innerText()).length>0,`${contract.name} empty answer`);
      readsChecked++;
    }
    assert.equal(pagesChecked,registry.list('navigation').filter(row=>row.destinationId).length);
    assert.equal(readsChecked,registry.list('read').length);
    assert.deepEqual(await businessCounts(),before,'reads and navigation must not change business records');
  });
