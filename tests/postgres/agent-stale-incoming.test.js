'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const stale=require('../../src/purchasing/agent-stale-incoming');
const modes=require('../../src/autopilot/job-modes');

// Job 32: late goods with no word from the supplier stop counting as incoming.
async function setup(t){
  const f=await require('../helpers/agent-po-date-fixture').fixture(t);
  const {db,ctx}=f,ws=ctx.workspaceId,sku=f.item.skuIds[0];
  async function order({due=-40,quantity=12,cost=1,receive=0}={}){
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,
      expectedDate:f.date(1),idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:quantity,unitCost:cost}]});
    await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    if(receive)await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
      lines:[{lineId:po.lineIds[0],quantity:receive,locationId:f.location.id}]});
    // The supplier promised this order long ago.
    await db.query('UPDATE purchase_orders SET expected_date=$3,ordered_at=$4 WHERE workspace_id=$1 AND id=$2',
      [ws,po.purchaseOrderId,f.date(due),f.date(due-10)+'T12:00:00.000Z']);
    return {id:po.purchaseOrderId,number:po.poNumber,lineId:po.lineIds[0]};
  }
  const lines=async o=>(await db.query(`SELECT quantity_units::text q,quantity_received_units::text r FROM purchase_order_lines
    WHERE workspace_id=$1 AND purchase_order_id=$2 ORDER BY line_number`,[ws,o.id])).rows.map(r=>[Number(r.q),Number(r.r)]);
  const status=async o=>(await db.query('SELECT status FROM purchase_orders WHERE workspace_id=$1 AND id=$2',[ws,o.id])).rows[0].status;
  const planning=require('../../src/forecasting/postgres-planning-service');
  const incoming=async()=>(await planning.position(db,ws,{onlySkuIds:[sku]})).reduce((n,row)=>n+Number(row.incoming),0);
  const onOrder=async()=>(await require('../../src/domain/postgres-catalog-service').getItem(db,ws,f.item.itemId)).onOrder;
  const closes=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_incoming_closes WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
  const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
  const mode=async value=>{const row=(await db.query('SELECT revision FROM stockchief_runtime.agent_job_modes WHERE workspace_id=$1 AND job_id=32',[ws])).rows[0];await modes.save(db,ctx,32,{mode:value,revision:row?.revision||0});};
  const rule=async(input={})=>stale.configure(db,ctx,{graceDays:'30',maxValue:'50.00',currency:'USD',automatic:'yes',confirmed:'yes',
    revision:(await stale.read(db,ws))?.revision||0,...input});
  const run=()=>stale.run(db,ws);
  const find=async o=>(await stale.late(db,ws,{grace:(await stale.read(db,ws))?.grace_days||30})).orders.find(row=>row.orderId===o.id);
  return {...f,ws,sku,order,lines,status,incoming,onOrder,closes,audits,mode,rule,run,find};
}

test('Starter lists late goods; Growth closes them on its own by the owner’s rule, keeps evidence-backed orders, and can reopen',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx}=f;
  const late=await f.order({receive:4}),waiting=await f.order({due:-10});
  // The supplier wrote last week: keep it.
  const heard=await f.order();
  const url=await db.transaction(c=>f.links.issue(c,f.ws,heard.id,'delivery@example.test','https://stockchief.example.test'));
  await f.links.submit(db,new URL(url).pathname.split('/').at(-1),'confirm',null);
  // A shipment is on the water: keep it.
  const shipped=await f.order();
  await db.query(`INSERT INTO stockchief_runtime.agent_inbound_freight(workspace_id,id,mode,reference_type,reference,forwarder,destination,status,eta,order_ids,authorized_by,maximum_shift_days)
    VALUES($1,$2,'ocean','container',$3,'Forwarder','Receiving','in_transit',$4,$5,$6,3)`,[f.ws,randomUUID(),'CONT'+Date.now(),f.date(5),JSON.stringify([shipped.id]),ctx.actorId]);
  // Goods for this order are being checked in: keep it.
  const arriving=await f.order();
  await db.query(`INSERT INTO stockchief_runtime.agent_delivery_comparisons(workspace_id,id,purchase_order_id,request_key,request_hash,recorded_by,source_reference,source_hash,source_snapshot,result)
    VALUES($1,$2,$3,$2,'h',$4,'Delivery note','h','{}','{}')`,[f.ws,randomUUID(),arriving.id,ctx.actorId]);
  const before=await f.incoming();

  // Starter only lists them.
  await f.subscribe('starter');
  const listed=await f.browser.get(stale.href).expect(200);
  assert.match(listed.text,new RegExp(late.number));
  assert.match(listed.text,/Not expected/);
  assert.match(listed.text,/Closes after/);
  assert.match(listed.text,/A shipment or ship notice is recorded/);
  assert.match(listed.text,/Goods for this order are being received/);
  assert.match(listed.text,/The supplier was in touch on/);
  assert.match(listed.text,/needs Growth or above/);
  assert.doesNotMatch(listed.text,/Close now/);
  await assert.rejects(stale.closeNow(db,ctx,late.id,{confirmed:'yes',fingerprint:(await f.find(late)).fingerprint}),e=>e.code==='entitlement_required');
  await assert.rejects(f.rule(),e=>e.code==='entitlement_required');
  assert.deepEqual(await f.run(),{skipped:'plan'});
  assert.match((await require('../../src/autopilot/job-reviews').run(db,ctx,'overdue-incoming')).rows[0].Suggestion,/Contact/);

  // Growth: nothing closes until the owner saves a rule.
  await f.subscribe('growth');
  assert.deepEqual(await f.run(),{skipped:'no_rule'});
  await f.rule();
  assert.deepEqual(await f.run(),{closed:1,drafted:0});
  assert.deepEqual(await f.lines(late),[[4,4]],'Only the late, quiet remainder closes; received goods stay');
  assert.equal(await f.status(late),'RECEIVED');
  for(const kept of [waiting,heard,shipped,arriving])assert.deepEqual(await f.lines(kept),[[12,0]]);
  assert.equal(await f.incoming(),before-8,'The closed goods no longer count as incoming');
  const [closed]=await f.closes("status='CLOSED'");
  assert.equal(closed.authorization_kind,'AUTOMATIC');
  assert.equal(await f.audits('StockChief closed goods that will not arrive'),1);
  const event=(await db.query(`SELECT detail FROM purchase_order_events WHERE workspace_id=$1 AND purchase_order_id=$2 AND event='incoming_closed'`,[f.ws,late.id])).rows;
  assert.equal(event.length,1);
  const notice=(await db.query('SELECT status,message_kind,body FROM supplier_communications WHERE workspace_id=$1 AND id=$2',[f.ws,closed.notice_id])).rows[0];
  assert.equal(notice.status,'PREPARED','The supplier note is drafted, not sent');
  assert.match(notice.body,new RegExp(late.number));
  assert.equal((await db.query("SELECT count(*) n FROM supplier_communications WHERE workspace_id=$1 AND status IN ('QUEUED','SENDING','SENT') AND message_kind='purchase_remainder_closed'",[f.ws])).rows[0].n,'0');

  // Replaying finds nothing more; the queued routine does the same.
  assert.deepEqual(await f.run(),{closed:0,drafted:0});
  assert.equal((await stale.schedule(db,f.ws)).queued,1);
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const job=await queue.processOne(db,{[stale.KIND]:handlers[stale.KIND]},{owner:'stale-incoming-test'});
  assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
  assert.deepEqual(job.result,{closed:0,drafted:0});

  // The page shows the close with a reopen button and the draft note.
  const page=await f.browser.get(stale.href).expect(200);
  assert.match(page.text,/Recent closes/);
  assert.match(page.text,new RegExp('/messages/supplier/'+closed.notice_id));

  // Undo: the goods count as incoming again and StockChief does not close them on its own again.
  assert.deepEqual(await stale.reopen(db,ctx,closed.id,{confirmed:'yes'}),{reopened:true,status:'PARTIALLY_RECEIVED'});
  assert.equal((await stale.reopen(db,ctx,closed.id,{confirmed:'yes'})).replayed,true);
  assert.deepEqual(await f.lines(late),[[12,4]]);
  assert.equal(await f.status(late),'PARTIALLY_RECEIVED');
  assert.equal(await f.incoming(),before);
  assert.equal((await db.query('SELECT status FROM supplier_communications WHERE id=$1',[closed.notice_id])).rows[0].status,'CANCELLED');
  assert.equal(await f.audits('Reopened goods that were closed as not arriving'),1);
  assert.deepEqual(await f.run(),{closed:0,drafted:0},'A reopened order stays open until a person closes it');
  assert.match((await f.find(late)).ownerKept,/reopened/);

  // A person can still close it, and a whole order with nothing received is cancelled in StockChief only.
  const whole=await f.order();
  const view=await f.find(whole);
  const manual=await stale.closeNow(db,ctx,whole.id,{confirmed:'yes',fingerprint:view.fingerprint});
  assert.equal(manual.status,'CANCELLED');
  assert.deepEqual(await f.lines(whole),[[0,0]]);
  assert.equal((await stale.closeNow(db,ctx,whole.id,{confirmed:'yes',fingerprint:view.fingerprint}).catch(e=>e)).status,404,'Closing twice finds nothing late');
  const reopened=await stale.reopen(db,ctx,manual.id,{confirmed:'yes'});
  assert.equal(reopened.status,'ORDERED');
  const header=(await db.query('SELECT status,cancel_reason,cancelled_at FROM purchase_orders WHERE id=$1',[whole.id])).rows[0];
  assert.deepEqual([header.status,header.cancel_reason,header.cancelled_at],['ORDERED',null,null]);
  assert.deepEqual(await f.lines(whole),[[12,0]]);
});

test('Pro and Custom close on their own within the limit; Ask me first, pause, Watch only, shadow and bad data wait for a person',{timeout:300000},async t=>{
  const f=await setup(t),{db,ctx}=f;
  for(const plan of ['pro','enterprise']){
    await f.subscribe(plan);
    if(!(await stale.read(db,f.ws)))await f.rule();
    const o=await f.order();
    const result=await f.run();
    assert.equal(result.closed,1,plan+' closes on its own: '+JSON.stringify(result));
    assert.deepEqual(await f.lines(o),[[0,0]]);
  }
  const before=await f.incoming();

  // Over the owner's value limit waits for approval, and approving closes it.
  const big=await f.order({quantity:60});
  assert.deepEqual(await f.run(),{closed:0,drafted:1});
  let [draft]=await f.closes("status='DRAFT'");
  assert.match(draft.reason,/more than your limit/);
  assert.deepEqual(await f.lines(big),[[60,0]]);
  const inbox=await stale.inbox(db,f.ws);
  assert(inbox.some(row=>row.href===stale.href+'#close-'+draft.id));
  assert.deepEqual(await f.run(),{closed:0,drafted:0},'Replaying keeps one draft');
  const approved=await stale.closeNow(db,ctx,big.id,{confirmed:'yes',closeId:draft.id,fingerprint:draft.fingerprint});
  assert.equal(approved.id,draft.id);
  assert.deepEqual(await f.lines(big),[[0,0]]);
  assert.equal((await f.closes(`id='${draft.id}'`))[0].authorization_kind,'INDIVIDUAL');

  // Ask me first.
  await f.mode('ask');
  const asked=await f.order();
  assert.deepEqual(await f.run(),{closed:0,drafted:1});
  [draft]=await f.closes("status='DRAFT'");
  assert.match(draft.reason,/Ask me first/);
  // The owner keeps these goods; StockChief does not close them later on its own.
  await stale.dismiss(db,ctx,draft.id);
  await f.mode('inherit');
  assert.deepEqual(await f.run(),{closed:0,drafted:0});
  assert.deepEqual(await f.lines(asked),[[12,0]]);

  // Pause.
  const autopilot=require('../../src/autopilot/postgres-service');
  await autopilot.pause(db,ctx,{role:'owner'},'Supplier review');
  const paused=await f.order();
  assert.deepEqual(await f.run(),{closed:0,drafted:1});
  [draft]=await f.closes(`status='DRAFT' AND purchase_order_id='${paused.id}'`);
  assert.match(draft.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.deepEqual(await f.run(),{closed:1,drafted:0},'After the pause the waiting order closes');
  assert.equal((await f.closes(`id='${draft.id}'`))[0].status,'STALE');

  // Watch only and shadow only watch.
  await f.mode('watch');
  const watched=await f.order();
  assert.deepEqual(await f.run(),{watching:true});
  await assert.rejects(stale.closeNow(db,ctx,watched.id,{confirmed:'yes',fingerprint:(await f.find(watched)).fingerprint}),/Watch only/);
  await f.mode('inherit');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  assert.deepEqual(await f.run(),{watching:true});
  assert.match((await f.browser.get(stale.href).expect(200)).text,/watching during your first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.deepEqual(await f.lines(watched),[[12,0]]);
  assert.deepEqual(await f.run(),{closed:1,drafted:0});

  // Bad data stops and asks: no price, a bill for goods not received.
  const unpriced=await f.order();
  await db.query('UPDATE purchase_order_lines SET unit_cost=NULL,line_total=NULL WHERE id=$1',[unpriced.lineId]);
  const billed=await f.order();
  await f.workflows.recordSupplierInvoice(db,ctx,{supplierId:'fixture-supplier',purchaseOrderId:billed.id,supplierInvoiceNumber:randomUUID(),
    issueDate:f.today,idempotencyKey:randomUUID(),documentTotalMinor:1200,lines:[{purchaseOrderLineId:billed.lineId,skuId:f.sku,quantity:12,unitCostMinor:100}]});
  assert.deepEqual(await f.run(),{closed:0,drafted:1});
  [draft]=await f.closes(`status='DRAFT' AND purchase_order_id='${unpriced.id}'`);
  assert.match(draft.reason,/no recorded price/);
  assert.match((await f.find(billed)).lines[0].kept,/billed/);
  assert.deepEqual(await f.lines(billed),[[12,0]]);
  assert.equal(await f.incoming(),before+36,'Only the kept goods still count: the order the owner kept, the unpriced one and the billed one');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port;
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const view=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});view.setDefaultTimeout(15000);
    await view.goto(base+'/login');await view.getByLabel('Work email').fill(f.email);await view.locator('[name=password]').fill(f.password);
    await Promise.all([view.waitForNavigation(),view.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await view.goto(base+stale.href);
    assert(await view.getByRole('heading',{name:'Goods that will not arrive',exact:true}).isVisible());
    assert(await view.getByRole('heading',{name:'Waiting for your approval'}).isVisible());
    assert(await view.getByRole('button',{name:'Save rule'}).isVisible());
    assert(await view.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await view.close();
  }
});
