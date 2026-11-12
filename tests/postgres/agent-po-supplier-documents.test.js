'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const evidence=require('../../src/purchasing/postgres-supplier-evidence');
const documents=require('../../src/purchasing/po-amendment-document');
const modes=require('../../src/autopilot/job-modes');

// Job 31 from saved supplier documents: a confirmation, backorder notice or
// price update from a trusted supplier message that changes a placed order
// goes through the native purchase-change review, limits and teaching.
async function setup(t){
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx}=f;
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,
    status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
    VALUES($1,$2,$1,'Purchasing mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'purchasing-mailbox',now(),now())`,
  [connector,ctx.workspaceId,ctx.actorId]);
  const connection={id:connector,workspace_id:ctx.workspaceId,provider_type:'gmail'},mail=require('../../src/connections/postgres-mail');
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const worker=kind=>queue.processOne(db,{[kind]:handlers[kind]},{owner:'supplier-document-test'});
  async function order(){
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      expectedDate:f.date(1),idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantityUnits:12,unitCost:1}]});
    await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    return {id:po.purchaseOrderId,number:po.poNumber,lineId:po.lineIds[0]};
  }
  async function send(o,{type='order_acknowledgement',quantity=12,price=100,date=null,currency='USD',plan=null}={}){
    const text=(type==='price_update'?'New price for ':'We confirm ')+o.number+': '+quantity+' units of '+code+' at '+currency+' '+
      (price/100).toFixed(2)+' each'+(date?', arriving '+date:'')+'.';
    const captured=await mail.capture(db,connection,{messageId:randomUUID(),sender:'delivery@example.test',subject:'About '+o.number,
      bodyText:text,receivedAt:new Date().toISOString()});
    if(plan)await f.subscribe(plan);
    const row=(await db.query('SELECT * FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,o.id])).rows[0];
    const prepared=await evidence.assess(db,ctx,row,{documentType:type,sourceMessageId:captured.messageId,evidenceQuote:text,currency,
      expectedArrivalDate:date,lines:[{sku:code,quantity,quantityBasis:'stock',unitCostMinor:price}]});
    const saved=await db.transaction(c=>evidence.execute(c,ctx,prepared.payload));
    return {...saved,messageId:captured.messageId};
  }
  const line=async lineId=>{const r=(await db.query('SELECT quantity_units::text q,quantity_received_units::text r,unit_cost::text c FROM purchase_order_lines WHERE id=$1',[lineId])).rows[0];return [Number(r.q),Number(r.r),Number(r.c)];};
  const lines=async o=>(await db.query(`SELECT quantity_units::text q,quantity_received_units::text r,unit_cost::text c FROM purchase_order_lines
    WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number`,[ctx.workspaceId,o.id])).rows.map(r=>[Number(r.q),Number(r.r),Number(r.c)]);
  const header=async o=>(await db.query('SELECT status,expected_date::text AS date,integrity_hash FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,o.id])).rows[0];
  const docStatus=async id=>(await db.query('SELECT status FROM supplier_documents WHERE id=$1',[id])).rows[0].status;
  // The saved document becomes a purchase-change source, then the native routine tries it.
  async function through(doc){
    const intake=await worker(documents.kind);
    assert.equal(intake?.status,'COMPLETED',JSON.stringify(intake?.lastError));
    if(!intake.result.id)return {intake:intake.result};
    const routine=await worker(f.service.jobKind);
    assert.equal(routine?.status,'COMPLETED',JSON.stringify(routine?.lastError));
    return {sourceId:intake.result.id,result:routine.result,doc};
  }
  const mode=async(job,value)=>{const row=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=$2',[ctx.workspaceId,job])).rows[0];await modes.save(db,ctx,job,{mode:value,revision:row?.revision||0});};
  const limits={...f.caps,maximumQuantityPercent:'25',maximumPricePercent:'15',maximumOrderIncrease:'5.00',confirmed:'yes'};
  return {...f,code,worker,order,send,line,lines,header,docStatus,through,mode,limits,connector};
}

test('Starter and Growth keep supplier documents for a person; Pro drafts until taught, then applies within limits',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx,service}=f;

  // Starter and Growth do not include this job: the document stays with a person.
  for(const plan of ['starter','growth']){
    await f.subscribe('pro');
    const o=await f.order();
    const doc=await f.send(o,{quantity:10,price:110,plan});
    assert.equal(doc.status,'NEEDS_REVIEW');
    assert.equal(await f.worker(documents.kind),null,plan+' queues no purchase change');
    assert.deepEqual(await documents.onDocument(db,ctx.workspaceId,doc.documentId),{skipped:'plan'});
    await assert.rejects(documents.intake(db,ctx.workspaceId,doc.documentId),e=>e.code==='entitlement_required');
    assert.deepEqual(await f.lines(o),[[12,0,1]]);
  }

  // Pro drafts: a confirmation that cuts the quantity, raises the price and
  // moves the date waits for the owner. Received goods keep their price.
  await f.subscribe('pro');
  const first=await f.order();
  await f.workflows.receivePurchaseOrder(db,ctx,first.id,{idempotencyKey:randomUUID(),lines:[{lineId:first.lineId,quantity:4,locationId:f.location.id}]});
  const before=await f.header(first);
  const doc=await f.send(first,{quantity:10,price:110,date:f.date(3)});
  assert.equal(doc.status,'NEEDS_REVIEW');
  const drafted=await f.through(doc);
  assert.equal(drafted.result.held,true);
  assert.match(drafted.result.reason,/owner-authorized/);
  assert.deepEqual(await f.lines(first),[[12,4,1]],'Nothing changes before the owner approves');
  const inbox=await service.inbox(db,ctx.workspaceId,ctx.actorId);
  assert(inbox.some(row=>row.href==='/autopilot/po-delivery-dates/'+drafted.sourceId&&/saved confirmation/.test(row.happened)));
  const page=await f.browser.get('/autopilot/po-delivery-dates/'+drafted.sourceId).expect(200);
  assert.match(page.text,/Open the supplier’s original message/);
  assert.match(page.text,new RegExp('/mail/'+doc.messageId));
  assert.match(page.text,/\$1\.10/);
  assert.equal((await f.approve(drafted.sourceId)).changed,true);
  assert.equal((await f.approve(drafted.sourceId)).replayed,true,'Approving twice changes nothing more');
  assert.deepEqual(await f.lines(first),[[4,4,1],[6,0,1.1]],'Received goods keep their line and price; the rest is due at the new price');
  const after=await f.header(first);
  assert.equal(after.date,f.date(3));
  assert.notEqual(after.integrity_hash,before.integrity_hash,'The order gets a new version');
  const history=(await db.query(`SELECT event FROM purchase_order_events WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY created_at,id`,
    [ctx.workspaceId,first.id])).rows.map(r=>r.event);
  assert(history.includes('supplier_purchase_amended')&&history.includes('supplier_delivery_date_updated'));
  assert.equal(await f.docStatus(doc.documentId),'MATCHED','The reviewed document now agrees with the order');
  assert((await db.query(`SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND action='Supplier purchase amendment reviewed' AND reference=$2`,
    [ctx.workspaceId,first.id])).rowCount);
  assert.equal((await documents.onDocument(db,ctx.workspaceId,doc.documentId)).replayed,true,'A replayed document makes no second source');

  // Pro learns after the approved example: owner limits and the taught rule.
  await service.configure(db,ctx,drafted.sourceId,{...f.limits,revision:0});
  await service.teach(db,ctx,drafted.sourceId,{...f.limits,revision:0});
  const second=await f.order();
  const routine=await f.through(await f.send(second,{quantity:11,price:105,date:f.date(3)}));
  assert.equal(routine.result.changed,true,JSON.stringify(routine.result));
  assert.equal((await service.saved(db,ctx.workspaceId,routine.sourceId)).automatic,true);
  assert.deepEqual(await f.lines(second),[[11,0,1.05]]);
  assert.equal((await f.header(second)).date,f.date(3));

  // Over the price limit waits for the owner.
  const third=await f.order();
  const over=await f.through(await f.send(third,{quantity:12,price:150}));
  assert.match(over.result.reason,/exceeds your authorized unit price change/);
  assert.deepEqual(await f.lines(third),[[12,0,1]]);

  // A price update document changes the price only.
  const fourth=await f.order();
  const priced=await f.through(await f.send(fourth,{type:'price_update',quantity:0,price:108}));
  assert.equal(priced.result.changed,true,JSON.stringify(priced.result));
  assert.deepEqual(await f.lines(fourth),[[12,0,1.08]]);

  // The owner's review of a held document reads well on a desktop and a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port;
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+'/autopilot/po-delivery-dates/'+over.sourceId);
    assert(await view.getByRole('link',{name:'Open the supplier’s original message'}).isVisible());
    assert.match(await view.locator('main').innerText(),/\$1\.50/);
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.close();
  }

  // Ask me first, pause and shadow keep each change for the owner.
  await f.mode(31,'ask');
  const asked=await f.order(),askedDoc=await f.through(await f.send(asked,{quantity:11,price:100}));
  assert.match(askedDoc.result.reason,/Ask me first/);
  assert.deepEqual(await f.lines(asked),[[12,0,1]]);
  await f.mode(31,'inherit');
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.pause(db,ctx,{role:'owner'},'Supplier review');
  const paused=await f.order(),pausedDoc=await f.through(await f.send(paused,{quantity:11,price:100}));
  assert.match(pausedDoc.result.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  const watched=await f.order(),watchedDoc=await f.through(await f.send(watched,{quantity:11,price:100}));
  assert.match(watchedDoc.result.reason,/watching/);
  assert.deepEqual(await f.lines(watched),[[12,0,1]]);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.deepEqual(await f.lines(paused),[[12,0,1]]);
});

test('Custom applies supplier documents within limits without teaching, and unclear documents stop and ask',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx,service}=f;
  await f.subscribe('enterprise');
  const example=await f.order();
  const first=await f.through(await f.send(example,{quantity:11,price:104}));
  assert.match(first.result.reason,/owner-authorized/);
  await service.configure(db,ctx,first.sourceId,{...f.limits,revision:0});
  assert.equal((await f.worker(service.jobKind)),null,'A source from before the owner’s authority is not retried on its own');
  const o=await f.order();
  const applied=await f.through(await f.send(o,{quantity:10,price:110,date:f.date(2)}));
  assert.equal(applied.result.changed,true,JSON.stringify(applied.result));
  assert.equal(applied.result.automatic,true);
  assert.deepEqual(await f.lines(o),[[10,0,1.1]]);
  assert.equal((await f.header(o)).date,f.date(2));
  assert.equal(await f.docStatus(applied.doc.documentId),'MATCHED');
  assert.equal((await documents.onDocument(db,ctx.workspaceId,applied.doc.documentId)).replayed,true);
  assert.equal(await f.worker(service.jobKind),null,'Replaying does nothing');

  // Over the quantity limit, or a date slip beyond the owner's days, waits.
  const big=await f.order(),bigCut=await f.through(await f.send(big,{quantity:6,price:100}));
  assert.match(bigCut.result.reason,/exceeds your authorized quantity/);
  const late=await f.order(),lateDate=await f.through(await f.send(late,{quantity:12,price:100,date:f.date(20)}));
  assert.match(lateDate.result.reason,/changes by 19 days/);
  assert.deepEqual(await f.lines(big),[[12,0,1]]);
  assert.equal((await f.header(late)).date,f.date(1));

  // Bad data stops and asks. Nothing reaches the order.
  const currency=await f.order(),euros=await f.send(currency,{quantity:12,price:110,currency:'EUR'});
  assert.match((await f.through(euros)).intake.reason,/different currency/);
  const reason=(await db.query('SELECT native_review_reason FROM connection_email_messages WHERE id=$1',[euros.messageId])).rows[0].native_review_reason;
  assert.match(reason,/different currency/);
  const short=await f.order();
  await f.workflows.receivePurchaseOrder(db,ctx,short.id,{idempotencyKey:randomUUID(),lines:[{lineId:short.lineId,quantity:4,locationId:f.location.id}]});
  assert.match((await f.through(await f.send(short,{quantity:2,price:100}))).intake.reason,/fewer units/);
  const changed=await f.order(),edited=await f.send(changed,{quantity:11,price:100});
  await db.query("UPDATE connection_email_messages SET content_hash='changed' WHERE id=$1",[edited.messageId]);
  assert.match((await f.through(edited)).intake.reason,/changed after the document was saved/);
  for(const o of [currency,short,changed])assert.equal((await f.lines(o)).length,1);
  assert.deepEqual(await f.lines(currency),[[12,0,1]]);

  // Watch only for this job keeps every change for a person.
  await f.mode(31,'watch');
  const watched=await f.order(),watchedDoc=await f.through(await f.send(watched,{quantity:11,price:100}));
  assert.match(watchedDoc.result.reason,/Watch only/);
  assert.deepEqual(await f.lines(watched),[[12,0,1]]);
});
