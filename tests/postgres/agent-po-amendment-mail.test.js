'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('trusted connected supplier email keeps its original thread and requires source-specific current authority',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx,po,service}=f;
  await f.subscribe('enterprise');
  const connector=randomUUID(),thread='sent-'+randomUUID(),supplier='delivery@example.test';
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,
    status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Purchasing mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'mailbox-original',now(),now())`,
  [connector,ctx.workspaceId,ctx.actorId]);
  await db.query(`INSERT INTO supplier_communications(id,workspace_id,supplier_id,purchase_order_id,recipient,subject,body,
    status,connector_id,external_message_id,external_thread_id,idempotency_key,created_at,updated_at,sent_at)
    VALUES($1,$2,'fixture-supplier',$3,$4,'Original PO','Original reviewed terms','SENT',$5,'outgoing-reference',$6,$7,now(),now(),now()-interval '1 minute')`,
  [randomUUID(),ctx.workspaceId,po.purchaseOrderId,supplier,connector,thread,randomUUID()]);
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  const title='Re: PO change '+po.poNumber,mail=require('../../src/connections/postgres-mail');
  const capture=(price,extra={})=>mail.capture(db,{id:connector,workspace_id:ctx.workspaceId,provider_type:'gmail'},
    {messageId:randomUUID(),externalThreadId:thread,sender:supplier,subject:title,receivedAt:new Date().toISOString(),
      bodyText:['Currency: USD','SKU | Stock unit | Remaining quantity | Unit price | Price basis',
        [code,'unit','12',price,'stock'].join(' | ')].join('\n'),...extra});
  const queue=require('../../src/operations/postgres-job-queue');
  const kinds=require('../../src/operations/postgres-runtime-handlers').create();
  const intake=require('../../src/purchasing/po-amendment-email');
  const worker=kind=>queue.processOne(db,{[kind]:kinds[kind]},{owner:'supplier-amendment-mail-test'});
  const received=await capture('0.95'),first=await worker(intake.kind);
  assert.equal(first.status,'COMPLETED',JSON.stringify(first.lastError));
  assert(first.result.id,JSON.stringify(first.result));
  const preview=await service.preview(db,ctx,first.result.id);
  assert.equal(preview.facts.mailSource.id,received.messageId);
  assert.equal(preview.facts.amendments[0].remaining.price,95);
  const page=await f.browser.get('/autopilot/po-delivery-dates/'+first.result.id).expect(200);
  assert.match(page.text,/Open original supplier email/);
  const inbox=await f.browser.get('/mail/'+received.messageId).expect(200);
  assert.match(inbox.text,/Review supplier purchase changes/);
  const repeated=await f.browser.post('/mail/'+received.messageId+'/purchase-changes').type('form')
    .send({_csrf:f.csrf(inbox.text)}).expect(303);
  assert.equal(repeated.headers.location,'/autopilot/po-delivery-dates/'+first.result.id);
  await service.configure(db,ctx,first.result.id,{...f.caps,maximumQuantityPercent:'10',maximumPricePercent:'10',
    maximumOrderIncrease:'0',confirmed:'yes',revision:0});
  assert.equal((await worker(service.jobKind)).result.held,true);
  await capture('$0.92');
  const second=await worker(intake.kind);
  assert(second.result.id,JSON.stringify(second.result));
  assert.equal((await worker(service.jobKind)).result.changed,true);
  assert.equal((await service.saved(db,ctx.workspaceId,second.result.id)).automatic,true);
  assert.equal((await db.query('SELECT unit_cost::text AS cost FROM purchase_order_lines WHERE id=$1',[po.lineIds[0]])).rows[0].cost,'0.92');
  assert.equal((await intake.onArrival(db,ctx.workspaceId,received.messageId)).replayed,true);

  await capture('0.90');
  const third=await worker(intake.kind);
  assert(third.result.id);
  await db.query("UPDATE workspace_connectors SET provider_account_id='mailbox-replaced' WHERE id=$1",[connector]);
  const held=await worker(service.jobKind);
  assert.match(held.result.reason,/approved mailbox changed/);
  assert.equal((await db.query('SELECT unit_cost::text AS cost FROM purchase_order_lines WHERE id=$1',[po.lineIds[0]])).rows[0].cost,'0.92');
  const unrelated=await capture('0.70',{externalThreadId:'unrelated-'+thread});
  assert.equal(await worker(intake.kind),null);
  assert.match((await intake.onArrival(db,ctx.workspaceId,unrelated.messageId)).reason,/original mail thread/);
  await f.subscribe('growth');
  const lower=await capture('0.70');
  assert.equal(await worker(intake.kind),null);
  assert.match((await intake.onArrival(db,ctx.workspaceId,lower.messageId)).reason,/Pro/);
  const locked=await f.browser.get('/mail/'+lower.messageId).expect(200);
  assert.doesNotMatch(locked.text,/action="\/mail\/[^"]+\/purchase-changes"/);
  assert.match(locked.text,/Supplier purchase changes/);
  await f.browser.post('/mail/'+lower.messageId+'/purchase-changes').set('Accept','application/json')
    .type('form').send({_csrf:f.csrf(locked.text)}).expect(402);
  assert.equal(await f.balance(),4);
});
