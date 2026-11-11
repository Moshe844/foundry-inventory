'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mail=require('../../src/connections/postgres-mail');
const service=require('../../src/purchasing/supplier-ship-date-mail');
const confirmations=require('../../src/purchasing/agent-supplier-ship-promises');
const jobs=require('../../src/operations/postgres-job-queue');

test('records exact ship dates from original purchase and confirmation mail threads under the current plan and mailbox rule',{timeout:300000},async t=>{
  const prior=process.env.FOUNDRY_PUBLIC_URL;
  process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=prior;});
  const f=await require('../helpers/agent-claim-fixture').fixture(t,'growth'),{db,ctx,workflows,connectorId}=f;
  const day=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const date=days=>require('../../src/accounting/customer-money').addDays(day,days);
  const supplierId='fixture-supplier',sender='damage@example.test',mailbox='claims@example.test';
  const connector={id:connectorId,workspace_id:ctx.workspaceId,provider_type:'gmail'};
  const rule={supplierId,expectedRecipient:sender,connectorId,maximumMessages:2,intervalHours:24,maximumShipDays:5,confirmed:'yes'};
  const threadFor=po=>'fixture-thread-'+po.purchaseOrderId;
  const provider={send:async({message})=>({externalMessageId:'accepted-'+message.id,externalThreadId:'reminder-thread-'+message.purchase_order_id})};
  const handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>provider});
  const work=kind=>jobs.processOne(db,{[kind]:handlers[kind]},{owner:'supplier-ship-date-mail-test'});
  async function purchase({nativeMessage=true,supplier=supplierId,recipient=sender}={}){
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:supplier,destinationLocationId:f.location.id,expectedDate:date(10),
      idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:4,unitCost:1}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    if(nativeMessage)await db.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,purchase_order_id,recipient,subject,body,status,
      connector_id,external_message_id,external_thread_id,idempotency_key,created_at,updated_at,sent_at)
      VALUES($1,$2,$3,$4,$5,'Purchase order','Please confirm','SENT',$6,$7,$8,$9,now(),now(),now()-interval '1 minute')`,
    [randomUUID(),ctx.workspaceId,supplier,po.purchaseOrderId,recipient,connectorId,randomUUID(),threadFor(po),randomUUID()]);
    return po;
  }
  const capture=(po,extra={})=>mail.capture(db,connector,{messageId:randomUUID(),externalThreadId:threadFor(po),sender,
    subject:'Re: Purchase order '+po.poNumber,bodyText:`Confirmed\nPlanned ship date: ${date(2)}\n\n> Ship date: ${date(8)}`,
    receivedAt:new Date().toISOString(),...extra});
  const saved=po=>confirmations.recorded(db,ctx.workspaceId,po.purchaseOrderId);
  const original=await purchase();
  await f.subscribe('starter');
  const starter=await capture(original);
  assert.equal(await work(service.kind),null);
  assert.equal(await service.savedSource(db,ctx.workspaceId,starter.messageId),null);
  const locked=await f.browser.get('/mail/'+starter.messageId).expect(200);
  assert.match(locked.text,/Record supplier ship dates from email/);
  assert.doesNotMatch(locked.text,/Review supplier ship date/);

  await f.subscribe('growth');
  const accepted=await capture(original);
  const ingested=await work(service.kind);
  assert.equal(ingested.status,'COMPLETED',JSON.stringify(ingested));
  assert(ingested.result.sourceId,JSON.stringify(ingested.result));
  assert.match((await work(confirmations.kind)).result.reason,/record this exact original ship date/);
  const inbox=await f.browser.get('/mail/'+accepted.messageId).expect(200);
  const href=confirmations.path+'/source/'+ingested.result.sourceId;
  assert(inbox.text.includes(href));
  const source=await f.browser.get(href).expect(200);
  assert.match(source.text,/Open original supplier email/);
  const originalReview=await confirmations.review(db,ctx,ingested.result.sourceId);
  await f.browser.post(href).type('form').send({_csrf:f.csrf(source.text),confirmed:'yes',fingerprint:originalReview.reviewFingerprint}).expect(303);
  assert.equal((await saved(original))[0].ship_date,date(2));
  assert.equal((await service.intake(db,ctx.workspaceId,{messageId:accepted.messageId,mailboxAccount:mailbox})).replayed,true);
  await confirmations.configure(db,ctx,{...rule,exampleId:ingested.result.sourceId});

  const next=await purchase({nativeMessage:false});
  await db.query("UPDATE purchase_orders SET ordered_at=(now()-interval '3 days')::text WHERE workspace_id=$1 AND id=$2",
    [ctx.workspaceId,next.purchaseOrderId]);
  const item=(await db.query('SELECT id FROM work_items WHERE workspace_id=$1 AND idempotency_key=$2',
    [ctx.workspaceId,'business-outcome:purchase:'+next.purchaseOrderId])).rows[0];
  await require('../../src/operations/postgres-workflow-ownership').refresh(db,ctx.workspaceId,item.id);
  const sent=await work('agent.mail.purchase_followup.v1');
  assert.equal(sent?.status,'COMPLETED',JSON.stringify(sent));
  const message=(await db.query(`SELECT external_thread_id,body FROM supplier_communications
    WHERE workspace_id=$1 AND purchase_order_id=$2 AND status='SENT'`,[ctx.workspaceId,next.purchaseOrderId])).rows[0];
  assert(message.external_thread_id);
  assert.match(message.body,/Planned ship date: YYYY-MM-DD/);
  await capture(next,{externalThreadId:message.external_thread_id,subject:'Re: Please confirm '+next.poNumber});
  assert((await work(service.kind)).result.sourceId);
  const recorded=await work(confirmations.kind);
  assert.equal(recorded.result.shipDate,date(2),JSON.stringify(recorded.result));
  assert.equal((await saved(next))[0].automatic,true);
  assert.equal((await db.query('SELECT expected_date::text FROM purchase_orders WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,next.purchaseOrderId])).rows[0].expected_date,date(10));

  const third=await purchase();
  await capture(third,{bodyText:`Confirmed\nShip date: ${date(2)}\nShip date: ${date(3)}`});
  assert.match((await work(service.kind)).result.reason,/one planned ship date/);
  await capture(third,{externalThreadId:'unrelated-thread'});
  assert.equal(await work(service.kind),null);
  await capture(third);
  await db.query("UPDATE workspace_connectors SET provider_account_id='different-account' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,connectorId]);
  assert.match((await work(service.kind)).result.reason,/mailbox account changed/);
  assert.deepEqual(await saved(third),[]);
  await db.query('UPDATE workspace_connectors SET provider_account_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,connectorId,mailbox]);

  for(const plan of ['pro','enterprise']){
    await f.subscribe(plan);
    const recipient=plan+'-supplier@example.test';
    const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:plan+' test supplier',email:recipient,currency:'USD'});
    await confirmations.configure(db,ctx,{...rule,supplierId:supplier.id,expectedRecipient:recipient});
    assert.equal((await confirmations.activeRule(db,ctx.workspaceId,supplier.id)).example_source_id,null);
    const po=await purchase({supplier:supplier.id,recipient});
    await capture(po,{sender:recipient});
    assert((await work(service.kind)).result.sourceId);
    assert.equal((await work(confirmations.kind)).result.shipDate,date(2));
    assert.equal((await saved(po))[0].automatic,true);
  }
});
