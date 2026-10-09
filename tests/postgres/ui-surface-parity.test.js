'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');

const SURFACES=['/onboarding','/inventory','/purchasing','/orders','/money','/autopilot/history','/settings',
  '/settings/connections','/settings/shipping','/mail','/ask','/everything','/autopilot',
  '/warehouse','/planning','/imports/start'];

function appRoutes(app){
  const routes=[];
  function visit(stack){
    for(const layer of stack||[]){
      if(layer.route){for(const pathname of [layer.route.path].flat())for(const method of Object.keys(layer.route.methods))
        routes.push({pathname,method:method.toUpperCase()});}
      else if(layer.handle?.stack)visit(layer.handle.stack);
    }
  }
  visit(app._router.stack);
  return routes;
}

function routeExists(routes,method,href){
  const pathname=new URL(href,'http://localhost').pathname;
  return routes.some((route)=>route.method===method&&new RegExp(`^${route.pathname
    .replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/:[a-zA-Z][a-zA-Z0-9_]*/g,'[^/]+')}$`).test(pathname));
}

test('PostgreSQL core pages render and expose only live local navigation and form routes',
  {timeout:240000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-surface-parity'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-surface-parity-secret'});
    const routes=appRoutes(app);
    const server=await new Promise((resolve)=>{const started=app.listen(0,'127.0.0.1',()=>resolve(started));});
    const browser=await chromium.launch();
    context.after(async()=>{await browser.close();await new Promise((resolve)=>server.close(resolve));
      await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    const errors=[];page.on('pageerror',(error)=>errors.push(error.message));
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.goto(`${base}/register`);
    await page.getByLabel('Business name').fill('Surface Audit');
    await page.getByLabel('Your name').fill('Surface Owner');
    await page.getByLabel('Work email').fill('surface-audit@example.test');
    await page.locator('input[name="password"]').fill('surface-audit-password');if(await page.locator('input[name="confirmPassword"]').count())await page.locator('input[name="confirmPassword"]').fill('surface-audit-password');
    await Promise.all([page.waitForURL(`${base}/onboarding`),page.getByRole('button',{name:'Create account'}).click()]);
    const missing=[];
    await page.goto(`${base}/everything`);
    const listed=await page.locator('.rm-vault__links a').evaluateAll((links)=>links
      .map((link)=>link.getAttribute('href')).filter((href)=>href&&href!=='/settings/export'));
    for(const surface of [...new Set([...SURFACES,...listed])]){
      const response=await page.goto(`${base}${surface}`);
      assert.ok(response&&response.status()<400,`${surface} returned ${response?.status()}`);
      assert.ok((await page.locator('#main').innerText()).trim(),`${surface} was empty`);
      const controls=await page.locator('a[href^="/"],form[action^="/"]').evaluateAll((nodes)=>nodes.map((node)=>({
        method:node.tagName==='FORM'?String(node.method||'GET').toUpperCase():'GET',
        href:node.tagName==='FORM'?node.action:node.href,
        label:(node.textContent||'').trim().slice(0,50),
      })));
      for(const control of controls){
        const pathname=new URL(control.href).pathname;
        if(pathname.startsWith('/api/')||pathname.startsWith('/assets/'))continue;
        if(!routeExists(routes,control.method,control.href))missing.push(`${surface}: ${control.method} ${pathname} (${control.label})`);
      }
    }
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id JOIN accounts a ON a.id=u.account_id
      WHERE a.email='surface-audit@example.test'`)).rows[0];
    const customer=await commerce.createCustomer(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {name:'Surface Customer',email:'surface-customer@example.test'});
    const supplier=await commerce.createSupplier(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {name:'Surface Supplier',email:'surface-supplier@example.test'});
    await page.goto(`${base}/accounting/receivables/new`);
    await page.getByLabel('Customer').selectOption(customer.id);
    await page.getByLabel('Description').fill('Consulting service');
    await page.getByLabel('Unit amount').fill('150.00');
    await Promise.all([page.waitForURL(`${base}/accounting/receivables`),page.getByRole('button',{name:'Record invoice'}).click()]);
    assert.match(await page.locator('#main').innerText(),/INV-0001/);
    await page.goto(`${base}/sales/customers/${customer.id}`);
    assert.match(await page.locator('#main').innerText(),/INV-0001|150\.00|Surface Customer/);
    await page.getByLabel('Email').fill('changed-customer@example.test');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save customer'}).click()]);
    assert.equal((await database.query('SELECT email FROM customers WHERE id=$1',[customer.id])).rows[0].email,
      'changed-customer@example.test');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Archive customer'}).click()]);
    assert.match(await page.locator('#main').innerText(),/Archived/);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Restore customer'}).click()]);
    await page.goto(`${base}/accounting/payables/new`);
    await page.locator('select[name="counterpartyId"]').selectOption(supplier.id);
    await page.getByLabel('Supplier invoice number').fill('SUP-001');
    await page.getByLabel('Description').fill('Warehouse rent');
    await page.getByLabel('Unit amount').fill('40.00');
    await Promise.all([page.waitForURL(`${base}/accounting/payables`),page.getByRole('button',{name:'Record bill'}).click()]);
    const totals=(await database.query(`SELECT
      (SELECT COUNT(*) FROM accounting_customer_invoices WHERE workspace_id=$1) AS invoices,
      (SELECT COUNT(*) FROM accounting_supplier_bills WHERE workspace_id=$1) AS bills,
      (SELECT COALESCE(SUM(quantity_delta),0) FROM movements WHERE workspace_id=$1) AS stock_delta,
      (SELECT COALESCE(SUM(debit_minor-credit_minor),0) FROM accounting_journal_lines WHERE workspace_id=$1) AS journal_difference`,
    [identity.workspace_id])).rows[0];
    assert.deepEqual([Number(totals.invoices),Number(totals.bills),Number(totals.stock_delta),Number(totals.journal_difference)],
      [1,1,0,0]);
    await page.goto(`${base}/accounting/receivables`);
    await page.getByText('Record payment',{exact:true}).click();
    await page.getByLabel('Amount received').fill('20.00');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Record it'}).click()]);
    const payment=(await database.query(`SELECT id,cash_account_id FROM accounting_payments
      WHERE workspace_id=$1 AND direction='CUSTOMER_RECEIPT'`,[identity.workspace_id])).rows[0];
    await page.goto(`${base}/accounting/banking`);
    await page.getByText('Add a financial account').click();
    await page.getByLabel('Name',{exact:true}).fill('Surface Bank');
    await page.getByLabel('Ledger account').selectOption(payment.cash_account_id);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Add account'}).click()]);
    assert.match(await page.locator('#main').innerText(),/Surface Bank/);
    await page.getByText('Surface Bank',{exact:true}).click();
    await page.getByText('Fallback: enter one statement line manually').click();
    await page.getByLabel('Amount shown by the bank').fill('20.00');
    await page.getByLabel('Description',{exact:true}).fill('Customer payment');
    await page.getByLabel('Bank reference (optional)').fill('STMT-001');
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Import as unmatched evidence'}).click()]);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM accounting_bank_transactions')).rows[0].count,'1');
    await page.locator('.list-row').getByText('Customer payment',{exact:true}).click();
    await page.getByLabel('What does this line prove?').selectOption(`payment:${payment.id}`);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Match exact activity'}).click()]);
    assert.equal((await database.query('SELECT status FROM accounting_bank_transactions')).rows[0].status,'MATCHED');
    await page.getByText('Surface Bank',{exact:true}).click();
    await page.getByLabel('Statement ending balance').fill('20.00');
    await page.getByLabel('Complete only if exact and every line is matched').check();
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Check reconciliation'}).click()]);
    assert.equal((await database.query('SELECT status FROM accounting_reconciliations')).rows[0].status,'COMPLETED');
    for(const surface of ['/inventories','/accounting/receivables','/accounting/payables',
      '/accounting/banking','/suppliers','/orders','/activity','/settings']){
      const response=await page.goto(`${base}${surface}`);
      assert.ok(response&&response.status()<400,`${surface} returned ${response?.status()}`);
      const controls=await page.locator('a[href^="/"],form[action^="/"]').evaluateAll((nodes)=>nodes.map((node)=>({
        method:node.tagName==='FORM'?String(node.method||'GET').toUpperCase():'GET',
        href:node.tagName==='FORM'?node.action:node.href,
        label:(node.textContent||'').trim().slice(0,50),
      })));
      for(const control of controls){
        const pathname=new URL(control.href).pathname;
        if(pathname.startsWith('/api/')||pathname.startsWith('/assets/'))continue;
        if(!routeExists(routes,control.method,control.href))missing.push(`${surface}: ${control.method} ${pathname} (${control.label})`);
      }
    }
    assert.deepEqual(missing,[]);
    assert.deepEqual(errors,[]);
  });
