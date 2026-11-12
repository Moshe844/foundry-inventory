'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 191 is alone on every plan: a daily routine warns before stock expires,
// inside the owner's warning days per product or category, and works out where
// to sell it first. Warnings appear in the app and in Needs you in every mode;
// emailing them from the connected mailbox waits for shadow, pause, watch mode,
// Watch only and Ask me first. Picks take the soonest expiry first.
test('expiry warnings follow the owner windows, suggest where to sell first and email only when StockChief may act',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const expiry=require('../../src/operations/agent-expiry-warnings'),reviews=require('../../src/autopilot/job-reviews');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),mail=require('../../src/connections/postgres-outbound-mail');
  const needs=require('../../src/projections/postgres-service');
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
  const item=async(code,category)=>{
    const created=await catalog.createItem(db,ctx,{name:'Fresh '+code,baseCode:code,trackingMode:'lot',purchaseCost:'2'});
    if(category)await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at) VALUES($1,$2,$3,'{}',now()::text,now()::text)
      ON CONFLICT(workspace_id,item_id) DO UPDATE SET category=excluded.category`,[ws,created.itemId,category]);
    return created.skuIds[0];
  };
  const stock=(sku,lot,expires,quantity,at=location.id)=>receipt.receive(db,ctx,{skuId:sku,locationId:at,lotCode:lot,expiresAt:expires,
    lotReceivedAt:day(-20),quantity,idempotencyKey:randomUUID()});
  const order=async(sku,quantity,neededBy,at=location.id)=>{
    const o=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:at,neededBy,
      idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor:500}]});
    await workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
    return o;
  };
  const MILK=await item('MILK','Dairy'),CHEESE=await item('CHEESE','Dairy');
  await stock(MILK,'M-EARLY',day(10),6);await stock(MILK,'M-LATE',day(120),5);await stock(MILK,'M-OLD',day(-1),1);
  await stock(CHEESE,'C-1',day(40),3);await stock(MILK,'M-SHOP',day(200),1,shop.id);
  const soon=await order(MILK,4,day(5)),later=await order(MILK,3,day(60)),away=await order(MILK,2,day(7),shop.id);

  const sweep=()=>expiry.run({workspaceId:ws,payload:{}},db);
  const warning=async lot=>(await db.query(`SELECT w.*,w.expires_on::text AS expires_on FROM stockchief_runtime.agent_expiry_warnings w JOIN lots l ON l.id=w.lot_id
    WHERE w.workspace_id=$1 AND l.code=$2 ORDER BY w.created_at DESC LIMIT 1`,[ws,lot])).rows[0];
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const lotUnits=async lot=>Number((await db.query(`SELECT coalesce(sum(b.quantity),0) AS n FROM lot_balances b JOIN lots l ON l.id=b.lot_id WHERE l.workspace_id=$1 AND l.code=$2`,[ws,lot])).rows[0].n);

  // No plan: nothing runs and the page is locked.
  assert.equal((await sweep()).skipped,true);

  // Starter, in its first 14 days: warnings still appear (they change nothing).
  await subscribe('starter');
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  await expiry.check(db,ctx);
  const processed=await queue.processOne(db,handlers,{owner:'expiry-worker',kinds:[expiry.kind]});
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  let early=await warning('M-EARLY');
  assert.equal(early.status,'OPEN');assert.equal(early.warning_days,30);assert.equal(Number(early.units),6);
  assert.deepEqual(early.plan.orders.map(o=>[o.order,o.units]),[[soon.orderNumber,'4']],'Only the order due before expiry draws the batch.');
  assert.equal(early.plan.unclaimed,'2');assert.equal(early.plan.clearance,true);
  assert.deepEqual(early.plan.elsewhere.map(e=>[e.location,e.order,e.units]),[['Shop',away.orderNumber,'2']]);
  const old=await warning('M-OLD');assert.equal(old.expired,true);assert.match(expiry.lines({...old,plan:old.plan})[0],/can no longer be sold/);
  assert.equal(await warning('C-1'),undefined,'Cheese is outside the default 30 days.');
  assert.equal(await warning('M-LATE'),undefined);
  assert.match(early.email_note,/watching during the first 14 days/);
  assert.equal(await count('SELECT count(*) FROM customer_communications WHERE workspace_id=$1'),0);
  assert.equal(await audits('Expiry warnings raised'),1);
  const [notice]=await expiry.inbox(db,ws);
  assert.equal(notice.title,'Expired stock is still on hand');assert.match(notice.happened,/1 batch expires inside your warning window\. The first expires on .* 1 batch has expired/);
  assert((await needs.needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='expiry-warnings'));
  const page=await browser.get(expiry.path).expect(200);
  assert.match(page.text,/M-EARLY/);assert.match(page.text,new RegExp('Ship 4 to '+soon.orderNumber));assert.match(page.text,/Move up to 2 to Shop/);
  assert.match(page.text,/Discount them with a clearance plan/);assert.match(page.text,/Emails wait: StockChief is watching/);
  assert.match(page.text,/href="\/autopilot\/reviews\/clearance-plan\?filter=MILK"/,'Starter clearance is a suggestion.');
  const listed=await reviews.run(db,ctx,'expiring-lots',{filter:'MILK'});
  assert.deepEqual(listed.rows.map(r=>[r.Lot,r.Priority]),[['M-OLD','Expired'],['M-EARLY',soon.orderNumber]]);

  // Replaying the routine adds nothing.
  await sweep();
  assert.equal(await count("SELECT count(*) FROM stockchief_runtime.agent_expiry_warnings WHERE workspace_id=$1"),2);
  assert.equal(await audits('Expiry warnings raised'),1);

  // The owner's days: category, then the product's own days win.
  await assert.rejects(expiry.configure(db,ctx,{scope:'CATEGORY',category:'Bakery',days:'45'}),/No product has that category/);
  await assert.rejects(expiry.configure(db,ctx,{scope:'ITEM',sku:'NOPE',days:'45'}),/exact item code/);
  await assert.rejects(expiry.configure(db,ctx,{scope:'ALL',days:'0'}),/from 1 to 3,650/);
  await expiry.configure(db,ctx,{scope:'CATEGORY',category:' dairy ',days:'45'});
  await sweep();
  assert.equal((await warning('C-1')).warning_days,45);
  const cheeseRule=await expiry.configure(db,ctx,{scope:'ITEM',sku:'cheese',days:'20'});assert.equal(cheeseRule.saved,true);
  await sweep();
  assert.equal((await warning('C-1')).status,'CLEARED','The product window (20 days) wins over its category (45).');
  assert.equal((await warning('M-EARLY')).warning_days,45);
  assert.equal(await audits('Expiry warning days saved'),2);
  // Starter allows five saved rules across the account.
  await expiry.configure(db,ctx,{scope:'ALL',days:'15'});
  await expiry.configure(db,ctx,{scope:'ITEM',sku:'MILK',days:'30'});
  await expiry.configure(db,ctx,{scope:'ITEM',sku:f.item.skuIds.length&&(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,days:'10'});
  const spare=await item('SPARE','Dairy');
  await assert.rejects(expiry.configure(db,ctx,{scope:'ITEM',sku:'SPARE',days:'10'}),/5 active rules/);
  assert(spare);
  const fixtureRule=(await db.query("SELECT id,revision FROM stockchief_runtime.agent_expiry_warning_rules WHERE workspace_id=$1 AND warning_days=10",[ws])).rows[0];
  await assert.rejects(expiry.configure(db,ctx,{scope:'ITEM',sku:(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,stop:'yes',revision:String(fixtureRule.revision+1)}),/Reload the page/);
  await expiry.configure(db,ctx,{scope:'ITEM',sku:(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code,stop:'yes',revision:String(fixtureRule.revision)});
  assert.equal(await audits('Expiry warning days removed'),1);
  await expiry.configure(db,ctx,{scope:'ITEM',sku:'SPARE',days:'10'});

  // Shadow mode is over: one email covers every new warning, from the
  // connected mailbox to the owner, on Starter too.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await sweep();
  early=await warning('M-EARLY');
  assert(early.email_communication_id,'The email is queued. '+early.email_note);
  assert.equal((await warning('M-OLD')).email_communication_id,early.email_communication_id);
  assert.equal(await audits('Expiry warning email queued'),1);
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
  const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
  await mail.executeSendEffect(db,ws,await effect(early.email_communication_id),{provider});
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,f.email);
  assert.match(sent[0].subject,/batches expire soon/);assert.match(sent[0].body,new RegExp('Ship 4 to '+soon.orderNumber));assert.match(sent[0].body,/batch M-OLD at Dispatch: 1 unit expired on/);assert.match(sent[0].body,/6 units expire on/);
  await sweep();await sweep();
  assert.equal(await audits('Expiry warning email queued'),1,'Replays never email again.');
  assert.match((await browser.get(expiry.path).expect(200)).text,/Emailed to you/);
  await subscribe('growth');
  assert.match((await browser.get(expiry.path).expect(200)).text,/href="\/autopilot\/clearance-plans\/new\?sku=MILK"/,'Growth can build the clearance plan.');

  // Pause, watch mode, Watch only and Ask me first stop the email, never the warning.
  const fresh=async lot=>{await stock(MILK,lot,day(3),1);await sweep();return warning(lot);};
  await autopilot.pause(db,ctx,{role:'owner'},'Stock count');
  let w=await fresh('M-P');assert.equal(w.status,'OPEN');assert.match(w.email_note,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,191,{mode:'watch',revision:0});
  w=await fresh('M-W');assert.match(w.email_note,/Watch only/);
  await modes.save(db,ctx,191,{mode:'ask',revision:1});
  w=await fresh('M-A');assert.match(w.email_note,/Ask me first/);
  await modes.save(db,ctx,191,{mode:'inherit',revision:2});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  w=await fresh('M-O');assert.match(w.email_note,/watch-only/);
  await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  // A warning handled before the email goes out is not emailed.
  await sweep();
  const held=await warning('M-P');assert(held.email_communication_id);
  for(const lot of ['M-P','M-W','M-A','M-O'])await expiry.handle(db,ctx,(await warning(lot)).id,{confirmed:'yes'});
  // The same email also covers M-EARLY? No: M-EARLY was already emailed, so only the four new batches were in it.
  const second=(await db.query('SELECT body FROM customer_communications WHERE workspace_id=$1 AND id=$2',[ws,held.email_communication_id])).rows[0];
  assert.doesNotMatch(second.body,/M-EARLY/);
  await assert.rejects(mail.executeSendEffect(db,ws,await effect(held.email_communication_id),{provider}),/handled or cleared/);
  assert.equal(sent.length,1);

  // Pro and Custom work the same way: alone.
  for(const plan of ['pro','enterprise']){
    await subscribe(plan);
    w=await fresh('M-'+plan);assert.equal(w.status,'OPEN');assert(w.email_communication_id,plan);
    assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===191).allowed,['inherit','watch','ask','routine']);
  }
  assert.deepEqual((await (async()=>{await subscribe('starter');return modes.page(db,ctx);})()).find(x=>x.id===191).allowed,['inherit','watch','ask']);
  await subscribe('growth');

  // Picks with no batch named take the soonest unexpired, unrecalled batch.
  await workflows.fulfillSalesOrder(db,ctx,soon.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:soon.lineIds[0],locationId:location.id,quantity:4}]});
  const threeDay=['M-P','M-W','M-A','M-O','M-pro','M-enterprise'];let left3=0;for(const lot of threeDay)left3+=await lotUnits(lot);
  assert.deepEqual([await lotUnits('M-OLD'),left3,await lotUnits('M-EARLY'),await lotUnits('M-LATE')],[1,2,6,5],
    'The expired batch stays; the six one-unit batches expiring in 3 days go first, before the one expiring in 10.');
  await sweep();
  early=await warning('M-EARLY');
  assert.equal(Number(early.units),6);assert.deepEqual(early.plan.orders,[]);
  for(const lot of threeDay.slice(0,4))if(await lotUnits(lot))assert.equal((await warning(lot)).status,'HANDLED','A handled warning is not raised again.');
  // Writing off the expired batch clears its warning.
  await require('../../src/accounting/postgres-stock-removal').issue(db,ctx,{skuId:MILK,locationId:location.id,quantity:1,lotCode:'M-OLD',reasonCode:'expired',idempotencyKey:randomUUID()});
  await sweep();
  assert.equal((await warning('M-OLD')).status,'CLEARED');
  // Handling is replay safe and only for the owner.
  const handled=await expiry.handle(db,ctx,early.id,{confirmed:'yes'});assert.equal(handled.handled,true);
  assert.equal((await expiry.handle(db,ctx,early.id,{confirmed:'yes'})).replayed,true);
  const stranger=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Another inventory',
    email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  await assert.rejects(expiry.page(db,{workspaceId:ws,actorId:stranger.userId}),/owner/);
  assert.ok(later);

  // The page reads well on a desktop and on a 390 px phone.
  await stock(CHEESE,'C-2',day(2),2);await sweep();
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+expiry.path);
    assert(await tab.getByRole('heading',{name:'Expiring stock',exact:true}).isVisible());
    assert(await tab.getByRole('button',{name:'Mark as dealt with'}).first().isVisible());
    assert(await tab.getByRole('heading',{name:'How early to warn'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'expiring-stock-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
