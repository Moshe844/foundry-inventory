'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('original supplier mail excludes exact warehouse lines without training and preserves newer evidence and plan limits',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,workflows}=f;
  const catalog=require('../../src/domain/postgres-catalog-service');
  const alpha=await catalog.createItem(db,ctx,{name:'First ordered part',baseCode:'FIRST-MAIL-PART',trackingMode:'quantity'});
  const beta=await catalog.createItem(db,ctx,{name:'Second ordered part',baseCode:'SECOND-MAIL-PART',trackingMode:'quantity'});
  const skuIds=[alpha.skuIds[0],beta.skuIds[0],f.item.skuIds[0]];
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate:f.date(2),
    idempotencyKey:randomUUID(),lines:skuIds.map((skuId,index)=>({skuId,quantityUnits:10-index,unitCost:1}))});
  await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  const supplier='delivery@example.test',connector=randomUUID(),thread='original-'+randomUUID();
  const url=await db.transaction(c=>f.links.issue(c,ctx.workspaceId,order.purchaseOrderId,supplier,'https://stockchief.example.test'));
  const token=new URL(url).pathname.split('/').at(-1);
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,
    status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Purchasing mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'mailbox-original',now(),now())`,
  [connector,ctx.workspaceId,ctx.actorId]);
  await db.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,purchase_order_id,recipient,subject,body,
    status,connector_id,external_message_id,external_thread_id,idempotency_key,created_at,updated_at,sent_at)
    VALUES($1,$2,'fixture-supplier',$3,$4,'Original PO','Original reviewed terms','SENT',$5,'provider-outbound',$6,$7,now(),now(),now()-interval '1 minute')`,
  [randomUUID(),ctx.workspaceId,order.purchaseOrderId,supplier,connector,thread,randomUUID()]);
  const subject='Re: PO availability update '+order.poNumber;
  const body=['Unavailable through: '+f.date(4),'SKU: FIRST-MAIL-PART','SKU: SECOND-MAIL-PART',
    'Reason: Production will not finish the two requested parts this week.',
    '> SKU: DO-NOT-MATCH-QUOTED-HISTORY'].join('\n');
  const mail=require('../../src/connections/postgres-mail');
  const capture=(overrides={})=>mail.capture(db,{id:connector,workspace_id:ctx.workspaceId,provider_type:'gmail'},
    {messageId:randomUUID(),externalThreadId:thread,sender:supplier,subject,receivedAt:new Date().toISOString(),bodyText:body,...overrides});
  const service=require('../../src/purchasing/supplier-unavailability-mail');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const worker=()=>queue.processOne(db,{[service.kind]:handlers[service.kind]},{owner:'supplier-unavailability-mail-test'});
  const holds=async()=>(await db.query('SELECT supplier_supply_hold_id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number',
    [ctx.workspaceId,order.purchaseOrderId])).rows.map(row=>row.supplier_supply_hold_id);

  await f.subscribe('starter');
  const locked=await capture();
  assert.equal(await worker(),null);
  assert.match((await service.onArrival(db,ctx.workspaceId,{messageId:locked.messageId,mailboxAccount:'mailbox-original'})).reason,/Growth/);
  assert.deepEqual(await holds(),[null,null,null]);
  await f.subscribe('growth');
  const captured=await capture();
  const job=await worker();
  assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
  assert.equal(job.result.noticeIds.length,2,JSON.stringify(job.result));
  const [first,second,untouched]=await holds();
  assert(first&&second&&first!==second);
  assert.equal(untouched,null);
  const receipts=await service.saved(db,ctx.workspaceId,captured.messageId);
  assert.equal(new Set(receipts.map(row=>row.supplier_reply_id)).size,1);
  assert.equal((await service.intake(db,ctx.workspaceId,{messageId:captured.messageId,mailboxAccount:'mailbox-original'})).replayed,true);
  assert.equal((await catalog.getItem(db,ctx.workspaceId,alpha.itemId)).onOrder,0);
  assert.equal((await catalog.getItem(db,ctx.workspaceId,beta.itemId)).onOrder,0);
  const page=await f.browser.get('/purchasing/orders/'+order.purchaseOrderId).expect(200);
  assert.match(page.text,/Open original supplier email/);
  assert.match(page.text,new RegExp('/mail/'+captured.messageId));
  assert.match(page.text,new RegExp('/supplier-availability/'+first+'/withdraw'));
  assert.match(page.text,new RegExp('/supplier-availability/'+second+'/withdraw'));
  await f.browser.post('/purchasing/orders/'+order.purchaseOrderId+'/supplier-availability/'+first+'/withdraw')
    .type('form').send({_csrf:f.csrf(page.text),confirmed:'yes'}).expect(303);
  assert.deepEqual(await holds(),[null,second,null]);
  await f.links.submit(db,token,'confirm',null);
  assert.deepEqual(await holds(),[null,null,null]);

  const changedMailbox=await capture();
  await db.query("UPDATE workspace_connectors SET provider_account_id='mailbox-replaced' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connector]);
  const blocked=await worker();
  assert.match(blocked.result.reason,/mailbox account changed/);
  assert.equal((await service.saved(db,ctx.workspaceId,changedMailbox.messageId)).length,0);
  await db.query("UPDATE workspace_connectors SET provider_account_id='mailbox-original' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connector]);
  await capture({externalThreadId:'unrelated-'+thread});
  assert.equal(await worker(),null);
  await capture({bodyText:body.replace('SECOND-MAIL-PART','MISSING-CODE')});
  assert.match((await worker()).result.reason,/one distinct open line/);
  assert.deepEqual(await holds(),[null,null,null]);

  const quote='We cannot supply the second requested part this week.';
  const freeForm=await capture({subject:'Re: Original PO',bodyText:quote+'\n\n> Previous quoted words are not a new statement.'});
  assert.equal(await worker(),null);
  const inbox=await f.browser.get('/mail/'+freeForm.messageId).expect(200);
  assert.match(inbox.text,/Review supplier availability/);
  const reviewPath='/mail/'+freeForm.messageId+'/supplier-availability';
  const view=await f.browser.get(reviewPath).expect(200);
  assert.match(view.text,/Second|SECOND-MAIL-PART/);
  const source=await service.review(db,ctx,freeForm.messageId);
  const reviewInput={lineIds:order.lineIds[1],validThrough:f.date(4),quote,fingerprint:source.fingerprint,confirmed:'yes'};
  await assert.rejects(service.recordReviewed(db,ctx,freeForm.messageId,{...reviewInput,quote:'Previous quoted words are not a new statement.'}),/current email body/);
  await f.subscribe('starter');
  await f.browser.post(reviewPath).set('Accept','application/json').type('form').send({_csrf:f.csrf(view.text),...reviewInput}).expect(402);
  await f.subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  const browser=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const origin='http://127.0.0.1:'+server.address().port;
  const errors=[];
  phone.on('pageerror',error=>errors.push(error.message));
  phone.setDefaultTimeout(15000);
  await phone.goto(origin+'/login');
  await phone.getByLabel('Work email').fill(f.email);
  await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(origin+'/mail/'+freeForm.messageId);
  await phone.getByRole('link',{name:'Review supplier availability',exact:true}).click();
  await phone.getByRole('checkbox',{name:/SECOND-MAIL-PART/}).check();
  await phone.getByLabel('Copy the supplier’s exact statement from the email above').fill(quote);
  await phone.getByLabel('Recheck the statement by').fill(f.date(4));
  await phone.locator('[name=confirmed]').check();
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Record supplier availability',exact:true}).click()]);
  assert.equal(new URL(phone.url()).pathname,'/purchasing/orders/'+order.purchaseOrderId);
  assert.deepEqual(errors,[]);
  const manual=await holds();
  assert(manual[1]);
  assert.equal(manual[0],null);
  const reviewed=(await db.query('SELECT recorded_by FROM stockchief_runtime.agent_backup_supplier_notices WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,manual[1]])).rows[0];
  assert.equal(reviewed.recorded_by,ctx.actorId);
  await f.links.submit(db,token,'confirm',null);
  await f.links.submit(db,token,'confirm',null);
  assert.deepEqual(await holds(),[null,null,null]);
  assert.equal((await f.links.responses(db,ctx.workspaceId,order.purchaseOrderId)).filter(row=>row.kind==='confirm').length,2);
  await db.query(`UPDATE stockchief_runtime.supplier_order_links SET expires_at=now()-interval '1 day'
    WHERE workspace_id=$1 AND purchase_order_id=$2`,[ctx.workspaceId,order.purchaseOrderId]);
  const oldLink=await capture({bodyText:body.replace('this week','next week')});
  const stored=await worker();
  assert.equal(stored.result.noticeIds.length,2,JSON.stringify(stored.result));
  assert.equal((await service.saved(db,ctx.workspaceId,oldLink.messageId)).length,2);
  assert((await holds())[0]);
  assert((await holds())[1]);
  assert.equal(await f.balance(),4);
});

test('the supplier email migration preserves previous signed notices and existing measured storage',{timeout:300000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{through:'349-agent-supplier-delivery-chases.sql'});
  const {db,ctx,workflows}=f;
  await f.subscribe('growth');
  const supplier='signed-before-mail@example.test';
  await db.query("UPDATE suppliers SET email=$2 WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId,supplier]);
  const day=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const expected=require('../../src/accounting/customer-money').addDays(day,4);
  const purchase=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate:expected,
    idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:5,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  const links=require('../../src/purchasing/supplier-order-link');
  const url=await db.transaction(c=>links.issue(c,ctx.workspaceId,purchase.purchaseOrderId,supplier,'https://stockchief.example.test'));
  const notice=await require('../../src/purchasing/agent-backup-suppliers').supplierReply(db,new URL(url).pathname.split('/').at(-1),{
    lineId:purchase.lineIds[0],validThrough:expected,reason:'The earlier signed report is original evidence.',confirmed:'yes'});
  const storage=require('../../src/commercial/storage-capacity');
  await storage.refresh(db,ctx.workspaceId);
  const bytes=await storage.state(db,f.owner.accountId);
  const migrate=require('../../src/db/migrate-postgres').migratePostgres;
  const upgrade={through:'350-agent-supplier-unavailability-mail.sql'};
  assert.deepEqual(await migrate(db,upgrade),[upgrade.through]);
  await storage.refresh(db,ctx.workspaceId);
  assert.equal(await storage.state(db,f.owner.accountId),bytes);
  assert.equal((await db.query('SELECT supplier_supply_hold_id FROM purchase_order_lines WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,purchase.lineIds[0]])).rows[0].supplier_supply_hold_id,notice.id);
  assert.deepEqual(await migrate(db,upgrade),[]);
});
