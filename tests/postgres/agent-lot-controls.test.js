'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {randomUUID}=require('node:crypto');
const controls=require('../../src/autopilot/lot-controls');
const reviews=require('../../src/autopilot/job-reviews');

test('trace fulfilled lots, recall remaining goods and audit certificates across a downgrade', {timeout:240000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
  const {db,ctx,owner,workflows}=f,locationId=f.location.id;
  async function plan(id){
    await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES($1,$2,$3,
      (SELECT id FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' LIMIT 1),'ACTIVE')
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,[randomUUID(),owner.accountId,id]);
  }
  await plan('growth');
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const days=require('../../src/accounting/customer-money').addDays;
  const lotItem=await catalog.createItem(db,ctx,{name:'Lot of coffee',baseCode:'COFFEE',trackingMode:'lot',purchaseCost:'2'});
  const serialItem=await catalog.createItem(db,ctx,{name:'Coffee grinder',baseCode:'GRINDER',trackingMode:'serial',purchaseCost:'3'});
  const lot={sku:'COFFEE',lot:'BATCH-04'};
  await receipt.receive(db,ctx,{skuId:lotItem.skuIds[0],locationId,lotCode:lot.lot,expiresAt:days(today,8),quantity:5,idempotencyKey:'coffee-receipt'});
  await receipt.receive(db,ctx,{skuId:serialItem.skuIds[0],locationId,quantity:1,serials:['GR-007'],idempotencyKey:'grinder-receipt'});
  const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:locationId,
    neededBy:days(today,4),idempotencyKey:'coffee-order',lines:[{skuId:lotItem.skuIds[0],quantity:3,unitPriceMinor:400},{skuId:serialItem.skuIds[0],quantity:1,unitPriceMinor:800}]});
  await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'coffee-confirm'});
  const expiring=await reviews.run(db,ctx,'expiring-lots',{filter:lot.sku});
  assert.equal(expiring.rows[0].Lot,lot.lot);
  const parcel=await f.shipping.prepare(db,ctx,sale.salesOrderId,{idempotencyKey:'coffee-picking',lines:[
    {lineId:sale.lineIds[0],locationId,quantity:2},{lineId:sale.lineIds[1],locationId,quantity:1}]});
  await f.shipping.setPackages(db,ctx,parcel.shipmentId,[{weightGrams:100,lengthMm:150,widthMm:100,heightMm:50}]);
  await f.shipping.markPacked(db,ctx,parcel.shipmentId);
  await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',trackingNumber:'COFFEETEST001',carrier:'UPS',
    ['lotStrategy_'+sale.lineIds[0]+'_'+locationId]:'FEFO',['serials_'+sale.lineIds[1]+'_'+locationId]:'GR-007'});
  const trace=(await reviews.run(db,ctx,'recall-trace',{filter:lot.lot})).rows;
  assert.equal(trace.length,1);assert.equal(trace[0].Customer,'Receiver');assert.equal(Number(trace[0]['Units issued']),2);
  assert.equal(expiring.rows[0].Priority,trace[0].Order);
  assert.deepEqual((await reviews.run(db,ctx,'serial-history',{filter:'gr-007'})).rows.map(r=>r.Action),['receive','issue']);
  const serialStock=(await reviews.run(db,ctx,'stock-lookup',{filter:'GR-007'})).rows;
  assert.deepEqual(serialStock.map(row=>[row.View,row.Location,row.Units]),[['Serial','Issued','0']]);
  const lotStock=(await reviews.run(db,ctx,'stock-lookup',{filter:lot.lot})).rows;
  assert.deepEqual(lotStock.map(row=>[row.View,row.Units]),[['Lot','3']]);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),csrf=r=>/name="_csrf" value="([^"]+)"/.exec(r.text)?.[1];
  const login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:csrf(login),email:f.email,password:f.password});
  const url='/autopilot/lots?'+new URLSearchParams(lot);
  const initial=await browser.get(url).expect(200);
  await browser.post('/autopilot/lots/recall').type('form').send({...lot,_csrf:csrf(initial),revision:0,action:'hold',reason:'Supplier reported packaging contamination'}).expect(303);
  assert.match((await browser.get(url).expect(200)).text,/Under recall/);
  await receipt.receive(db,ctx,{skuId:lotItem.skuIds[0],locationId,lotCode:'OLD-BATCH',lotReceivedAt:days(today,-2),
    expiresAt:days(today,-1),quantity:1,idempotencyKey:'expired-coffee'});
  const inventoryBefore=await f.balance();
  function ship(pick){return workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:'ship-second',lines:[{lineId:sale.lineIds[0],locationId,quantity:1,...pick}]});}
  await assert.rejects(ship({lotStrategy:'FEFO'}),/not enough/i);
  await assert.rejects(ship({lotCode:lot.lot}),/recall/i);
  await assert.rejects(ship({lotCode:'OLD-BATCH'}),/expired/i);
  const doc={...lot,kind:'CoA'};
  await controls.certificate(db,ctx,doc);
  assert.equal((await reviews.run(db,ctx,'lot-documents',{filter:lot.lot})).rows[0].Status,'Missing');
  await controls.certificate(db,ctx,{...doc,documentUrl:'https://example.test/coffee-coa.pdf',expiresOn:days(today,-1)});
  assert.equal((await reviews.run(db,ctx,'lot-documents',{filter:lot.lot})).rows[0].Status,'Expired');
  await controls.certificate(db,ctx,{...doc,documentUrl:'https://example.test/coffee-coa-2.pdf',expiresOn:days(today,90)});
  assert.equal((await reviews.run(db,ctx,'lot-documents',{filter:lot.lot})).rows[0].Status,'On file');
  assert.equal((await reviews.run(db,ctx,'recall-audit')).rows[0].Decision,'Recall placed');
  await plan('starter');
  await assert.rejects(controls.certificate(db,ctx,doc),e=>e.code==='entitlement_required');
  await assert.rejects(ship({lotCode:lot.lot}),/recall/i);
  assert.equal(await f.balance(),inventoryBefore);
  await assert.rejects(controls.recall(db,ctx,{...lot,action:'release',revision:0,reason:'Retest completed'}),/changed/);
  await controls.recall(db,ctx,{...lot,action:'release',revision:1,reason:'Lab cleared batch'});
  await assert.rejects(controls.recall(db,ctx,{...lot,action:'hold',revision:2,reason:'Another recall'}),e=>e.code==='entitlement_required');
  await ship({lotCode:lot.lot});
  assert.equal(await f.balance(),inventoryBefore-1);
  assert.equal((await controls.details(db,ctx,lot)).history.length,2);
  assert.equal(Number((await reviews.run(db,ctx,'recall-trace',{filter:lot.lot})).rows[0]['Units issued']),3);
  assert.equal((await reviews.run(db,ctx,'bought-together',{filter:lot.sku})).rows[0].Suggestion.includes('Coffee grinder'),true);
  await plan('pro');
  assert.equal((await reviews.run(db,ctx,'customer-health')).rows[0].Health,'New activity');
  assert.equal((await reviews.run(db,ctx,'rising-demand',{filter:lot.sku})).rows[0].Increase,'New sales');
});

test('recall includes customer custody and serial history orders both legs of the physical transfer', {timeout:240000}, async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t);
  const {db,ctx}=f;
  const catalog=require('../../src/domain/postgres-catalog-service');
  const receipt=require('../../src/accounting/postgres-stock-receipt');
  const custody=require('../../src/custody/postgres-service');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  async function subscribe(plan){
    await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status)
      SELECT $1,$2,$3,id,'ACTIVE' FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE'
      ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id`,
    [randomUUID(),f.owner.accountId,plan]);
  }
  await subscribe('pro');
  const batch=await catalog.createItem(db,ctx,{name:'Reusable fittings',baseCode:'FITTINGS',trackingMode:'lot',purchaseCost:'2'});
  const serial=await catalog.createItem(db,ctx,{name:'Tracked fitting',baseCode:'SERIAL-FITTING',trackingMode:'serial',purchaseCost:'3'});
  const batchSku=batch.skuIds[0],serialSku=serial.skuIds[0],locationId=f.location.id;
  await receipt.receive(db,ctx,{skuId:batchSku,locationId,lotCode:'SUPPLIER-77',quantity:5,idempotencyKey:'recall-custody-batch'});
  await receipt.receive(db,ctx,{skuId:serialSku,locationId,lotCode:'SUPPLIER-77',quantity:1,serials:['TRACK-17'],idempotencyKey:'recall-custody-serial'});
  const lotId=(await db.query('SELECT id FROM lots WHERE workspace_id=$1 AND sku_id=$2 AND code=$3',[ctx.workspaceId,batchSku,'SUPPLIER-77'])).rows[0].id;
  const serialId=(await db.query('SELECT id FROM serial_units WHERE workspace_id=$1 AND sku_id=$2 AND serial=$3',[ctx.workspaceId,serialSku,'TRACK-17'])).rows[0].id;
  const agreement=await custody.create(db,ctx,{kind:'RENTAL',customerId:'fixture-customer',requestKey:'recall-rental',
    startDate:today,dueDate:today,inspectionParentLocationId:locationId,lines:[{skuId:batchSku,quantity:2},{skuId:serialSku,quantity:1}]});
  const rentalBatch=agreement.lines.find(line=>line.sku_id===batchSku),rentalSerial=agreement.lines.find(line=>line.sku_id===serialSku);
  await custody.operate(db,ctx,agreement.id,'dispatch',{requestKey:'recall-rental-batch',lineId:rentalBatch.id,quantity:2,confirmed:'yes',locationId,lotId});
  await custody.operate(db,ctx,agreement.id,'dispatch',{requestKey:'recall-rental-serial',lineId:rentalSerial.id,quantity:1,confirmed:'yes',locationId,serialUnitIds:[serialId]});
  await custody.operate(db,ctx,agreement.id,'return',{requestKey:'recall-rental-return',lineId:rentalSerial.id,quantity:1,confirmed:'yes',serialUnitIds:[serialId]});
  const retailer=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'Consignment retailer',email:'retailer@example.test'});
  const consignment=await custody.create(db,ctx,{kind:'CONSIGN_OUT',customerId:retailer.id,requestKey:'recall-consignment',
    startDate:today,dueDate:today,inspectionParentLocationId:locationId,lines:[{skuId:batchSku,quantity:2,unitPriceMinor:400}]});
  const shipment={requestKey:'recall-consignment-dispatch',lineId:consignment.lines[0].id,quantity:2,confirmed:'yes',locationId,lotId};
  await custody.operate(db,ctx,consignment.id,'dispatch',shipment);
  assert.equal((await custody.operate(db,ctx,consignment.id,'dispatch',shipment)).replayed,true);
  await custody.operate(db,ctx,consignment.id,'sell',{requestKey:'recall-consignment-sale',lineId:consignment.lines[0].id,quantity:1,confirmed:'yes',lotId});

  const reviewTool=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const lotPath='/autopilot/reviews/recall-trace?filter=SUPPLIER-77';
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>app.locals.sessionStore.close());
  const browser=request.agent(app),login=await browser.get('/login');
  await browser.post('/login').type('form').send({_csrf:/name="_csrf" value="([^"]+)"/.exec(login.text)[1],email:f.email,password:f.password}).expect(302);
  for(const plan of ['starter','growth','pro','enterprise']){
    await subscribe(plan);
    const trace=await reviewTool.prepare(null,db,ctx,'',{agentJob:'recall-trace',search:'supplier-77'});
    const actual=trace.rows.map(row=>[row.Type,row.SKU,Number(row['Units issued']),row.Contact,row.link])
      .sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
    assert.deepEqual(actual,[
      ['Consignment','FITTINGS',2,'retailer@example.test','/custody/'+consignment.id],
      ['Rental','FITTINGS',2,'receiver@example.test','/custody/'+agreement.id],
      ['Rental','SERIAL-FITTING',1,'receiver@example.test','/custody/'+agreement.id]
    ],plan);
    const history=(await reviews.run(db,ctx,'serial-history',{filter:'track-17'})).rows;
    assert.deepEqual(history.map(row=>[row.Action,row.Direction]),[
      ['receive','In'],['transfer','Out'],['transfer','In'],['transfer','Out'],['transfer','In']
    ],plan);
    assert(history.every(row=>row.SKU==='SERIAL-FITTING'&&row.link==='/inventory/'+serial.itemId));
  }
  const page=await browser.get(lotPath).expect(200);
  assert.match(page.text,/Consignment/);
  await browser.get('/custody/'+agreement.id).expect(200);
  const stranger=await require('../../src/domain/postgres-auth-service').createBusiness(db,{
    name:'Other owner',businessName:'Another inventory',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
  await assert.rejects(reviews.run(db,{workspaceId:ctx.workspaceId,actorId:stranger.userId},'recall-trace',{filter:'SUPPLIER-77'}),/owner/);

  await controls.recall(db,ctx,{sku:'SERIAL-FITTING',lot:'SUPPLIER-77',action:'hold',revision:0,reason:'Supplier recall on this serial lot'});
  await custody.operate(db,ctx,agreement.id,'restock',{requestKey:'recall-serial-restock',lineId:rentalSerial.id,
    quantity:1,confirmed:'yes',locationId,serialUnitIds:[serialId]});
  const blocked=await custody.create(db,ctx,{kind:'CONSIGN_OUT',customerId:'fixture-customer',requestKey:'recall-blocked-consignment',
    startDate:today,dueDate:today,inspectionParentLocationId:locationId,lines:[{skuId:serialSku,quantity:1,unitPriceMinor:400}]});
  const sendSerial={requestKey:'recall-blocked-dispatch',lineId:blocked.lines[0].id,quantity:1,confirmed:'yes',locationId,serialUnitIds:[serialId]};
  await assert.rejects(custody.operate(db,ctx,blocked.id,'dispatch',sendSerial),error=>error.code==='lot_recalled');
  assert.equal(Number((await custody.get(db,ctx,blocked.id)).lines[0].external_quantity),0);
  assert.equal((await db.query('SELECT location_id FROM serial_units WHERE id=$1',[serialId])).rows[0].location_id,locationId);
});
