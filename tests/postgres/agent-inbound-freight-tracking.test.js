'use strict';

process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');

test('job 39: carrier tracking keeps arrival dates, purchase-order dates, run-out alerts and deposit reminders current within each plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:1}),{db,ctx,browser,csrf,subscribe,workflows}=f,ws=ctx.workspaceId;
  const freight=require('../../src/purchasing/agent-inbound-freight'),arrivals=require('../../src/purchasing/inbound-freight-arrivals');
  const tracking=require('../../src/purchasing/freight-tracking'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const inv=require('../../src/domain/postgres-inventory-engine'),catalog=require('../../src/domain/postgres-catalog-service');
  const time=require('../../src/lib/business-time'),{addDays}=require('../../src/accounting/customer-money');
  const needs=async()=>require('../../src/projections/postgres-service').needs(db,ws,ctx.actorId);
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const clock=await time.forWorkspace(db,ws),today=clock.calendarDate,later=n=>addDays(today,n);
  const at=day=>new Date(Date.parse(time.dayBoundary(day,clock.timeZone))+12*3600000).toISOString();

  // STEADY sells 5 a day and has 40 left, so it runs out in 8 days.
  const sku=(await catalog.createItem(db,ctx,{name:'Steady seller',baseCode:'STEADY',trackingMode:'quantity'})).skuIds[0];
  await inv.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:340,occurredAt:at(later(-70)),idempotencyKey:randomUUID()});
  for(let k=60;k>=1;k--)await inv.issue(db,ctx,{skuId:sku,locationId:f.location.id,quantity:5,reasonCode:'sold',occurredAt:at(later(-k)),idempotencyKey:randomUUID()});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,expectedDate:later(5),
    idempotencyKey:'import-po',lines:[{skuId:sku,quantityUnits:100,unitCost:'1.00'}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'import-approve'});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'import-place'});
  const order=(await db.query('SELECT id,po_number FROM purchase_orders WHERE id=$1',[po.purchaseOrderId])).rows[0];
  const poDate=async()=>(await db.query('SELECT expected_date FROM purchase_orders WHERE id=$1',[order.id])).rows[0].expected_date;
  const audits=async action=>(await db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n;
  const stock=await f.balance(),payments=async()=>(await db.query('SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1',[ws])).rows[0].n,paidBefore=await payments();

  // The tracking service is a fake with the provider's one method.
  let answer={pending:true,providerReference:'request:1'},calls=0;
  const fake={isConfigured:()=>true,track:async input=>{calls++;assert.equal(input.reference,'TRKU1234567');assert.equal(input.carrierCode,'MAEU');
    if(answer instanceof Error)throw answer;return answer;}};
  f.cleanup(tracking.register('test-freight',fake));
  const handler=require('../../src/operations/postgres-runtime-handlers').create(undefined,{freightTrackingProvider:fake})[arrivals.KIND];
  assert.equal(handler.externalEffect,true);
  let cycle=0;
  const runJob=async()=>{
    await db.query('UPDATE stockchief_runtime.agent_inbound_freight SET tracking_checked_at=now()-interval \'7 hours\',tracking_retry_after=NULL WHERE workspace_id=$1',[ws]);
    assert.equal((await db.transaction(c=>arrivals.schedule(c,ws,'cycle-'+(++cycle)))).queued,true);
    const row=(await db.query('SELECT id,payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind=$2 AND idempotency_key=$3',[ws,arrivals.KIND,'inbound-freight-tracking:cycle-'+cycle])).rows[0];
    const job={id:row.id,workspaceId:ws,payload:row.payload};
    return {job,result:await handler(job,db)};
  };
  const reading=(eta,status='in_transit')=>({providerReference:'shipment:9',status,eta,observedAt:new Date().toISOString(),
    events:[{at:new Date().toISOString(),status,location:'Shanghai',detail:'Vessel schedule'}]});
  const snapshot=id=>freight.page(db,ctx,id);

  // Starter does not include the job.
  await subscribe('starter');
  const base={mode:'ocean',referenceType:'container',reference:'TRKU1234567',forwarder:'Synthetic line',destination:'Newark',eta:later(3),
    orders:order.po_number,maximumShiftDays:'5',routine:'yes',confirmed:'yes'};
  await assert.rejects(freight.create(db,ctx,base),e=>e.code==='entitlement_required');
  assert.deepEqual(await arrivals.inbox(db,ws),[]);

  // Growth: follow the carrier's tracking for one ocean container.
  await subscribe('growth');
  const {id}=await freight.create(db,ctx,base),path=freight.path+'/'+id;
  let row=await freight.get(db,ws,id);
  await assert.rejects(arrivals.configureTracking(db,ctx,id,{tracking:'yes',revision:row.revision,confirmed:'yes'}),/SCAC/);
  await assert.rejects(arrivals.configureTracking(db,ctx,id,{tracking:'yes',carrierCode:'MAEU',revision:row.revision+1,confirmed:'yes'}),/Reload/);
  let page=await browser.get(path).expect(200);
  assert.match(page.text,/Follow carrier tracking/);
  await browser.post(path+'/tracking').type('form').send({_csrf:csrf(page.text),tracking:'yes',carrierCode:'maeu',revision:row.revision,confirmed:'yes'}).expect(303);
  row=await freight.get(db,ws,id);
  assert.equal(row.tracking,true);assert.equal(row.carrier_code,'MAEU');

  // The line has not confirmed the shipment yet: nothing is recorded.
  let {job,result}=await runJob();
  assert.equal(result.pending,1);assert.equal(calls,1);
  assert.equal((await freight.get(db,ws,id)).tracking_reference,'request:1');
  assert.equal((await snapshot(id)).history.length,0);
  assert.equal((await handler(job,db)).checked,0,'A replayed job does not ask the carrier again.');assert.equal(calls,1);

  // Within the 5-day limit it applies on its own, and the order's warehouse date follows.
  answer=reading(later(5));
  ({job,result}=await runJob());
  assert.equal(result.applied,1);
  row=await freight.get(db,ws,id);
  assert.equal(row.eta,later(5));assert.equal(row.status,'in_transit');assert.equal(row.tracking_reference,'shipment:9');
  assert.equal(await poDate(),later(7));
  let snap=await snapshot(id);
  assert.equal(snap.history[0].source,'carrier');assert.equal(snap.history[0].disposition,'APPLIED');assert.match(snap.history[0].note,/Shanghai/);
  assert.equal(snap.dateChanges[0].status,'APPLIED');assert.equal(snap.dateChanges[0].automatic,true);assert.deepEqual(snap.dateChanges[0].shortage,[]);
  assert.equal(await audits('Carrier tracking update applied'),1);assert.equal(await audits('Purchase order date moved with its shipment'),1);
  assert.deepEqual(await arrivals.record(db,ws,id,tracking.read(answer)),{unchanged:true});
  assert.equal((await db.query("SELECT count(*)::int n FROM purchase_order_events WHERE purchase_order_id=$1 AND event='inbound_freight_date_updated'",[order.id])).rows[0].n,1);
  const orderPage=await browser.get('/purchasing/orders/'+order.id).expect(200);
  assert.match(orderPage.text,/Import shipment/);assert.match(orderPage.text,/Expected date moved with its shipment/);

  // The change can be undone while the order still shows the date it set.
  const change=snap.dateChanges[0];
  page=await browser.get(path).expect(200);assert.match(page.text,/Undo this date change/);
  await browser.post(path+'/undo').type('form').send({_csrf:csrf(page.text),dateId:change.id,confirmed:'yes'}).expect(303);
  assert.equal(await poDate(),later(5));
  assert.deepEqual(await arrivals.undo(db,ctx,id,{dateId:change.id,confirmed:'yes'}),{replayed:true});
  assert.equal(await audits('Purchase order date change undone'),1);

  // Beyond the limit it waits, with the order date it would set and the run-out it causes.
  answer=reading(later(13));
  ({result}=await runJob());
  assert.equal(result.review,1);
  row=await freight.get(db,ws,id);
  assert.equal(row.eta,later(5));assert.equal(await poDate(),later(5));
  snap=await snapshot(id);
  const held=snap.dateChanges.find(d=>d.status==='HELD');
  assert.equal(held.proposed_date,later(13));assert.equal(held.shortage[0].code,'STEADY');assert.equal(held.shortage[0].runsOut,later(8));
  assert.match(snap.history[0].held_reason,/more than the 5 days/);
  let list=await needs();
  assert.ok(list.some(n=>n.title==='Review the arrival update for TRKU1234567'));
  assert.ok(list.some(n=>n.title==='STEADY will run out before '+order.po_number+' arrives'&&n.importance==='Urgent'));
  page=await browser.get(path).expect(200);
  assert.match(page.text,/Waiting for your approval/);assert.match(page.text,/STEADY runs out on/);
  await browser.post(path+'/review').type('form').send({_csrf:csrf(page.text),updateId:snap.history[0].id,revision:row.revision,confirmed:'yes'}).expect(303);
  assert.equal(await poDate(),later(13));assert.equal((await freight.get(db,ws,id)).eta,later(13));
  assert.deepEqual(await freight.reviewUpdate(db,ctx,id,{updateId:snap.history[0].id,revision:row.revision,confirmed:'yes'}),{replayed:true});
  assert.equal(await audits('Purchase order date approved with its shipment'),1);
  snap=await snapshot(id);
  const approved=snap.dateChanges.find(d=>d.status==='APPROVED');
  page=await browser.get(path).expect(200);
  await browser.post(path+'/seen').type('form').send({_csrf:csrf(page.text),dateId:approved.id}).expect(303);
  assert.ok(!(await arrivals.inbox(db,ws)).some(n=>/will run out/.test(n.title)),'A noted run-out alert leaves Needs you.');

  // Ask me first holds every change, purchase-order dates included.
  row=await freight.get(db,ws,id);
  await freight.configure(db,ctx,id,{enable:'yes',maximumShiftDays:'5',revision:row.revision,confirmed:'yes'});
  await modes.save(db,ctx,39,{mode:'ask',revision:0});
  answer=reading(later(14));
  ({result}=await runJob());
  assert.equal(result.review,1);assert.equal(await poDate(),later(13));
  snap=await snapshot(id);
  assert.match(snap.history[0].held_reason,/Ask me first/);assert.equal(snap.dateChanges[0].status,'HELD');
  await modes.save(db,ctx,39,{mode:'routine',revision:1});
  answer=reading(later(15));
  ({result}=await runJob());
  assert.equal(result.applied,1);assert.equal(await poDate(),later(15));
  assert.equal((await snapshot(id)).dateChanges.filter(d=>d.status==='HELD').length,0,'A newer update replaces the held one.');

  // Pause only records. A person can still apply the update.
  await autopilot.pause(db,ctx,{role:'owner'},'Pause freight changes');
  answer=reading(later(16));
  ({result}=await runJob());
  assert.equal(result.watched,1);assert.equal(await poDate(),later(15));assert.equal((await freight.get(db,ws,id)).eta,later(15));
  snap=await snapshot(id);
  assert.match(snap.history[0].held_reason,/paused/);assert.equal(snap.dateChanges[0].status,'WATCH');
  await freight.reviewUpdate(db,ctx,id,{updateId:snap.history[0].id,revision:snap.freight.revision,confirmed:'yes'});
  assert.equal(await poDate(),later(16));
  await autopilot.resume(db,ctx,{role:'owner'});

  // Watch only records and refuses changes, including a person's.
  await modes.save(db,ctx,39,{mode:'watch',revision:2});
  answer=reading(later(17));
  ({result}=await runJob());
  assert.equal(result.watched,1);assert.equal(await poDate(),later(16));
  snap=await snapshot(id);
  await assert.rejects(freight.reviewUpdate(db,ctx,id,{updateId:snap.history[0].id,revision:snap.freight.revision,confirmed:'yes'}),/Watch only/);
  await modes.save(db,ctx,39,{mode:'routine',revision:3});

  // The first 14 days only watch.
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  answer=reading(later(18));
  ({result}=await runJob());
  assert.equal(result.watched,1);assert.equal(await poDate(),later(16));
  snap=await snapshot(id);
  await assert.rejects(freight.reviewUpdate(db,ctx,id,{updateId:snap.history[0].id,revision:snap.freight.revision,confirmed:'yes'}),/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '200 days')::text WHERE id=$1",[f.owner.accountId]);

  // Bad or missing facts stop the reading; the saved date is unchanged.
  const before=(await freight.get(db,ws,id)).eta;
  answer={providerReference:'shipment:9',status:'sailing',eta:later(30)};
  ({result}=await runJob());
  assert.equal(result.problems,1);assert.equal((await freight.get(db,ws,id)).eta,before);
  assert.match((await freight.get(db,ws,id)).tracking_issue,/status StockChief does not recognize/);
  assert.ok((await needs()).some(n=>n.title==='Carrier tracking for TRKU1234567 needs attention'));
  answer=Object.assign(new Error('The tracking service did not answer.'),{retryable:true});
  ({result}=await runJob());
  assert.equal(result.problems,1);
  answer=new Error('Unexpected programming fault');
  await assert.rejects(runJob(),/Unexpected programming fault/);

  // Pro and Custom apply within the limit on their own too.
  row=await freight.get(db,ws,id);
  await freight.configure(db,ctx,id,{enable:'yes',maximumShiftDays:'5',revision:row.revision,confirmed:'yes'});
  for(const [tier,eta] of [['pro',later(17)],['enterprise',later(18)]]){
    await subscribe(tier);
    answer=reading(eta);
    ({result}=await runJob());
    assert.equal(result.applied,1,tier);
    assert.equal(await poDate(),eta,'Each day the arrival moves, the warehouse date moves too.');
  }
  assert.equal((await freight.get(db,ws,id)).tracking_issue,null);

  // Deposits and the balance come due in Needs you. StockChief never pays.
  await subscribe('growth');
  page=await browser.get(path).expect(200);
  await browser.post(path+'/deposit').type('form').send({_csrf:csrf(page.text),orderId:order.id,amount:'30.00',dueDate:today,balanceDueDate:later(3),revision:0,confirmed:'yes'}).expect(303);
  await assert.rejects(freight.saveDeposit(db,ctx,id,{orderId:order.id,amount:'30.00',dueDate:later(4),balanceDueDate:later(3),revision:1,confirmed:'yes'}),/on or after the deposit/);
  list=await needs();
  const deposit=list.find(n=>n.title==='Deposit for '+order.po_number+' is due '+today),balance=list.find(n=>n.title==='Balance for '+order.po_number+' is due '+later(3));
  assert.ok(deposit);assert.ok(balance);
  assert.match(deposit.recommendation,/never sends money/);assert.match(balance.happened,/\$100\.00/);
  page=await browser.get(path).expect(200);
  assert.match(page.text,/Left to pay <strong>\$100\.00/);assert.match(page.text,/Balance due/);
  assert.equal(await payments(),paidBefore,'No payment was made or recorded.');
  assert.equal(await f.balance(),stock,'Tracking never changes stock.');

  // Back on Starter nothing runs and nothing is offered.
  await subscribe('starter');
  const count=calls;
  assert.deepEqual(await handler(job,db),{skipped:'plan'});assert.equal(calls,count);
  assert.equal((await db.transaction(c=>arrivals.schedule(c,ws,'cycle-starter'))).queued,false);
  assert.deepEqual(await arrivals.inbox(db,ws),[]);
  assert.deepEqual(await arrivals.forOrder(db,ws,order.id),[]);
  assert.match((await browser.get(path).expect(200)).text,/tracking starts at Growth/);
  await assert.rejects(arrivals.configureTracking(db,ctx,id,{tracking:'no',revision:(await freight.get(db,ws,id)).revision,confirmed:'yes'}),e=>e.code==='entitlement_required');

  // The shipment page reads well on a desktop and a phone.
  await subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const origin='http://127.0.0.1:'+server.address().port,fs=require('node:fs'),folder=require('node:path').join(process.cwd(),'output','agent-plan-review');
  fs.mkdirSync(folder,{recursive:true});
  for(const [width,height,name] of [[1440,900,'desktop'],[390,844,'phone']]){
    const tab=await chrome.newPage({viewport:{width,height}});
    await tab.goto(origin+'/login');await tab.locator('input[name="email"]').fill(f.email);await tab.locator('input[name="password"]').fill(f.password);
    await tab.locator('button[type="submit"]').click();await tab.waitForURL(url=>!url.pathname.startsWith('/login'));
    await tab.goto(origin+path);
    assert.match(await tab.locator('body').innerText(),/Carrier tracking/);
    assert.ok(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+' width');
    await tab.screenshot({path:require('node:path').join(folder,'inbound-freight-tracking-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
