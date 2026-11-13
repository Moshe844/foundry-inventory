'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('unusual price history stays bounded when thousands of SKUs change together',{timeout:240000},async t=>{
  const {db,ctx,subscribe}=await require('../helpers/agent-workflow-fixture').fixture(t);
  await subscribe('pro');
  const ws=ctx.workspaceId,day=await require('../../src/lib/business-time').today(db,ws);
  await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,created_at,updated_at)
    SELECT 'history-product-'||n,$1,'History '||n,'HISTORY-'||n,'quantity',now()::text,now()::text
    FROM generate_series(1,2500) n`,[ws]);
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,variant_label,created_at)
    SELECT 'history-sku-'||n,$1,'history-product-'||n,'HISTORY-'||n,'',now()::text
    FROM generate_series(1,2500) n`,[ws]);
  await db.query(`INSERT INTO sku_prices(id,workspace_id,sku_id,amount_minor,currency,source,created_by_user_id,created_at)
    SELECT 'history-price-'||n||'-'||step,$1,'history-sku-'||n,
      CASE WHEN step=5 THEN 1500 WHEN step%2=0 THEN 1050 ELSE 1000 END,'USD','owner',$2,
      ($3::date::timestamp AT TIME ZONE 'UTC' - make_interval(days=>(5-step)*50) + interval '1 hour')::text
    FROM generate_series(1,2500) n CROSS JOIN generate_series(1,5) step`,[ws,ctx.actorId,day]);
  const unusual=require('../../src/autopilot/unusual-activity');
  const rows=await db.transaction(async c=>{
    await c.query('SET LOCAL enable_nestloop = on');
    const alerts=await unusual.read(c,[ws,'',day]);
    assert.equal((await c.query('SHOW enable_nestloop')).rows[0].enable_nestloop,'on');
    return alerts;
  },{statementTimeoutMs:6000,readOnly:true});
  assert.equal(rows.filter(row=>row.Alert==='Unusual price change').length,2500);
});

// Job 171 is excluded on Starter and Growth and alone on Pro and Custom. The
// worker's routine check raises an alert for a big stock correction or price
// change (the owner's number, or three times what is usual for the product),
// for one person making many changes or deletions in a day (the owner's number,
// or three times their usual day) and for anything changed during the hours
// the owner watches. Nothing is blocked; the owner is told, in the app, in
// Needs you and by email, and every change is audited.
test('unusual activity is spotted, audited and emailed on its own on Pro and Custom without blocking work',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe,location}=f,ws=ctx.workspaceId;
  const inventory=require('../../src/domain/postgres-inventory-engine'),pricing=require('../../src/pricing/postgres-service'),time=require('../../src/lib/business-time');
  const catalog=require('../../src/domain/postgres-catalog-service'),alerts=require('../../src/autopilot/agent-alerts'),unusual=require('../../src/autopilot/unusual-activity');
  const reviews=require('../../src/autopilot/job-reviews'),needs=require('../../src/projections/postgres-service'),watches=require('../../src/autopilot/activity-watches');
  const modes=require('../../src/autopilot/job-modes'),mail=require('../../src/connections/postgres-outbound-mail'),removal=require('../../src/domain/postgres-record-removal');
  const worker=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  const check=()=>db.transaction(c=>worker({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  const open=async()=>(await db.query(`SELECT kind FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=171 AND NOT resolved ORDER BY kind,reference`,[ws])).rows.map(r=>r.kind);
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const rows=async()=>(await reviews.run(db,ctx,unusual.key,{scheduled:true})).rows;
  const notice=async()=>(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-171');
  const settings=async body=>{const page=await browser.get(unusual.path).expect(200);
    await browser.post('/autopilot/alert-settings/171').type('form').send({_csrf:f.csrf(page.text),revision:(await watches.settings(db,ws,171)).revision,...body}).expect(303);};

  await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1",[ws]);
  await db.query("UPDATE accounting_settings SET accounting_start_date=(current_date-120)::text WHERE workspace_id=$1",[ws]);
  const {calendarDate,timeZone}=await time.forWorkspace(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(calendarDate,n);
  const at=(n,h,m=0)=>time.wall(day(n),h,m,timeZone).toISOString();
  const yesterday=day(-1),A=f.item.skuIds[0];
  // Watched hours that never include this moment, and a work hour outside them.
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone,hour:'numeric',hourCycle:'h23'}).format(new Date()));
  const watchFrom=(hour+2)%24,watchUntil=(hour+4)%24,lateHour=(hour+3)%24,workHour=(hour+12)%24,pad=n=>String(n).padStart(2,'0');

  // A's corrections are usually one unit; yesterday's is six.
  for(const [n,counted] of [[-30,19],[-20,20],[-10,19]])
    await inventory.adjust(db,ctx,{skuId:A,locationId:location.id,countedQuantity:counted,reasonCode:'cycle_count',occurredAt:at(n,workHour),idempotencyKey:randomUUID()});
  await inventory.adjust(db,ctx,{skuId:A,locationId:location.id,countedQuantity:13,reasonCode:'cycle_count',occurredAt:at(-1,workHour,30),idempotencyKey:randomUUID()});
  // A delivery booked late at night.
  await inventory.receive(db,ctx,{skuId:A,locationId:location.id,quantity:1,occurredAt:at(-1,lateHour,30),idempotencyKey:randomUUID()});
  // B's price jumps 60% today; C's usually moves about 5% and jumps 50% today.
  const B=(await catalog.createItem(db,ctx,{name:'Price B',baseCode:'PRICE-B',trackingMode:'quantity'})).skuIds[0];
  const C=(await catalog.createItem(db,ctx,{name:'Price C',baseCode:'PRICE-C',trackingMode:'quantity'})).skuIds[0];
  for(const [n,amount] of [[-330,1000],[-250,1050],[-170,1000],[-90,1050]])
    await db.query(`INSERT INTO sku_prices(id,workspace_id,sku_id,amount_minor,currency,source,created_by_user_id,created_at) VALUES($1,$2,$3,$4,'USD','owner',$5,$6)`,
      [randomUUID(),ws,C,amount,ctx.actorId,at(n,9)]);
  await pricing.setPrice(db,ctx,{skuId:C,currency:'USD',amountMinor:1500});
  for(const amountMinor of [1000,1600])await pricing.setPrice(db,ctx,{skuId:B,currency:'USD',amountMinor});
  // A clerk usually makes a change every few weeks; today they made ten,
  // one of them deleting a customer.
  const auth=require('../../src/domain/postgres-auth-service'),clerkAccount=await auth.createBusiness(db,{name:'Night clerk',businessName:'Clerk inventory',email:randomUUID()+'@example.test',password:f.password});
  const clerk={workspaceId:ws,actorId:'clerk-'+randomUUID()};
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Night clerk','staff',now()::text)`,[clerk.actorId,ws,clerkAccount.accountId]);
  const edit=(when)=>db.query(`INSERT INTO catalogue_change_history(id,workspace_id,actor_id,item_id,sku_id,action,before_state,after_state,created_at)
    VALUES($1,$2,$3,$4,$5,'barcode','{}','{}',$6)`,[randomUUID(),ws,clerk.actorId,f.item.itemId,A,when]);
  for(const n of [-20,-19])await edit(at(n,10));
  for(let i=0;i<9;i++)await edit(new Date().toISOString());
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('gone-customer',$1,'Gone customer','gone@example.test','5185550100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)`,[ws,ctx.actorId]);
  const preview=await removal.review(db,clerk,{role:'staff'},'customer','gone-customer');
  assert.equal((await removal.remove(db,clerk,{role:'staff'},'customer','gone-customer',{expectedHash:preview.hash})).outcome,'erased');
  const deletion=(await db.query("SELECT actor_id,reference,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Record deleted'",[ws])).rows;
  assert.deepEqual(deletion.map(r=>[r.actor_id,r.reference,r.after_state.kind]),[[clerk.actorId,'Gone customer','customer']]);

  // Starter and Growth: excluded, with the plan lock.
  for(const tier of ['starter','growth']){
    await subscribe(tier);
    await check();
    assert.deepEqual(await open(),[],tier);
    await browser.get(unusual.path).expect(402);
    await assert.rejects(reviews.run(db,ctx,unusual.key,{scheduled:true}),e=>e.code==='entitlement_required');
    await assert.rejects(watches.save(db,ctx,171,{adjustmentUnits:5,revision:0}),e=>e.code==='entitlement_required');
  }

  // Pro and Custom spot what is unusual against history on their own, even
  // in the first 14 days: an alert changes nothing.
  const usual=['Many changes by one person','Unusual adjustment for this product','Unusual price change'];
  for(const tier of ['pro','enterprise']){
    await subscribe(tier);
    await check();
    assert.deepEqual(await open(),usual,tier);
    const shown=await notice();
    assert.equal(shown.title,'Unusual activity');assert.equal(shown.happened,'3 unusual changes in the last seven days.');
    assert.match((await browser.get('/needs-you').expect(200)).text,/Unusual activity/);
    const page=await browser.get(unusual.path).expect(200);
    assert.match(page.text,/Night clerk/);assert.match(page.text,/How you get these alerts/);assert.match(page.text,/changes or deletions in a day/);
  }
  let found=await rows();
  const adjustment=found.find(r=>r.Alert==='Unusual adjustment for this product');
  assert.deepEqual([adjustment['Units changed'],adjustment['Local time']],[-6,yesterday+' '+pad(workHour)+':30']);
  assert.equal(adjustment.Details,'Stock correction of -6 units at Dispatch · usually about 1 unit');
  const price=found.find(r=>r.Alert==='Unusual price change');
  assert.equal(price.What,'PRICE-C');assert.equal(price.Details,'Selling price $10.50 to $15.00 (up 42.9%) · usually about 4.9%');
  const busy=found.find(r=>r.Alert==='Many changes by one person');
  assert.deepEqual([busy.What,busy['Recorded by'],busy['Local time']],['Night clerk','Night clerk',calendarDate]);
  assert.match(busy.Details,/^10 changes, 1 of them deletions · usually about 0\.1 a day$/);
  assert.equal(await audits('Alerts updated'),1,'The first check raised the alerts once.');
  await check();await check();
  assert.equal(await audits('Alerts updated'),1,'Replays change nothing.');

  // The owner's own limits and watched hours (22:00 to 06:00).
  await assert.rejects(watches.save(db,ctx,171,{editCount:'0',revision:0}),e=>e.code==='validation_error');
  await assert.rejects(watches.save(db,ctx,171,{priceChangePct:'-5',revision:0}),e=>e.code==='validation_error');
  await assert.rejects(watches.save(db,ctx,171,{nightFrom:'22',revision:0}),/both ends/);
  await assert.rejects(watches.save(db,clerk,171,{editCount:'3',revision:0}),/Only the owner/);
  await settings({adjustmentUnits:'5',priceChangePct:'30',editCount:'3',nightFrom:String(watchFrom),nightUntil:String(watchUntil)});
  assert.equal(await audits('Alert settings saved'),1);
  const owned=await open();
  for(const kind of ['Large adjustment','Stock change during watched hours','Many changes by one person','Unusual price change'])assert.ok(owned.includes(kind),kind);
  assert.equal(owned.filter(k=>k==='Unusual price change').length,2,'B moved 60%, over the owner’s 30%.');
  assert.ok(!owned.includes('Unusual adjustment for this product'),'Over the owner’s limit it is a large adjustment.');
  found=await rows();
  const large=found.find(r=>r.Alert==='Large adjustment');
  assert.deepEqual([large['Units changed'],large.Details],[-6,'Stock correction of -6 units at Dispatch · usually about 1 unit']);
  const night=found.find(r=>r.Alert==='Stock change during watched hours');
  assert.deepEqual([night.What,night['Units changed'],night['Local time'],night['Recorded by']],[(await db.query('SELECT code FROM skus WHERE id=$1',[A])).rows[0].code,1,yesterday+' '+pad(lateHour)+':30','Owner']);
  assert.ok(found.some(r=>r.Alert==='Many changes by one person'&&r['Recorded by']==='Owner'),'The owner made three or more changes today.');
  assert.equal((await reviews.run(db,ctx,unusual.key,{filter:'Night clerk'})).rows.length,1);

  // Nothing is blocked: the clerk keeps working and the stock moves.
  const before=await f.balance();
  await inventory.adjust(db,ctx,{skuId:A,locationId:location.id,countedQuantity:15,reasonCode:'cycle_count',idempotencyKey:randomUUID()});
  assert.equal(await f.balance(),before+1);

  // Email: one message to the owner listing the waiting alerts.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await modes.save(db,ctx,171,{mode:'ask',revision:0});
  await alerts.configure(db,ctx,171,{mailbox:connector});
  await check();
  let panel=await alerts.panel(db,ctx,171);
  assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);assert.equal(panel.waiting,(await open()).length);
  const page=await browser.get(unusual.path).expect(200);
  await browser.post('/autopilot/alerts/171/send').type('form').send({_csrf:f.csrf(page.text)}).expect(303);
  const email=(await db.query(`SELECT DISTINCT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=171 AND email_communication_id IS NOT NULL`,[ws])).rows;
  assert.equal(email.length,1);
  const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,email[0].id])).rows[0].id;
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  await mail.executeSendEffect(db,ws,effect,{provider});
  assert.equal(sent[0].recipient,f.email);assert.match(sent[0].subject,/^\d+ unusual activity alerts$/);
  assert.match(sent[0].body,/Nothing was blocked/);
  assert.match(sent[0].body,/- Many changes by one person: Night clerk on \d{4}-\d\d-\d\d\. 10 changes, 1 of them deletions · usually about 0\.1 a day\./);
  assert.ok(sent[0].body.includes('- Large adjustment: ')&&sent[0].body.includes(', by Owner at '+yesterday+' '+pad(workHour)+':30. Stock correction of -6 units at Dispatch · usually about 1 unit.'));
  assert.equal(await audits('Alert email queued'),1);
  await modes.save(db,ctx,171,{mode:'inherit',revision:1});
  // In the first 14 days a new alert waits for email.
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await pricing.setPrice(db,ctx,{skuId:B,currency:'USD',amountMinor:500});await check();
  panel=await alerts.panel(db,ctx,171);assert.equal(panel.waiting,1);assert.match(panel.note,/first 14 days/);

  // Without the owner's limits only what is unusual against history stays.
  await settings({adjustmentUnits:'',priceChangePct:'',editCount:'',nightFrom:'',nightUntil:''});
  assert.deepEqual(await open(),usual);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===171).allowed,['inherit','watch','ask','routine']);

  // Downgrading hides the alerts.
  await subscribe('growth');
  assert.equal(await notice(),undefined);
  await subscribe('pro');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+unusual.path);
    assert(await tab.getByRole('heading',{name:'Unusual activity',exact:true}).isVisible());
    assert(await tab.getByRole('heading',{name:'How you get these alerts'}).isVisible());
    assert(await tab.getByLabel('Alert when one person makes this many changes or deletions in a day').isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'unusual-activity-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
