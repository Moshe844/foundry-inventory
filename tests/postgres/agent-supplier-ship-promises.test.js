'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const confirmations=require('../../src/purchasing/agent-supplier-ship-promises');
const links=require('../../src/purchasing/supplier-order-link');
const jobs=require('../../src/operations/postgres-job-queue');

test('ship confirmations preserve arrival promises and run under the exact current plan and teaching evidence',{timeout:300000},async t=>{
  const prior=process.env.FOUNDRY_PUBLIC_URL;
  process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=prior;});
  const f=await require('../helpers/agent-claim-fixture').fixture(t,'pro'),{db,ctx,workflows}=f;
  const day=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const date=days=>require('../../src/accounting/customer-money').addDays(day,days);
  const recipient='damage@example.test',supplierId='fixture-supplier';
  const rule={supplierId,expectedRecipient:recipient,connectorId:f.connectorId,maximumMessages:2,intervalHours:24,maximumShipDays:5,confirmed:'yes'};
  async function purchase(supplier=supplierId){
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:supplier,destinationLocationId:f.location.id,expectedDate:date(10),
      idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:4,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    return po;
  }
  const issue=async(po,email=recipient)=>new URL(await db.transaction(c=>links.issue(c,ctx.workspaceId,po.purchaseOrderId,email,process.env.FOUNDRY_PUBLIC_URL))).pathname;
  const responses=po=>links.responses(db,ctx.workspaceId,po.purchaseOrderId);
  const saved=po=>confirmations.recorded(db,ctx.workspaceId,po.purchaseOrderId);
  const handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider});
  const work=kind=>jobs.processOne(db,{[kind]:handlers[kind]},{owner:'supplier-confirmation-test-worker'});
  const dateJob=()=>work(confirmations.kind);

  const first=await purchase(),supplierPath=await issue(first);
  await db.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,purchase_order_id,recipient,subject,body,status,
    connector_id,external_message_id,idempotency_key,created_at,updated_at,sent_at)
    VALUES($1,$2,$3,$4,$5,'Purchase order','Please confirm receipt','SENT',$6,'accepted-original',$7,now(),now(),now()-interval '1 minute')`,
  [randomUUID(),ctx.workspaceId,supplierId,first.purchaseOrderId,recipient,f.connectorId,randomUUID()]);
  await f.subscribe('starter');
  const supplierPage=await f.browser.get(supplierPath).expect(200);
  assert.match(supplierPage.text,/Planned ship date when confirming/);
  await f.browser.post(supplierPath+'/respond').type('form')
    .send({_csrf:f.csrf(supplierPage.text),kind:'confirm',shipDate:date(1)}).expect(303);
  const original=(await responses(first)).find(reply=>reply.ship_date===date(1));
  assert(original);
  assert.equal(await dateJob(),null);
  const locked=await f.browser.get('/purchasing/orders/'+first.purchaseOrderId).expect(200);
  assert.match(locked.text,/Ship-date recording/);
  assert.doesNotMatch(locked.text,/Review ship date/);
  const sourcePath=confirmations.path+'/source/'+original.id;
  await f.browser.post(sourcePath).set('Accept','application/json').type('form')
    .send({_csrf:f.csrf(locked.text),confirmed:'yes',fingerprint:'forged'}).expect(402);

  await f.subscribe('growth');
  await assert.rejects(confirmations.configure(db,ctx,rule),/first record a matching supplier confirmation/);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port,errors=[];
  phone.on('pageerror',error=>errors.push(error.message));
  phone.setDefaultTimeout(15000);
  await phone.goto(origin+'/login');
  await phone.getByLabel('Work email').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(origin+sourcePath);
  assert.match(await phone.locator('main').innerText(),/Recorded warehouse arrival/);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await phone.locator('[name=confirmed]').check();
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Record supplier ship date',exact:true}).click()]);
  assert.deepEqual(errors,[]);
  assert.equal((await saved(first))[0].automatic,false);
  const settings=await f.browser.get(confirmations.path+'?sourceId='+original.id).expect(200);
  assert.match(settings.text,/Matching recorded example/);
  const authorized=await f.browser.post(confirmations.path).type('form')
    .send({_csrf:f.csrf(settings.text),...rule,exampleId:original.id}).expect(303);
  assert(authorized.headers.location.includes('/rules/'));

  const next=await purchase();
  await db.query("UPDATE purchase_orders SET ordered_at=(now()-interval '3 days')::text WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,next.purchaseOrderId]);
  const owner=require('../../src/operations/postgres-workflow-ownership');
  const item=(await db.query('SELECT id FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',
    [ctx.workspaceId,'business-outcome:purchase:'+next.purchaseOrderId])).rows[0];
  await owner.refresh(db,ctx.workspaceId,item.id);
  const delivered=await work('agent.mail.purchase_followup.v1');
  assert.equal(delivered?.status,'COMPLETED',JSON.stringify(delivered));
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].body,/planned ship date/);
  const replyToken=/\/supplier\/order\/([A-Za-z0-9_-]{43})/.exec(f.sent[0].body)[1];
  await links.submit(db,replyToken,'confirm',date(10),{shipDate:date(2)});
  const captured=await dateJob();
  assert.equal(captured.result.shipDate,date(2),JSON.stringify(captured.result));
  assert.equal((await saved(next))[0].automatic,true);
  assert.equal((await db.query('SELECT expected_date::text FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,next.purchaseOrderId])).rows[0].expected_date,date(10));
  const visible=await f.browser.get('/purchasing/orders/'+next.purchaseOrderId).expect(200);
  assert.match(visible.text,/Supplier-confirmed ship date/);
  await links.submit(db,replyToken,'confirm',date(10),{shipDate:date(9)});
  assert.match((await dateJob()).result.reason,/dates you authorized/);
  assert.equal((await saved(next))[0].ship_date,date(2));

  for(const plan of ['pro','enterprise']){
    await f.subscribe(plan);
    const email=plan+'-confirm@example.test';
    const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:plan+' confirmation supplier',email,currency:'USD'});
    await confirmations.configure(db,ctx,{...rule,supplierId:supplier.id,expectedRecipient:email});
    assert.equal((await confirmations.activeRule(db,ctx.workspaceId,supplier.id)).example_source_id,null);
    const current=await purchase(supplier.id),token=(await issue(current,email)).split('/').at(-1);
    await links.submit(db,token,'confirm',null,{shipDate:date(3)});
    assert.equal((await dateJob()).result.shipDate,date(3));
    assert.equal((await saved(current))[0].automatic,true);
  }
});
