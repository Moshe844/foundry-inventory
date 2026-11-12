'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 194 is excluded on Starter and alone on Growth, Pro and Custom. A person
// places a recall; StockChief then blocks the batch on every way out: picks and
// shipments, transfers, sales channels, kits, rentals and consignment. Expired
// batches are blocked the same way. Only a write-off or a supplier return takes
// them out. The blocks hold in shadow mode and while paused. Releasing a recall
// always needs a person, with a reason, and both decisions are audited.
test('recalled and expired batches are blocked on every way out and only a person releases a recall',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows,csrf}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const controls=require('../../src/autopilot/lot-controls'),blocks=require('../../src/operations/agent-lot-blocks');
  const transfers=require('../../src/transfers/postgres-transfer-service'),inventory=require('../../src/domain/postgres-inventory-engine');
  const custody=require('../../src/custody/postgres-service'),commerce=require('../../src/connections/postgres-commerce-sync');
  const autopilot=require('../../src/autopilot/postgres-service'),needs=require('../../src/projections/postgres-service');
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
  const RX=(await catalog.createItem(db,ctx,{name:'Eye drops',baseCode:'RX',trackingMode:'lot',purchaseCost:'2'})).skuIds[0];
  const SX=(await catalog.createItem(db,ctx,{name:'Glucose meter',baseCode:'SX',trackingMode:'serial',purchaseCost:'3'})).skuIds[0];
  const stock=(lot,expires,quantity)=>receipt.receive(db,ctx,{skuId:RX,locationId:location.id,lotCode:lot,expiresAt:expires,lotReceivedAt:day(-30),quantity,idempotencyKey:randomUUID()});
  await stock('R-1',day(100),6);await stock('R-2',day(200),4);await stock('X-OLD',day(-1),2);
  await receipt.receive(db,ctx,{skuId:SX,locationId:location.id,lotCode:'S-LOT',expiresAt:day(100),quantity:2,serials:['SN-1','SN-2'],idempotencyKey:randomUUID()});
  const lotId=async code=>(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND code=$2',[ws,code])).rows[0].id;
  const units=async code=>Number((await db.query('SELECT coalesce(sum(b.quantity),0) n FROM lot_balances b JOIN lots l ON l.id=b.lot_id WHERE l.workspace_id=$1 AND l.code=$2 AND b.location_id=$3',[ws,code,location.id])).rows[0].n);
  const audits=action=>db.query('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
  const serial=async code=>(await db.query('SELECT id FROM serial_units WHERE workspace_id=$1 AND serial=$2',[ws,code])).rows[0].id;
  const position={id:'no-position',workspace_id:ws,sku_id:RX,location_id:location.id,field:'quantity'};
  const R1={sku:'RX',lot:'R-1'};

  // Starter: recalls are locked; expired stock is still never sent anywhere.
  await subscribe('starter');
  await assert.rejects(controls.recall(db,ctx,{...R1,action:'hold',revision:0,reason:'Supplier notice'}),e=>e.code==='entitlement_required');
  assert.match((await browser.get('/autopilot/lots?'+new URLSearchParams(R1)).expect(200)).text,/Recall holds require Growth/);
  await assert.rejects(transfers.request(db,ctx,{fromLocationId:location.id,toLocationId:shop.id,idempotencyKey:randomUUID(),
    lines:[{skuId:RX,lotId:await lotId('X-OLD'),quantity:1}]}),e=>e.code==='lot_expired');
  assert.deepEqual(await blocks.inbox(db,ws),[]);

  // Growth, still in its first 14 days: a transfer of R-1 is ready to leave.
  await subscribe('growth');
  const early=await transfers.request(db,ctx,{fromLocationId:location.id,toLocationId:shop.id,idempotencyKey:randomUUID(),lines:[{skuId:RX,lotId:await lotId('R-1'),quantity:2}]});
  await transfers.approve(db,ctx,early.id,{idempotencyKey:randomUUID()});await transfers.pick(db,ctx,early.id,{idempotencyKey:randomUUID()});
  const before=await commerce.local(db,position);
  assert.equal(before.blocked,2,'Only the expired batch is held back from channels so far.');

  // The owner places the recall from the lot page.
  const lotPage=await browser.get('/autopilot/lots?'+new URLSearchParams(R1)).expect(200);
  await browser.post('/autopilot/lots/recall').type('form').send({...R1,_csrf:csrf(lotPage.text),revision:0,action:'hold',reason:'Supplier reported contamination'}).expect(303);
  assert.equal(await audits('Lot recall placed'),1);
  await controls.recall(db,ctx,{sku:'SX',lot:'S-LOT',action:'hold',revision:0,reason:'Meter calibration recall'});
  const recalled=await browser.get('/autopilot/lots?'+new URLSearchParams(R1)).expect(200);
  assert.match(recalled.text,/This batch is under recall\./);assert.match(recalled.text,new RegExp('Transfer '+early.transfer_number));

  // Transfers: the picked one cannot leave, a new one cannot be asked for.
  const stockBefore=await f.balance();
  await assert.rejects(transfers.dispatch(db,ctx,early.id,{idempotencyKey:randomUUID()}),e=>e.code==='lot_recalled');
  assert.equal(await f.balance(),stockBefore);assert.equal((await transfers.get(db,ws,early.id)).status,'PICKED');
  await assert.rejects(transfers.request(db,ctx,{fromLocationId:location.id,toLocationId:shop.id,idempotencyKey:randomUUID(),lines:[{skuId:RX,lotId:await lotId('R-1'),quantity:1}]}),e=>e.code==='lot_recalled');
  await assert.rejects(transfers.request(db,ctx,{fromLocationId:location.id,toLocationId:shop.id,idempotencyKey:randomUUID(),lines:[{skuId:SX,quantity:1,serialUnitIds:[await serial('SN-1')]}]}),e=>e.code==='lot_recalled');
  const [notice]=await blocks.inbox(db,ws);
  assert.match(notice.happened,new RegExp('Transfer '+early.transfer_number+' holds 2 of RX batch R-1 \\(under recall\\)'));
  assert((await needs.needs(db,ws,ctx.actorId)).some(n=>n.sourceId==='lot-blocks'));

  // Sales channels: the recalled units are no longer offered.
  const after=await commerce.local(db,position);
  assert.equal(after.blocked,8);assert.equal(after.physical,before.physical);assert.equal(before.value-after.value,6);

  // Picks and shipments: naming the batch is refused; with no batch named the
  // pick skips recalled and expired batches.
  const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:RX,quantity:3,unitPriceMinor:900}]});
  await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
  const ship=extra=>workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:sale.lineIds[0],locationId:location.id,quantity:1,...extra}]});
  await assert.rejects(ship({lotCode:'R-1'}),/recall/i);
  await assert.rejects(ship({lotCode:'X-OLD'}),/expired/i);
  await ship({});
  assert.deepEqual([await units('R-1'),await units('R-2'),await units('X-OLD')],[6,3,2]);

  // Pause and shadow mode never lift a block.
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  await autopilot.pause(db,ctx,{role:'owner'},'Audit');
  await assert.rejects(ship({lotCode:'R-1'}),/recall/i);
  await autopilot.resume(db,ctx,{role:'owner'});

  // Kits: a recalled component batch does not count towards buildable kits.
  await subscribe('pro');
  const kit=await catalog.createItem(db,ctx,{name:'Drops kit',baseCode:'RX-KIT',trackingMode:'quantity'});
  await require('../../src/domain/postgres-kit-service').define(db,ctx,{kitSkuId:kit.skuIds[0],components:[{skuId:RX,quantity:1}],stockBasis:'components'});
  const kits=require('../../src/domain/postgres-kit-availability');
  const buildable=async()=>(await kits.read(db,ws,[kit.skuIds[0]])).get(kit.skuIds[0]).buildable;
  // Only R-2's 3 good units remain, and 4 units are promised to the order and the transfer.
  assert.equal(await buildable(),0);

  // Rentals and consignment: the recalled batch is refused before anything moves.
  const rental=await custody.create(db,ctx,{kind:'RENTAL',customerId:'fixture-customer',requestKey:randomUUID(),startDate:today,dueDate:today,
    inspectionParentLocationId:location.id,lines:[{skuId:RX,quantity:1}]});
  await assert.rejects(custody.operate(db,ctx,rental.id,'dispatch',{requestKey:randomUUID(),lineId:rental.lines[0].id,quantity:1,confirmed:'yes',locationId:location.id,lotId:await lotId('R-1')}),e=>e.code==='lot_recalled');
  await assert.rejects(custody.operate(db,ctx,rental.id,'dispatch',{requestKey:randomUUID(),lineId:rental.lines[0].id,quantity:1,confirmed:'yes',locationId:location.id,lotId:await lotId('X-OLD')}),e=>e.code==='lot_expired');
  assert.equal(Number((await custody.get(db,ctx,rental.id)).lines[0].external_quantity),0);

  // A write-off or a supplier return may still take the batch out.
  await inventory.issue(db,ctx,{skuId:RX,locationId:location.id,quantity:1,lotCode:'R-1',reasonCode:'returned',idempotencyKey:randomUUID()});
  assert.equal(await units('R-1'),5);

  // Releasing needs the current revision, a person and a reason.
  const revision=(await controls.details(db,ctx,R1)).lot.recall_revision;
  await assert.rejects(controls.recall(db,ctx,{...R1,action:'release',revision:revision-1,reason:'Lab cleared it'}),/changed/);
  await assert.rejects(controls.recall(db,ctx,{...R1,action:'release',revision,reason:''}),/reason/);
  await assert.rejects(controls.recall(db,{workspaceId:ws,actorId:(await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other inventory',
    email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()})).userId},{...R1,action:'release',revision,reason:'Not mine'}),/owner/);
  const released=await controls.recall(db,ctx,{...R1,action:'release',revision,reason:'Lab cleared the batch'});
  assert.deepEqual(released,{held:false,revision:revision+1});
  assert.equal(await audits('Lot recall released'),1);
  const trail=(await db.query("SELECT actor_id,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Lot recall released'",[ws])).rows[0];
  assert.equal(trail.actor_id,ctx.actorId);assert.equal(trail.after_state.reason,'Lab cleared the batch');
  assert.equal(await buildable(),4,'Released: 8 good units, less the 4 promised to the order and the transfer.');
  await ship({lotCode:'R-1'});assert.equal(await units('R-1'),4);
  assert.equal((await commerce.local(db,position)).blocked,2);
  await transfers.dispatch(db,ctx,early.id,{idempotencyKey:randomUUID()});
  assert.equal((await transfers.get(db,ws,early.id)).status,'SHIPPED');

  // Pro and Custom place and release recalls the same way; a downgrade keeps
  // an existing recall in force and still lets a person release it.
  for(const plan of ['pro','enterprise']){
    await subscribe(plan);
    const r=(await controls.details(db,ctx,{sku:'RX',lot:'R-2'})).lot.recall_revision;
    await controls.recall(db,ctx,{sku:'RX',lot:'R-2',action:'hold',revision:r,reason:plan+' recall'});
    await assert.rejects(ship({lotCode:'R-2'}),/recall/i);
    if(plan==='pro')await controls.recall(db,ctx,{sku:'RX',lot:'R-2',action:'release',revision:r+1,reason:'Cleared'});
  }
  await subscribe('starter');
  await assert.rejects(ship({lotCode:'R-2'}),/recall/i);
  const r2=(await controls.details(db,ctx,{sku:'RX',lot:'R-2'})).lot.recall_revision;
  await controls.recall(db,ctx,{sku:'RX',lot:'R-2',action:'release',revision:r2,reason:'Cleared after downgrade'});
  await assert.rejects(controls.recall(db,ctx,{sku:'RX',lot:'R-2',action:'hold',revision:r2+1,reason:'Again'}),e=>e.code==='entitlement_required');
  assert.equal(await audits('Lot recall placed'),4);assert.equal(await audits('Lot recall released'),3);
  assert.equal((await controls.details(db,ctx,{sku:'RX',lot:'R-2'})).history.length,4);

  // The lot page reads well on a desktop and on a 390 px phone.
  await subscribe('growth');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+'/autopilot/lots?'+new URLSearchParams({sku:'SX',lot:'S-LOT'}));
    assert(await tab.getByText('This batch is under recall.').isVisible());
    assert(await tab.getByRole('button',{name:'Release this recall'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:require('node:path').join(folder,'lot-blocks-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
