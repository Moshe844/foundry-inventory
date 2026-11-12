'use strict';
process.env.NODE_ENV='test';
// Job 68: accepted preorders hold their claim on incoming stock. When a person
// posts the receipt, the arrived units are set aside for the preorders in claim
// order; once a preorder's units are all here it is filled: the order is
// confirmed on that stock and sent to picking. Growth approves the acceptance
// and the fill; Pro and Custom fill alone. Less incoming stock flags the
// preorders affected and the owner can tell the customer.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const fills=require('../../src/sales/agent-preorder-fills');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');

async function setup(t,plan='pro'){
  const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t),{db,ctx,service,workflows}=f;
  const ws=ctx.workspaceId;
  // The customer already has a confirmed shipping order to this address, so it is known.
  const known=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',shipToAddress:'10 Jobsite Rd, Albany, NY 12207',
    fulfillmentLocationId:f.location.id,currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:f.skuId,quantity:1}]});
  await workflows.confirmSalesOrder(db,ctx,known.salesOrderId,{idempotencyKey:randomUUID()});
  await f.subscribe(plan);
  const today=await require('../../src/lib/business-time').today(db,ws),expectedDate=require('../../src/accounting/customer-money').addDays(today,4);
  async function incoming(quantity){
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate,idempotencyKey:randomUUID(),
      lines:[{skuId:f.skuId,quantityUnits:quantity,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    return {...po,number:(await db.query('SELECT po_number FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0].po_number};
  }
  const receive=(po,quantity)=>workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reference:'ARRIVAL-'+randomUUID().slice(0,6),
    lines:[{lineId:po.lineIds[0],locationId:f.location.id,quantity}]});
  const page=(po,extra={})=>f.publish({preorderOrder:po.number,deliveryMethod:'SHIP',label:'Preorder '+randomUUID().slice(0,6),...extra});
  const request=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_customer_page_requests WHERE id=$1',[id])).rows[0];
  const order=async id=>(await db.query(`SELECT o.status,coalesce((SELECT sum(a.quantity) FROM sales_order_lines l JOIN sales_order_allocations a ON a.workspace_id=l.workspace_id AND a.sales_order_line_id=l.id
    WHERE l.workspace_id=o.workspace_id AND l.sales_order_id=o.id),0)::int held,(SELECT count(*)::int FROM sales_shipments h WHERE h.workspace_id=o.workspace_id AND h.sales_order_id=o.id AND h.status='PICKING') picking
    FROM sales_orders o WHERE o.workspace_id=$1 AND o.id=$2`,[ws,(await request(id)).sales_order_id])).rows[0];
  const free=async()=>(await require('../../src/domain/postgres-stock-availability').read(db,ws,f.skuId,f.location.id)).available;
  const rows=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_preorder_fills WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async(job,value)=>{const r=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ws,job])).rows[0];await modes.save(db,ctx,job,{mode:value,revision:r?.revision||0});};
  const settle=()=>service.settlePreorders(db,ws);
  return {...f,ws,incoming,receive,page,request,order,free,rows,audits,mode,settle};
}

test('Starter is locked out; Growth approves the acceptance and the fill; arrived units are held for the preorder, then reserved and sent to picking',{timeout:400000},async t=>{
  const f=await setup(t,'starter'),{db,ctx,service,browser}=f;
  const po=await f.incoming(15);
  assert.match((await browser.get(fills.href).expect(200)).text,/Growth/);
  await assert.rejects(f.page(po),e=>e.code==='entitlement_required');
  assert.deepEqual(await f.settle(),{reserved:0,held:0,drafted:0,released:0,flagged:0});

  await f.subscribe('growth');
  const growth=await f.page(po);
  const sent=await f.send(growth,{quantity:3});
  assert.equal((await service.onRequest(db,f.ws,sent.id,ctx.actorId,{preorder:true})).held,true,'Growth never accepts a preorder on its own.');
  await f.manual(sent.id);
  assert.equal((await f.order(sent.id)).status,'DRAFT');

  // A regular order confirmed later must not take the units this preorder claimed.
  const before=await f.free();
  const rival=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    currency:'USD',idempotencyKey:randomUUID(),lines:[{skuId:f.skuId,quantity:before+14}]});
  await f.workflows.confirmSalesOrder(db,ctx,rival.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal(await f.free(),0);
  await f.receive(po,15);
  assert.equal((await f.order(sent.id)).held,3,'The posted receipt sets the claimed units aside on the preorder.');
  assert.equal(await f.free(),12);
  await f.workflows.confirmSalesOrder(db,ctx,rival.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal(await f.free(),0);
  assert.equal((await f.order(sent.id)).held,3,'A later order cannot take held preorder stock.');

  // Growth prepares the fill for approval; nothing is confirmed or picked first.
  let result=await f.settle();
  assert.equal(result.drafted,1);assert.equal(result.reserved,0);
  const [draft]=await f.rows("status='DRAFT'");
  assert.match(draft.reason,/approval/);
  assert.equal((await f.order(sent.id)).status,'DRAFT');
  assert.equal((await f.settle()).drafted,0,'An unchanged fill is prepared once.');
  const need=(await fills.inbox(db,f.ws)).find(r=>r.sourceId==='preorder-fill:'+draft.id);
  assert.match(need.title,/Fill preorder/);
  const filled=await fills.approve(db,ctx,draft.id,{confirmed:'yes'});
  assert.ok(filled.shipmentId);
  assert.deepEqual(await f.order(sent.id),{status:'CONFIRMED',held:3,picking:1});
  assert.equal((await fills.approve(db,ctx,draft.id,{confirmed:'yes'})).replayed,true);
  assert.equal(await f.audits('Approved filling a preorder from arrived stock'),1);
  assert.equal((await db.query('SELECT count(*)::int n FROM accounting_customer_invoices WHERE workspace_id=$1',[f.ws])).rows[0].n,0);

  // Undo takes the order back from picking; the stock stays with the customer.
  await fills.undo(db,ctx,draft.id,{confirmed:'yes'});
  assert.deepEqual(await f.order(sent.id),{status:'CONFIRMED',held:3,picking:0});
  assert.equal(await f.audits('Took a filled preorder back from picking'),1);
});

test('Pro and Custom fill alone in claim order within the incoming quantity, and every stop keeps the fill for approval or only watches',{timeout:400000},async t=>{
  const f=await setup(t),{db,ctx,service}=f;
  const po=await f.incoming(6);
  const pro=await f.page(po);
  await service.configure(db,ctx,pro.id,{revision:1,confirmed:'yes'});
  const first=await f.send(pro,{quantity:4});
  await assert.rejects(f.send(pro,{quantity:5}),/enough incoming stock/,'A preorder never claims more than is coming.');
  const second=await f.send(pro,{quantity:2});
  for(const r of [first,second])assert.equal((await service.onRequest(db,f.ws,r.id,ctx.actorId,{preorder:true})).automatic,true);

  // Four arrive: the earlier claim is filled first; the later one waits with nothing held.
  await f.receive(po,4);
  assert.equal((await f.order(first.id)).held,4);assert.equal((await f.order(second.id)).held,0);
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const kind=service.arrivalKind;
  const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'preorder-arrival',kinds:[kind]});
  assert.equal(r.status,'COMPLETED',JSON.stringify(r.lastError));
  assert.deepEqual(await f.order(first.id),{status:'CONFIRMED',held:4,picking:1});
  assert.deepEqual(await f.order(second.id),{status:'DRAFT',held:0,picking:0});
  const [auto]=await f.rows("status='FILLED'");
  assert.equal(auto.authorization_kind,'AUTOMATIC');
  assert.equal(await f.audits('Reserved arrived stock for accepted preorder'),1);
  assert.deepEqual(await f.settle(),{reserved:0,held:0,drafted:0,released:0,flagged:0},'Replaying the routine changes nothing.');

  // Ask me first, pause, Watch only and shadow mode never fill on their own.
  await f.receive(po,2);
  assert.equal((await f.order(second.id)).held,2);
  await f.mode(68,'ask');
  assert.equal((await f.settle()).drafted,1);
  let [draft]=await f.rows("status='DRAFT'");assert.match(draft.reason,/Ask me first/);
  await f.mode(68,'watch');
  assert.equal((await f.settle()).drafted,0);
  await f.mode(68,'inherit');
  await autopilot.pause(db,ctx,{role:'owner'},'Owner is reviewing');
  await f.settle();[draft]=await f.rows("status='DRAFT'");assert.match(draft.reason,/paused/i);
  await autopilot.resume(db,ctx,{role:'owner'});
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await f.settle()).reserved,0);
  await assert.rejects(fills.approve(db,ctx,draft.id,{confirmed:'yes'}),/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal((await f.order(second.id)).status,'DRAFT');

  // Custom fills on its own as well, using the open draft once nothing stops it.
  await f.subscribe('enterprise');
  assert.equal((await f.settle()).reserved,1);
  assert.deepEqual(await f.order(second.id),{status:'CONFIRMED',held:2,picking:1});
  assert.equal((await f.rows("status='FILLED'")).length,2);
  // A downgrade to Starter stops all preorder work.
  await f.subscribe('starter');
  assert.deepEqual(await f.settle(),{reserved:0,held:0,drafted:0,released:0,flagged:0});
});

test('Less incoming stock flags the preorders affected in claim order, and the owner can tell the customer',{timeout:400000},async t=>{
  const f=await setup(t),{db,ctx,service}=f;
  const po=await f.incoming(10);
  const pro=await f.page(po);
  await service.configure(db,ctx,pro.id,{revision:1,confirmed:'yes'});
  const first=await f.send(pro,{quantity:6}),second=await f.send(pro,{quantity:4});
  for(const r of [first,second])await service.onRequest(db,f.ws,r.id,ctx.actorId,{preorder:true});
  await f.receive(po,5);
  assert.equal((await f.order(first.id)).held,5);
  assert.equal((await f.settle()).flagged,0,'Stock still on its way is not a shortfall.');

  // The supplier reports the goods unavailable: both preorders are flagged until that is cleared.
  await db.query("UPDATE purchase_order_lines SET supplier_supply_hold_id='notice-1',supplier_supply_hold_at=now() WHERE id=$1",[po.lineIds[0]]);
  assert.equal((await f.settle()).flagged,2);
  assert.match((await f.request(first.id)).problem,/reported these goods unavailable/);
  await db.query("UPDATE purchase_order_lines SET supplier_supply_hold_id=NULL,supplier_supply_hold_at=NULL WHERE id=$1",[po.lineIds[0]]);
  assert.equal((await f.settle()).flagged,0);
  assert.equal((await f.request(first.id)).problem,null,'The flag clears once the stock is coming again.');

  // The rest of the purchase order is cancelled: both preorders are now short.
  await f.workflows.cancelPurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Supplier cannot deliver'});
  const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const check=await jobs.processOne(db,{[fills.CHECK]:handlers[fills.CHECK]},{owner:'preorder-check',kinds:[fills.CHECK]});
  assert.equal(check.status,'COMPLETED',JSON.stringify(check.lastError));
  const shorts=(await db.query('SELECT request_id,short_quantity::int short,cause FROM stockchief_runtime.agent_preorder_shortfalls WHERE workspace_id=$1 AND resolved_at IS NULL ORDER BY short_quantity',[f.ws])).rows;
  assert.deepEqual(shorts.map(s=>[s.request_id,s.short]),[[first.id,1],[second.id,4]]);
  assert.match(shorts[0].cause,/was cancelled/);
  assert.match((await f.request(second.id)).problem,/Less stock is coming/);
  assert.equal(await f.audits('Flagged a preorder because less stock is coming'),4);
  assert.equal((await f.settle()).flagged,0,'An unchanged shortfall is flagged once.');
  const needs=(await fills.inbox(db,f.ws)).filter(r=>r.sourceId.startsWith('preorder-short:'));
  assert.equal(needs.length,2);

  // The owner tells the customer through a connected mailbox.
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Sales mailbox','gmail','[]','{}','connected','["MAIL_SEND","MAIL_READ"]',$3,'CONNECTED',$4,'sales@example.test',now(),now())`,[connector,f.ws,'connection_credentials:'+connector,ctx.actorId]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,f.ws,connector,'provider',{accessToken:'synthetic-preorder-token'}));
  await assert.rejects(fills.tell(db,ctx,second.id,{connectorId:connector}),/Confirm/);
  await fills.tell(db,ctx,second.id,{connectorId:connector,confirmed:'yes'});
  assert.equal((await fills.tell(db,ctx,second.id,{connectorId:connector,confirmed:'yes'})).replayed,true);
  const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'preorder-note-'+message.id};}};
  const mail=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider});
  for(let i=0;i<5;i++){const done=await jobs.processOne(db,{'provider.effect':mail['provider.effect']},{owner:'preorder-mail',kinds:['provider.effect']});if(!done)break;}
  assert.equal(sent.length,1);assert.equal(sent[0].recipient,'receiver@example.test');assert.match(sent[0].body,/4 × /);
  assert.equal((await fills.inbox(db,f.ws)).filter(r=>r.sourceId==='preorder-short:'+second.id).length,0,'A customer who was told leaves Needs you.');

  // A cancelled preorder order resolves its flag.
  await f.workflows.cancelSalesOrder(db,ctx,(await f.request(second.id)).sales_order_id,{idempotencyKey:randomUUID(),reason:'Customer cancelled'});
  await f.settle();
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_preorder_shortfalls WHERE workspace_id=$1 AND resolved_at IS NULL',[f.ws])).rows[0].n,1);
  assert.equal((await f.request(second.id)).problem,null);
});

test('The preorders page reads well on a desktop and on a 390 px phone',{timeout:300000},async t=>{
  const f=await setup(t,'growth'),{db,ctx}=f;
  const po=await f.incoming(8),growth=await f.page(po);
  const a=await f.send(growth,{quantity:3}),b=await f.send(growth,{quantity:5});
  await f.manual(a.id);await f.manual(b.id);
  await f.receive(po,4);
  await f.settle();
  await f.workflows.cancelPurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),reason:'Supplier cannot deliver'});
  await f.settle();
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const page=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});page.setDefaultTimeout(15000);
    await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);
    await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await page.goto(base+'/autopilot/reviews/preorders');
    assert(await page.getByRole('heading',{name:'Preorders',exact:true}).isVisible());
    assert(await page.getByRole('heading',{name:'Ready to fill'}).isVisible());
    assert(await page.getByRole('heading',{name:'Less stock is coming'}).isVisible());
    const text=await page.locator('main').innerText();
    assert.match(text,/3 of 3 × /);assert.match(text,/1 of 5 × /);assert.match(text,/was cancelled/);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await page.screenshot({path:require('node:path').join(folder,'preorders-'+name+'.png'),fullPage:true});
    if(phone){
      await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve and fill'}).click()]);
      assert.match(await page.locator('main').innerText(),/Recent fills/);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    await page.close();
  }
  assert.equal((await f.order(a.id)).status,'CONFIRMED');
});
