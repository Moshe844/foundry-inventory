'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const accounts=require('../../src/shipping/postgres-accounts');
const shipping=require('../../src/shipping/postgres-service');

test('multi-provider quotes retain account ownership, purchase once and isolate webhook identities',{timeout:240000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster();
  const db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});
  await require('../../src/db/migrate-postgres').migratePostgres(db);
  const auth=require('../../src/domain/postgres-auth-service');
  const owner=await auth.createBusiness(db,{name:'Owner',businessName:'Own shipping accounts',email:randomUUID()+'@example.test',password:randomUUID()+'!A'});
  const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
  const connected={};
  for(const [provider,apiKey]of [['easypost','EZTK_disposable_easy'],['shipstation','TEST_disposable_station'],['shippo','shippo_test_disposable_po']]){
    connected[provider]=await accounts.connect(db,ctx,{provider,apiKey,webhookSecret:provider+'-private-secret'});
  }
  assert.equal((await db.query("SELECT count(*)::int n FROM workspace_connectors WHERE workspace_id=$1 AND status='connected'",[ctx.workspaceId])).rows[0].n,3,'connecting an account preserves the other providers');
  for(const provider of Object.keys(connected))assert.equal((await accounts.forWorkspace(db,ctx.workspaceId,{provider})).provider,provider);
  const other=await auth.createBusiness(db,{name:'Other',businessName:'Other shipping accounts',email:randomUUID()+'@example.test',password:randomUUID()+'!A'});
  assert.equal(await accounts.forWorkspace(db,other.workspaceId,{connectorId:connected.easypost.connectorId}),null);
  const rawConnectors=(await db.query('SELECT config,credential_ref FROM workspace_connectors WHERE workspace_id=$1',[ctx.workspaceId])).rows;
  assert.doesNotMatch(JSON.stringify(rawConnectors),/disposable_easy|disposable_station|disposable_po|private-secret/);

  const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Dispatch room',kind:'warehouse',address:'1 Main St, Monroe, NY 10950',phone:'845-555-0100'});
  const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Dispatch widget',baseCode:'DISPATCH-BOX',trackingMode:'quantity',unitLabel:'unit'});
  const workflows=require('../../src/operations/postgres-business-workflows');
  const at=new Date().toISOString();
  await db.query(`INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) VALUES('dispatch-supplier',$1,'Parts supplier','active','USD',$2,$2)`,[ctx.workspaceId,at]);
  await db.query(`INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,record_state,created_by_user_id,created_at,updated_at)
    VALUES('dispatch-buyer',$1,'Test buyer','test@example.test','518-555-0100','10 Jobsite Rd, Albany, NY 12207','ACTIVE',$2,$3,$3)`,[ctx.workspaceId,ctx.actorId,at]);
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'dispatch-supplier',destinationLocationId:location.id,idempotencyKey:'dispatch-po',lines:[{skuId:item.skuIds[0],quantityUnits:10,unitCost:1}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'dispatch-po-approve'});
  await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'dispatch-po-place'});
  await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'dispatch-receipt',reference:'DISPATCH-RECEIPT',lines:[{lineId:po.lineIds[0],quantity:10,locationId:location.id}]});
  const prepare=async suffix=>{
    const order=await workflows.createSalesOrder(db,ctx,{customerId:'dispatch-buyer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,idempotencyKey:'order-'+suffix,lines:[{skuId:item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:'confirm-'+suffix});
    const shipment=await shipping.prepare(db,ctx,order.salesOrderId,{idempotencyKey:'prepare-'+suffix,lines:[{lineId:order.lineIds[0],locationId:location.id,quantity:1}]});
    await shipping.setPackages(db,ctx,shipment.shipmentId,[{weightGrams:350,lengthMm:200,widthMm:150,heightMm:100}]);
    return shipment;
  };
  const parcel=await prepare('one'),quoteCalls=[],buyCalls=[];let unavailableProvider=null,foreignCurrencyProvider=null;
  const providerResolver=provider=>({
    async quote(providerCtx){
      assert.equal(providerCtx[accounts.KEY_FIELD[provider]],(await accounts.forWorkspace(db,ctx.workspaceId,{provider})).apiKey);
      quoteCalls.push(provider);
      if(provider===unavailableProvider)throw Object.assign(Error('Disposable carrier unavailable'),{status:503});
      return {providerShipmentIds:[provider+'-parcel'],rates:[{rateId:'same-rate-id',carrier:'ups',service:'Ground',amountMinor:provider==='shippo'?700:900,currency:provider===foreignCurrencyProvider?'CAD':'USD',deliveryDays:3}]};
    },
    async buy(providerCtx,input){
      assert.equal(providerCtx[accounts.KEY_FIELD[provider]],(await accounts.forWorkspace(db,ctx.workspaceId,{provider})).apiKey);
      assert.deepEqual(input.providerShipmentIds,[provider+'-parcel']);
      buyCalls.push(provider);
      return {providerShipmentId:provider+'-parcel',providerLabelIds:[provider+'-label'],carrier:'ups',service:'Ground',trackingNumber:'TRACK-OWNER',trackingUrl:'https://example.test/track',labelUrl:'https://example.test/label.pdf',labelFormat:'PDF',amountMinor:700,currency:'USD'};
    },readEvent:event=>event
  });
  const quoted=await shipping.quote(db,ctx,parcel.shipmentId,{providerResolver,idempotencyKey:'multi-quote'});
  assert.deepEqual(quoteCalls.sort(),['easypost','shippo','shipstation']);
  assert.equal(quoted.rates.length,3,'same service and rate id from different providers remain distinct offers');
  assert.equal(quoted.rates[0].provider,'shippo');
  const rate=quoted.rates[0];
  assert.equal(rate.connector_id,connected.shippo.connectorId);
  const queued=await shipping.queueLabelPurchase(db,ctx,parcel.shipmentId,rate.id,{idempotencyKey:'buy-one'});
  assert.equal((await shipping.queueLabelPurchase(db,ctx,parcel.shipmentId,rate.id,{idempotencyKey:'buy-one'})).replayed,true);
  await assert.rejects(shipping.quote(db,ctx,parcel.shipmentId,{providerResolver,idempotencyKey:'must-not-requote'}),/pending|purchas|label/i);
  await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider:providerResolver('shippo')});
  await shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,queued.effectId,{provider:providerResolver('shippo')});
  assert.deepEqual(buyCalls,['shippo']);
  const balance=async()=>Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,item.skuIds[0],location.id])).rows[0].on_hand);
  assert.equal(await balance(),10,'buying a label cannot remove physical stock');
  const interrupted={query:(...args)=>db.query(...args),transaction:async operation=>db.transaction(client=>operation({query:async(sql,values)=>{
    if(/UPDATE sales_shipments SET status=/.test(sql)&&sql.includes('handover='))throw Error('Disposable failure before shipment confirmation');
    return client.query(sql,values);
  }}),{isolation:'SERIALIZABLE',retrySafe:false})};
  await assert.rejects(shipping.handoff(interrupted,ctx,parcel.shipmentId,{idempotencyKey:'interrupted-handoff'}),/Disposable failure/);
  assert.equal(await balance(),10,'a failure saving shipment state rolls back stock and accounting in the same transaction');
  await Promise.all([shipping.handoff(db,ctx,parcel.shipmentId,{idempotencyKey:'handoff-one'}),
    shipping.handoff(db,ctx,parcel.shipmentId,{idempotencyKey:'handoff-second-click'})]);
  assert.equal(await balance(),9,'physical handoff deducts once even with a fresh browser request key');

  const wrongProvider=await shipping.receiveProviderEvent(db,ctx,'easypost',{externalEventId:'foreign-id',providerShipmentId:'shippo-parcel',status:'DELIVERED'},{provider:providerResolver('easypost')});
  assert.equal(wrongProvider.applied,false);
  const partialId=await shipping.receiveProviderEvent(db,ctx,'shippo',{externalEventId:'partial-id',providerShipmentId:'parcel',status:'DELIVERED'},{provider:providerResolver('shippo')});
  assert.equal(partialId.applied,false,'a partial provider shipment id cannot match');
  const event={externalEventId:'delivery-one',providerShipmentId:'shippo-parcel',status:'DELIVERED',occurredAt:at};
  assert.equal((await shipping.receiveProviderEvent(db,ctx,'shippo',event,{provider:providerResolver('shippo')})).applied,true);
  assert.equal((await shipping.receiveProviderEvent(db,ctx,'shippo',event,{provider:providerResolver('shippo')})).replayed,true);
  assert.equal(await balance(),9,'tracking never reissues stock');

  const second=await prepare('two');
  const secondRates=await shipping.quote(db,ctx,second.shipmentId,{providerResolver,idempotencyKey:'quote-two'});
  await assert.rejects(shipping.queueLabelPurchase(db,ctx,second.shipmentId,secondRates.rates[0].id,{idempotencyKey:'buy-one'}),/different|another/i);
  const rotated=secondRates.rates.find(r=>r.provider==='easypost');
  await accounts.connect(db,ctx,{provider:'easypost',apiKey:'EZTK_rotated_different_account'});
  await assert.rejects(shipping.queueLabelPurchase(db,ctx,second.shipmentId,rotated.id,{idempotencyKey:'rotated-key-buy'}),/changed|fresh|quote|account/i);
  const third=await prepare('three'),thirdRates=await shipping.quote(db,ctx,third.shipmentId,{providerResolver,idempotencyKey:'quote-three'});
  const stationRate=thirdRates.rates.find(r=>r.provider==='shipstation');
  const stationQueued=await shipping.queueLabelPurchase(db,ctx,third.shipmentId,stationRate.id,{idempotencyKey:'station-queued'});
  await accounts.connect(db,ctx,{provider:'shipstation',apiKey:'TEST_changed_before_worker'});
  await assert.rejects(shipping.executeLabelPurchaseEffect(db,ctx.workspaceId,stationQueued.effectId,{provider:providerResolver('shipstation')}),/changed|fresh|account/i);
  assert.deepEqual(buyCalls,['shippo'],'the worker cannot substitute a new account for an approved quote');
  assert.equal((await shipping.requireShipment(db,ctx.workspaceId,third.shipmentId)).label_status,'FAILED');
  assert.equal((await shipping.quote(db,ctx,third.shipmentId,{providerResolver,idempotencyKey:'fresh-after-stopped-buy'})).rates.length,3);
  await accounts.disconnect(db,ctx,{connectorId:connected.shippo.connectorId});
  assert.equal(await accounts.forWorkspace(db,ctx.workspaceId,{provider:'shippo'}),null);
  assert.equal((await accounts.forWorkspace(db,ctx.workspaceId,{provider:'shipstation'})).provider,'shipstation');
  unavailableProvider='easypost';
  const partial=await shipping.quote(db,ctx,second.shipmentId,{providerResolver,idempotencyKey:'one-provider-unavailable'});
  assert.equal(partial.rates.length,1);
  assert.equal(partial.quoteProblems[0].provider,'easypost');
  assert.equal((await shipping.state(db,ctx.workspaceId,second.shipmentId)).quoteProblems.length,1,'partial quote failures survive page navigation');
  unavailableProvider=null;foreignCurrencyProvider='shipstation';
  const currencySafe=await shipping.quote(db,ctx,second.shipmentId,{providerResolver,idempotencyKey:'currency-safe-quote'});
  assert.equal(currencySafe.rates.length,1,'prices in different currencies cannot compete as though they were the same money');
  assert.equal(currencySafe.rates[0].currency,'USD');
  assert.equal(currencySafe.quoteProblems[0].provider,'shipstation');
  assert.match(currencySafe.quoteProblems[0].message,/currency/i);
  assert.equal(await balance(),9);
  t.diagnostic('Real local PostgreSQL; simulated carrier adapters. No provider or postage calls.');
});
