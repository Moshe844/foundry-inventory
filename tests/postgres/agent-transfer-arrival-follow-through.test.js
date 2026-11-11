'use strict';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const transfers = require('../../src/transfers/postgres-transfer-service');
const arrivals = require('../../src/transfers/agent-transfer-arrivals');
const notices = require('../../src/autopilot/operational-notices');
const jobs = require('../../src/operations/postgres-job-queue');
const reviews = require('../../src/autopilot/job-reviews');
const rights = require('../../src/actions/permissions');
const { addDays } = require('../../src/accounting/customer-money');

async function fixture(t) {
  const f = await require('../helpers/agent-workflow-fixture').fixture(t,{units:25,timeZone:'America/New_York'});
  await f.subscribe('growth');
  await f.db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  const today = await require('../../src/lib/business-time').today(f.db,f.ctx.workspaceId);
  async function makeLocation(name, parentLocationId) {
    return require('../../src/domain/postgres-location-service').createLocation(f.db,f.ctx,{name,kind:parentLocationId?'bin':'warehouse',parentLocationId});
  }
  async function dispatch(to, lines, { due = addDays(today,-2), inTransit = true } = {}) {
    const t=await transfers.request(f.db,f.ctx,{fromLocationId:f.location.id,toLocationId:to.id,expectedArrivalDate:due,idempotencyKey:randomUUID(),lines});
    for (const stage of ['approve','pick','dispatch',...(inTransit?['markInTransit']:[])]) {
      await transfers[stage](f.db,f.ctx,t.id,{idempotencyKey:randomUUID()});
    }
    return transfers.get(f.db,f.ctx.workspaceId,t.id);
  }
  async function member(roots, allowed=[rights.VIEW,rights.VIEW_TRANSFERS,rights.RECEIVE_TRANSFER]) {
    const email=randomUUID()+'@example.test', account=await require('../../src/domain/postgres-auth-service').createBusiness(f.db,{email,password:f.password,name:'Receiving staff',businessName:'Separate staff inventory'});
    const actorId=randomUUID();
    await f.db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at)
      VALUES($1,$2,$3,'Receiver','staff',$4,$5::jsonb,now()::text)`,
    [actorId,f.ctx.workspaceId,account.accountId,rights.encodeGrant(allowed),JSON.stringify(roots)]);
    return {workspaceId:f.ctx.workspaceId,actorId,email};
  }
  async function queue() {
    return (await jobs.enqueue(f.db,{workspaceId:f.ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:randomUUID(),
      payload:{actorId:f.ctx.actorId,requestedByUser:true},priority:40,maxAttempts:1})).job;
  }
  async function run(queued) {
    const handler=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
    const result=await jobs.processOne(f.db,{'autopilot.evaluate':handler},{owner:'transfer-test',kinds:['autopilot.evaluate'],leaseMs:30000});
    assert.equal(result?.id,queued.id);
    assert.equal(result.status,'COMPLETED',JSON.stringify(result.lastError));
    return result;
  }
  const quantity=f.item.skuIds[0];
  return {...f,today,makeLocation,dispatch,member,queue,run,quantity};
}

test('scheduled transfer chase reaches only receiving staff, records a real phone check once, and survives split physical receipt and downgrade',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f,east=await f.makeLocation('East receiving'),shelf=await f.makeLocation('East shelf',east.id),west=await f.makeLocation('West receiving');
  const eastStaff=await f.member([east.id]),westStaff=await f.member([west.id]),readOnly=await f.member([east.id],[rights.VIEW,rights.VIEW_TRANSFERS]),source=await f.member([f.location.id]);
  const eastTransfer=await f.dispatch(shelf,[{skuId:f.quantity,quantity:4}],{inTransit:false});
  const westTransfer=await f.dispatch(west,[{skuId:f.quantity,quantity:2}]);
  const beforeMoves=(await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
  await notices.refresh(db,ctx.workspaceId,{now:new Date(addDays(f.today,-1)+'T17:00:00Z')});
  const yesterday=addDays(f.today,-1);
  assert.equal((await arrivals.page(db,eastStaff)).rows[0].reminder_day,yesterday);
  assert.deepEqual((await arrivals.page(db,westStaff)).rows.map(r=>r.id),[westTransfer.id]);
  assert.deepEqual(await notices.inbox(db,ctx.workspaceId,readOnly.actorId),[]);
  assert.deepEqual(await notices.inbox(db,ctx.workspaceId,source.actorId),[]);
  await assert.rejects(arrivals.page(db,eastStaff,{locationId:west.id}),/assigned warehouses/);
  await assert.rejects(arrivals.check(db,eastStaff,westTransfer.id,yesterday),e=>e.code==='not_found');
  const parallel=await Promise.all([arrivals.check(db,eastStaff,eastTransfer.id,yesterday),arrivals.check(db,eastStaff,eastTransfer.id,yesterday)]);
  assert.deepEqual(parallel.map(r=>r.replayed).sort(),[false,true]);
  assert.deepEqual(await notices.inbox(db,ctx.workspaceId,eastStaff.actorId),[]);
  await f.run(await f.queue());
  assert.equal((await arrivals.page(db,eastStaff)).rows[0].reminder_day,f.today);
  assert.equal((await arrivals.page(db,eastStaff)).rows[0].reminders,2);
  assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,beforeMoves);

  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const server=await new Promise(resolve=>{const running=app.listen(0,'127.0.0.1',()=>resolve(running));});
  const chrome=await require('playwright').chromium.launch(),phone=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  f.cleanup(async()=>{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port;
  await phone.goto(base+'/login');await phone.locator('[name=email]').fill(eastStaff.email);await phone.locator('[name=password]').fill(f.password);
  await Promise.all([phone.waitForNavigation(),phone.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await phone.goto(base+'/inventories');
  await phone.request.post(base+'/inventories/switch',{form:{_csrf:await phone.locator('[name=_csrf]').first().inputValue(),workspaceId:ctx.workspaceId}});
  await phone.goto(base+'/warehouse/stock');assert.match(await phone.textContent('body'),/Transfers awaiting receipt at East shelf/);assert.doesNotMatch(await phone.textContent('body'),/West receiving/);
  await phone.getByRole('link',{name:'Check incoming transfers'}).first().click();
  await phone.waitForURL(/arrival-follow-up/);
  assert.equal(await phone.locator('body').evaluate(b=>b.scrollWidth<=innerWidth+2),true);
  await phone.getByRole('button',{name:'Checked and still waiting'}).click();
  await phone.waitForLoadState('networkidle');
  assert.match(await phone.textContent('body'),/Receiving team checked and is still waiting/);
  assert.equal((await db.query(`SELECT count(*)::int n FROM inventory_transfer_events WHERE transfer_id=$1 AND event_type=$2`,[eastTransfer.id,arrivals.FOLLOW_UP])).rows[0].n,2);
  assert.equal(await phone.request.get(base+'/transfers/'+westTransfer.id).then(r=>r.status()),404);

  await phone.getByRole('link',{name:'Open transfer to record arrival'}).click();
  await phone.getByText('Record part of this arrival',{exact:true}).click();
  const partial=phone.locator('details').filter({hasText:'Record part of this arrival'});
  await partial.locator('input[name=received]').fill('2');
  const receiptKey=await partial.locator('input[name=idempotencyKey]').inputValue();
  await partial.getByRole('button',{name:'Record partial arrival'}).click();
  await phone.waitForLoadState('networkidle');
  const input={idempotencyKey:receiptKey,lines:[{lineId:eastTransfer.lines[0].id,received:2}]};
  assert.equal((await transfers.receive(db,eastStaff,eastTransfer.id,input)).replayed,true);
  await assert.rejects(transfers.receive(db,source,eastTransfer.id,input),/assigned warehouses/);
  const remainder=(await arrivals.page(db,eastStaff)).rows[0];
  assert.equal(remainder.lines[0].received,'2');
  assert.equal(remainder.lines[0].outstanding,'2');

  for (const plan of ['pro','enterprise']) {
    await f.subscribe(plan);
    assert.equal((await reviews.run(db,ctx,'transfer-arrivals',{filter:eastTransfer.transfer_number})).mode,'alone');
    assert.equal((await arrivals.page(db,eastStaff)).rows.length,1);
    const additional=await f.dispatch(west,[{skuId:f.quantity,quantity:1}]);
    await f.run(await f.queue());
    assert.equal((await arrivals.page(db,westStaff)).rows.find(row=>row.id===additional.id)?.reminders,1);
  }
  const downgraded=await f.queue();await f.subscribe('starter');await f.run(downgraded);
  await assert.rejects(arrivals.page(db,eastStaff),e=>e.code==='entitlement_required');
  await assert.rejects(arrivals.check(db,eastStaff,eastTransfer.id,f.today),e=>e.code==='entitlement_required');
  assert.deepEqual(await notices.inbox(db,ctx.workspaceId,eastStaff.actorId),[]);
  await transfers.receive(db,eastStaff,eastTransfer.id,{idempotencyKey:randomUUID(),lines:[{lineId:eastTransfer.lines[0].id,received:2}]});
  assert.equal((await transfers.verify(db,ctx.workspaceId,eastTransfer.id)).ok,true);
  assert.equal((await db.query('SELECT on_hand::text FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,f.quantity,shelf.id])).rows[0].on_hand,'4');
  await f.subscribe('growth');await f.run(await f.queue());
  assert.equal((await arrivals.page(db,eastStaff)).rows.length,0);
  assert.equal((await reviews.run(db,ctx,'transfer-arrivals',{filter:eastTransfer.transfer_number})).rows[0].Result,'Received complete');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.provider_effects WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});

test('follow-through reconciles exact measured, lot and serial stock and asks for an absent date without calling it overdue',{timeout:300000},async t=>{
  const f=await fixture(t),{db,ctx}=f;
  const destination=await f.makeLocation('Mixed goods receiving'),staff=await f.member([destination.id]);
  const catalog=require('../../src/domain/postgres-catalog-service');
  const measured=(await catalog.createItem(db,ctx,{name:'Measured cable',baseCode:'CH-CABLE',trackingMode:'lot',
    unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'})).skuIds[0];
  const weighted=(await catalog.createItem(db,ctx,{name:'Catch weight rolls',baseCode:'CH-ROLL',trackingMode:'lot',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,secondaryIncrement:'0.001'})).skuIds[0];
  const serialized=(await catalog.createItem(db,ctx,{name:'Tracked units',baseCode:'TRACKED-ARRIVAL',trackingMode:'serial'})).skuIds[0];
  async function receiveAtSource(skuId,quantity,extra={}) {
    const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',currency:'USD',destinationLocationId:f.location.id,
      idempotencyKey:randomUUID(),lines:[{skuId,quantityUnits:quantity,unitCost:4,secondaryQuantity:extra.secondaryQuantity}]});
    for(const action of ['approvePurchaseOrder','placePurchaseOrder'])await f.workflows[action](db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await f.workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity,locationId:f.location.id,...extra}]});
  }
  await receiveAtSource(measured,'1.125',{lotCode:'TRANSFER-LOT'});
  await receiveAtSource(weighted,2,{lotCode:'WEIGHT-LOT',secondaryQuantity:'2.375'});
  await receiveAtSource(serialized,2,{serials:['MOVE-A','MOVE-B']});
  const lotId=(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,measured])).rows[0].id;
  const weightedLot=(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,weighted])).rows[0].id;
  const serials=(await db.query('SELECT id,serial FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 ORDER BY serial',[ctx.workspaceId,serialized])).rows;
  const mixed=await f.dispatch(destination,[{skuId:measured,lotId,quantity:'1.125'},
    {skuId:weighted,lotId:weightedLot,quantity:2,secondaryQuantity:'2.375'},
    {skuId:serialized,quantity:2,serialUnitIds:serials.map(s=>s.id)}]);
  const undated=await f.dispatch(destination,[{skuId:f.quantity,quantity:1}],{due:null});
  const future=await f.dispatch(destination,[{skuId:f.quantity,quantity:1}],{due:addDays(f.today,1)});
  await notices.refresh(db,ctx.workspaceId);
  let page=await arrivals.page(db,staff);
  assert.deepEqual(page.rows.map(r=>r.id),[mixed.id]);
  const expected=(await reviews.run(db,ctx,'transfer-arrivals',{filter:undated.transfer_number})).rows[0];
  assert.equal(expected.Result,'Arrival date not recorded');assert.equal(expected.Due,null);
  await db.query("UPDATE inventory_transfers SET shipped_at=$3,expected_arrival_date='legacy unknown' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,undated.id,addDays(f.today,-1)+'T16:00:00Z']);
  await notices.refresh(db,ctx.workspaceId);
  page=await arrivals.page(db,staff);
  assert.deepEqual(new Set(page.rows.map(r=>r.id)),new Set([mixed.id,undated.id]));
  assert.equal(page.rows.find(r=>r.id===undated.id).expected_arrival_date,null);
  assert.ok(!page.rows.some(r=>r.id===future.id));
  const line=page.rows.find(r=>r.id===mixed.id).lines.find(l=>l.code==='CH-CABLE');
  assert.deepEqual([line.lot,line.outstanding,line.unit,line.secondaryUnit],['TRANSFER-LOT','1.125','m',null]);
  const roll=page.rows.find(r=>r.id===mixed.id).lines.find(l=>l.code==='CH-ROLL');
  assert.deepEqual([roll.lot,roll.outstanding,roll.secondaryOutstanding,roll.unit,roll.secondaryUnit],['WEIGHT-LOT','2','2.375','piece','kg']);
  assert.deepEqual(page.rows.find(r=>r.id===mixed.id).lines.find(l=>l.code==='TRACKED-ARRIVAL').serials,['MOVE-A','MOVE-B']);
  const mixedRow=(await reviews.run(db,ctx,'transfer-arrivals',{filter:mixed.transfer_number})).rows[0];
  assert.equal(mixedRow['Still in transit'],null,'Distinct stocking units must not be added into a total.');
  const cable=mixed.lines.find(l=>l.sku_id===measured).id,weighed=mixed.lines.find(l=>l.sku_id===weighted).id,tracked=mixed.lines.find(l=>l.sku_id===serialized).id;
  await transfers.receive(db,staff,mixed.id,{idempotencyKey:randomUUID(),lines:[{lineId:cable,received:'0.125'},{lineId:weighed,received:1,receivedSecondaryQuantity:'0.375'},
    {lineId:tracked,received:1,receivedSerialUnitIds:[serials[0].id]}]});
  const partial=(await arrivals.page(db,staff)).rows.find(r=>r.id===mixed.id);
  const remaining=partial.lines.find(l=>l.code==='CH-CABLE');
  assert.equal(Number(remaining.outstanding),1);
  assert.equal(Number(partial.lines.find(l=>l.code==='CH-ROLL').secondaryOutstanding),2);
  assert.deepEqual(partial.lines.find(l=>l.code==='TRACKED-ARRIVAL').serials,['MOVE-B']);
  const loss={idempotencyKey:randomUUID(),lines:[{lineId:cable,received:'0.875',damaged:'0.125'},{lineId:weighed,received:1,receivedSecondaryQuantity:2},
    {lineId:tracked,lost:1,lostSerialUnitIds:[serials[1].id]}]};
  await assert.rejects(transfers.receive(db,staff,mixed.id,loss),/permission|allowed|cannot/i);
  await transfers.receive(db,ctx,mixed.id,loss);
  assert.equal((await transfers.verify(db,ctx.workspaceId,mixed.id)).ok,true);
  assert.ok(!(await arrivals.page(db,staff)).rows.some(r=>r.id===mixed.id));
  assert.equal((await reviews.run(db,ctx,'transfer-arrivals',{filter:mixed.transfer_number})).rows[0].Result,'Closed with a difference');
  const modes=require('../../src/autopilot/job-modes');
  await modes.save(db,ctx,124,{mode:'watch',revision:0});
  assert.deepEqual((await arrivals.page(db,staff)).rows,[]);
  assert.deepEqual(await notices.inbox(db,ctx.workspaceId,staff.actorId),[]);
  await notices.refresh(db,ctx.workspaceId);
  await modes.save(db,ctx,124,{mode:'routine',revision:1});
  await notices.refresh(db,ctx.workspaceId);
  assert.equal((await arrivals.page(db,staff)).rows[0].reminders,1,'Restarting same-day follow-up must not count a duplicate reminder.');
});
