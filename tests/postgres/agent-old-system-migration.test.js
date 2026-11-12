'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 190: moves your data in from your old system on day one.
const csv=(...lines)=>Buffer.from(lines.join('\n'));
const exportsFor=({stockValue='30.00'}={})=>[
  {filename:'items.csv',buffer:csv('SKU,Name,Cost,Price,Supplier','W-1,Widget,2.50,5.00,Acme','G-1,Gadget,1.00,3.00,Acme')},
  {filename:'stock.csv',buffer:csv('SKU,Name,Warehouse,Qty On Hand,Value','W-1,Widget,Main,10,25.00','G-1,Gadget,Main,4,4.00','G-1,Gadget,Annex,1,1.00',`Total,,,15,${stockValue}`)},
  {filename:'vendors.csv',buffer:csv('Vendor,Email','Acme,acme@example.test')},
  {filename:'customers.csv',buffer:csv('Customer,Email','Bobs Bikes,bob@example.test')},
  {filename:'purchase-orders.csv',buffer:csv('PO Number,Vendor,SKU,Qty Ordered,Qty Received,Unit Cost,Expected','PO-100,Acme,W-1,10,4,2.50,2026-12-01')},
  {filename:'sales-orders.csv',buffer:csv('Order Number,Customer,SKU,Qty,Price,Ship To','SO-9,Bobs Bikes,G-1,2,3.00,"1 Main St, Albany, NY 12207"')},
  {filename:'invoices.csv',buffer:csv('Invoice #,Customer,Date,Total,Balance','INV-1,Bobs Bikes,2026-10-01,7.00,5.00','Total,,,7.00,5.00')},
  {filename:'bills.csv',buffer:csv('Bill #,Vendor,Date,Balance','B-1,Acme,2026-10-05,2.00','Total,,,2.00')}];

test('old-system exports are read, checked against their totals and moved in per plan',{timeout:900000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();await db.close();await cluster.stop();});
  const migration=require('../../src/onboarding/agent-old-system-migration'),cutover=require('../../src/onboarding/postgres-cutover');
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create(),only={'erp.cutover.continue':handlers['erp.cutover.continue']};
  const request=require('supertest'),csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
  const one=async(sql,args)=>(await db.query(sql,args)).rows[0];
  async function business(tier,{aged=true,automated=true}={}){
    const email=randomUUID()+'@example.test',password='Fixture!'+randomUUID();
    const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Move '+tier,email,password});
    const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
    const subscribe=async plan=>db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,(SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'),'ACTIVE')
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),owner.accountId,plan]);
    await subscribe(tier);
    if(aged)await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[owner.accountId]);
    if(aged&&automated&&tier!=='starter'&&tier!=='growth')await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
    const browser=request.agent(app),login=await browser.get('/login');
    await browser.post('/login').type('form').send({_csrf:csrf(login.text),email,password}).expect(302);
    return {owner,ctx,browser,email,password,subscribe};
  }
  const start=(b,extra={})=>migration.start(db,b.ctx,{files:exportsFor(extra),currency:'USD',startDate:'2026-10-31',defaultLocation:'Main',sourceStopped:true,...extra.input});
  const settle=async(b,id)=>{for(let i=0;i<40;i++){const job=await jobs.processOne(db,only,{owner:'migration-test'});if(!job)break;assert.notEqual(job.status,'DEAD',JSON.stringify(job.lastError));}const p=await cutover.get(db,b.ctx,id);if(['APPROVED','APPLYING','RECONCILING','VALIDATING'].includes(p.status))console.log('STUCK',p.status,JSON.stringify((await db.query("SELECT status,last_error FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='erp.cutover.continue' ORDER BY created_at DESC LIMIT 2",[b.ctx.workspaceId])).rows),JSON.stringify((await db.query('SELECT entity_type,source_key,status,issue_detail FROM migration_records WHERE package_id=$1 AND issue_detail IS NOT NULL LIMIT 5',[id])).rows));return p;};
  const audits=async(b,action)=>Number((await one('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[b.ctx.workspaceId,action])).n);
  async function opened(b){
    const totals=await one(`SELECT (SELECT sum(on_hand) FROM balances WHERE workspace_id=$1)::text units,(SELECT sum(total_cost_minor) FROM accounting_inventory_cost_balances WHERE workspace_id=$1)::text value,
      (SELECT sum(balance_minor) FROM accounting_customer_invoices WHERE workspace_id=$1)::text owed,(SELECT sum(balance_minor) FROM accounting_supplier_bills WHERE workspace_id=$1)::text owing,
      (SELECT sum(debit_minor-credit_minor) FROM accounting_journal_lines WHERE workspace_id=$1)::text books,(SELECT count(*) FROM items WHERE workspace_id=$1)::int products,
      (SELECT count(*) FROM locations WHERE workspace_id=$1 AND name IN ('Main','Annex'))::int locations,(SELECT status FROM purchase_orders WHERE workspace_id=$1 AND po_number='PO-100') po,
      (SELECT sum(l.quantity_units)::text FROM purchase_order_lines l JOIN purchase_orders o ON o.workspace_id=l.workspace_id AND o.id=l.purchase_order_id WHERE o.workspace_id=$1) open_units,
      (SELECT status FROM sales_orders WHERE workspace_id=$1 AND order_number='SO-9') so,(SELECT amount_minor::int FROM sku_purchase_costs p JOIN skus s ON s.id=p.sku_id WHERE s.workspace_id=$1 AND s.code='W-1' LIMIT 1) cost`,[b.ctx.workspaceId]);
    assert.deepEqual(totals,{units:'15',value:'3000',owed:'500',owing:'200',books:'0',products:2,locations:2,po:'ORDERED',open_units:'6',so:'DRAFT',cost:250});
  }

  // Starter is refused and sees the Growth lock.
  const starter=await business('starter');
  await assert.rejects(start(starter),e=>e.code==='entitlement_required');
  const locked=await starter.browser.get('/erp-cutovers').expect(200);assert.match(locked.text,/Growth/);assert(!locked.text.includes('data-old-system-upload'));

  // Growth drafts the plan; the owner approves it and opens the inventory.
  const growth=await business('growth');
  const page=await growth.browser.get('/erp-cutovers').expect(200);assert.match(page.text,/data-old-system-upload/);
  let posted=growth.browser.post('/erp-cutovers/old-system').field('_csrf',csrf(page.text)).field('currency','USD').field('startDate','2026-10-31')
    .field('defaultLocation','Main').field('sourceStopped','yes');
  for(const f of exportsFor())posted=posted.attach('exports',f.buffer,f.filename);
  const created=await posted;assert.equal(created.status,303);
  const growthId=created.headers.location.split('/').pop();
  let pkg=await settle(growth,growthId);
  assert.equal(pkg.status,'READY');assert.match(pkg.postgres_state.oldSystem.holdReason,/On Growth/);
  assert.deepEqual(pkg.postgres_state.oldSystem.differences,[]);assert.equal(pkg.postgres_state.oldSystem.computed.stockValue,3000);
  assert.equal((await one('SELECT count(*)::int n FROM items WHERE workspace_id=$1',[growth.ctx.workspaceId])).n,0,'nothing is saved before approval');
  assert.equal((await one('SELECT count(*)::int n FROM stockchief_runtime.agent_migration_sources WHERE package_id=$1',[growthId])).n,8,'the original files are kept');
  const review=await growth.browser.get('/erp-cutovers/'+growthId).expect(200);
  assert.match(review.text,/Totals check/);assert.match(review.text,/Matches/);assert.match(review.text,/Approve this cutover/);
  const needs=await require('../../src/projections/postgres-service').needs(db,growth.ctx.workspaceId,growth.ctx.actorId);
  assert(needs.some(n=>n.href==='/erp-cutovers/'+growthId),'the plan waits in Needs you');
  await growth.browser.post('/erp-cutovers/'+growthId+'/approve').type('form').send({_csrf:csrf(review.text),sealedHash:pkg.postgres_state.sealedHash}).expect(303);
  pkg=await settle(growth,growthId);assert.equal(pkg.status,'VERIFIED','Growth opens the inventory itself');
  const verified=await growth.browser.get('/erp-cutovers/'+growthId).expect(200);
  await growth.browser.post('/erp-cutovers/'+growthId+'/activate').type('form').send({_csrf:csrf(verified.text),sealedHash:pkg.postgres_state.sealedHash}).expect(303);
  assert.equal((await cutover.get(db,growth.ctx,growthId)).status,'CUTOVER_ACTIVE');
  await opened(growth);
  assert.equal(await audits(growth,'Old system migration read'),1);assert.equal(await audits(growth,'Old system migration approved by StockChief'),0);
  assert.equal(await audits(growth,'Old system migration approved by the owner'),1);assert.equal(await audits(growth,'Inventory opened by the owner after the migration'),1);
  // The same exports again open the same migration.
  assert.deepEqual(await start(growth),{id:growthId,replayed:true});

  // Pro approves and opens on its own when every total and balance matches.
  const pro=await business('pro'),proRun=await start(pro);
  pkg=await settle(pro,proRun.id);
  assert.equal(pkg.status,'CUTOVER_ACTIVE');assert.equal(pkg.postgres_state.oldSystem.agentApproved,true);
  await opened(pro);
  assert.equal(await audits(pro,'Old system migration approved by StockChief'),1);assert.equal(await audits(pro,'Inventory opened by StockChief after the migration matched'),1);
  assert.match((await pro.browser.get('/erp-cutovers/'+proRun.id).expect(200)).text,/approved this migration on its own/);

  // Custom: a total that differs stops and asks; the owner decides.
  const custom=await business('enterprise'),customRun=await start(custom,{stockValue:'31.00'});
  pkg=await settle(custom,customRun.id);
  assert.equal(pkg.status,'READY');assert.deepEqual(pkg.postgres_state.oldSystem.differences,[{name:'stockValue',export:3100,records:3000}]);
  assert.match(pkg.postgres_state.oldSystem.holdReason,/differ/);
  await assert.rejects(migration.beforeApprove(db,custom.ctx,customRun.id,{}),/accept the differences/);
  const customPage=await custom.browser.get('/erp-cutovers/'+customRun.id).expect(200);assert.match(customPage.text,/Differs/);assert.match(customPage.text,/acceptDifferences/);
  await custom.browser.post('/erp-cutovers/'+customRun.id+'/approve').type('form').send({_csrf:csrf(customPage.text),sealedHash:pkg.postgres_state.sealedHash,acceptDifferences:'yes'}).expect(303);
  pkg=await settle(custom,customRun.id);assert.equal(pkg.status,'VERIFIED','a person-approved migration is opened by a person');
  assert.equal(await audits(custom,'Old system migration differences accepted'),1);

  // The first 14 days and Ask me first make Pro draft instead.
  const fresh=await business('pro',{aged:false}),freshRun=await start(fresh);
  pkg=await settle(fresh,freshRun.id);assert.equal(pkg.status,'READY');assert.match(pkg.postgres_state.oldSystem.holdReason,/first 14 days/);
  const asking=await business('pro');await require('../../src/autopilot/job-modes').save(db,asking.ctx,190,{mode:'ask',revision:0});
  const askRun=await start(asking);pkg=await settle(asking,askRun.id);assert.equal(pkg.status,'READY');assert.match(pkg.postgres_state.oldSystem.holdReason,/Ask me first/);

  // Bad or missing facts stop and ask; nothing is saved.
  const bad=await business('pro');
  await assert.rejects(migration.start(db,bad.ctx,{files:[{filename:'mystery.csv',buffer:csv('Alpha,Beta,Gamma','1,2,3')}],currency:'USD',startDate:'2026-10-31',sourceStopped:true}),/does not know what “mystery.csv” holds/);
  await assert.rejects(migration.start(db,bad.ctx,{files:[{filename:'stock.csv',buffer:csv('SKU,Name,Qty,Value','N-1,Neg,-2,4.00','Total,,-2,4.00')}],currency:'USD',startDate:'2026-10-31',sourceStopped:true}),/StockChief stopped: stock.csv line 2/);
  const untotalled=[{filename:'stock.csv',buffer:csv('SKU,Name,Qty,Value','T-1,Thing,3,9.00')}];
  await assert.rejects(migration.start(db,bad.ctx,{files:untotalled,currency:'USD',startDate:'2026-10-31',defaultLocation:'Main',sourceStopped:true}),/does not state its stock units, stock value/);
  await assert.rejects(migration.start(db,bad.ctx,{files:untotalled,currency:'USD',startDate:'2026-10-31',defaultLocation:'Main'}),/final/);
  assert.equal((await one('SELECT count(*)::int n FROM migration_packages WHERE workspace_id=$1',[bad.ctx.workspaceId])).n,0);
  const typed=await migration.start(db,bad.ctx,{files:untotalled,currency:'USD',startDate:'2026-10-31',defaultLocation:'Main',sourceStopped:true,stockUnits:'3',stockValue:'9.00'});
  pkg=await settle(bad,typed.id);assert.equal(pkg.status,'CUTOVER_ACTIVE','totals typed from the old report count as the export totals');

  // The plan page works on a desktop and a 390 px phone.
  const chrome=await require('playwright').chromium.launch();t.after(()=>chrome.close());
  const origin='http://127.0.0.1:'+server.address().port;
  for(const viewport of [{width:1280,height:900},{width:390,height:844}]){
    const tab=await chrome.newPage({viewport});
    await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(custom.email);await tab.locator('[name=password]').fill(custom.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const href of ['/erp-cutovers','/erp-cutovers/'+customRun.id]){
      await tab.goto(origin+href);
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll on '+href+' at '+viewport.width);
    }
    await tab.close();
  }
});
