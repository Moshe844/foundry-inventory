'use strict';

process.env.NODE_ENV='test';
const {randomUUID}=require('node:crypto');
const test=require('node:test'),assert=require('node:assert/strict');
const reviews=require('../../src/autopilot/job-reviews');
const receipt=require('../../src/accounting/postgres-stock-receipt');
const catalog=require('../../src/domain/postgres-catalog-service');
const pricing=require('../../src/pricing/postgres-service');

test('turns, gross margin return and days of supply reconcile to sales, costs and physical stock',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10});
  const {db,ctx,subscribe,workflows}=f,sku=f.item.skuIds[0];
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await subscribe('enterprise');
  const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',fulfillmentLocationId:f.location.id,deliveryMethod:'SHIP',
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:2,unitPriceMinor:300}]});
  await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:2}]});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const [row]=(await reviews.run(db,ctx,'stock-health',{filter:code})).rows;
    if(tier==='starter')assert.deepEqual(Object.keys(row),['Suggestion']);
    else{
      assert.equal(row['Valuation check'],'Matches the stock ledger');
      assert.equal(row['Days measured'],1);assert.equal(row['Average stock value'],'$8.00');
      assert.equal(row['Inventory turns'],0.25);assert.equal(row.GMROI,0.5);assert.equal(row['Days of supply'],4);
    }
  }
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:1,idempotencyKey:randomUUID()});
  const [uncosted]=(await reviews.run(db,ctx,'stock-health',{filter:code})).rows;
  assert.equal(uncosted.GMROI,null);assert.equal(uncosted['Inventory turns'],null);assert.equal(uncosted['Days of supply'],4.5);
});

test('clearance and aging use held stock and actual receipt dates, without changing prices or inventory',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t);
  const {db,ctx,subscribe,browser,location}=f;
  await subscribe('enterprise');
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const old=require('../../src/accounting/customer-money').addDays(today,-210);
  async function seed(code,trackingMode,qty,date,extra={}){
    const item=await catalog.createItem(db,ctx,{name:code,baseCode:code,trackingMode,purchaseCost:'2'});
    const sku=item.skuIds[0];
    const occurredAt=date===today?new Date().toISOString():date+'T12:00:00Z';
    await receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity:qty,occurredAt,idempotencyKey:randomUUID(),...extra});
    return sku;
  }
  const sku=await seed('CLEAR-OLD','quantity',10,old);
  await seed('CLEAR-NEW','quantity',5,today);
  await seed('CLEAR-LOT','lot',4,old,{lotCode:'BATCH-A',lotReceivedAt:old});
  await seed('CLEAR-SERIAL','serial',1,old,{serials:['AGE-01']});
  await pricing.setPrice(db,ctx,{skuId:sku,amountMinor:999,currency:'USD'});
  const read=(key,filter,change)=>reviews.run(db,ctx,key,{filter,change});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const slow=(await read('slow-stock','CLEAR-OLD')).rows;
    const plan=(await read('clearance-plan','CLEAR-OLD',25)).rows;
    const aged=(await read('stock-age','CLEAR-LOT')).rows;
    const cash=await reviews.run(db,ctx,'cash-in-stock',{filter:'CLEAR-OLD',scheduled:true});
    assert.equal(cash.mode,'alone',tier);
    assert.match(cash.summary,/Recorded stock value across the inventory/);
    assert.deepEqual(cash.rows.map(row=>[row.SKU,row['Clearance units'],row['Allocated book value']]),[['CLEAR-OLD',10,'$20.00']],tier);
    if(tier==='starter'){
      for(const row of [slow[0],plan[0],aged[0]])assert.deepEqual(Object.keys(row),['Suggestion']);
      const page=await browser.get('/autopilot/reviews/clearance-plan').expect(200);
      assert.match(page.text,/Proposed markdown/);
    }else{
      assert.equal(slow[0].Finding,'Never sold');
      assert.equal(plan[0]['Clearance units'],10);
      assert.equal(plan[0]['Proposed unit price'],'$7.49');assert.equal(plan[0]['Gross proceeds if sold'],'$74.90');
      assert.equal(aged[0]['Days since receipt'],210);assert.equal(aged[0]['Lot or serial'],'BATCH-A');
      assert.equal((await read('stock-age','CLEAR-SERIAL')).rows[0]['Lot or serial'],'AGE-01');
      assert.equal((await read('stock-age','CLEAR-OLD')).rows[0]['Days since receipt'],210);
    }
    assert.deepEqual((await read('slow-stock','CLEAR-NEW')).rows,[]);
    assert.deepEqual((await read('cash-in-stock','CLEAR-NEW')).rows,[]);
    await assert.rejects(reviews.run(db,ctx,'clearance-plan',{scheduled:true,trained:true,change:25}),e=>e.code==='entitlement_required');
  }
  const unknown=(await read('clearance-plan','CLEAR-LOT',25)).rows[0];assert.equal(unknown['Gross proceeds if sold'],null);
  await receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity:2,idempotencyKey:randomUUID()});
  assert.deepEqual((await read('stock-age','CLEAR-OLD')).rows.map(row=>[row['Days since receipt'],row.Units]),[[210,10],[0,2]]);
  assert.equal((await read('clearance-plan','CLEAR-OLD',100)).rows[0]['Gross proceeds if sold'],'$0.00');
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:3,unitPriceMinor:999}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  assert.equal((await read('clearance-plan','CLEAR-OLD',0)).rows[0]['Clearance units'],9);
  const destination=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second clearance warehouse',kind:'warehouse'});
  await require('../../src/transfers/postgres-transfer-service').request(db,ctx,{fromLocationId:location.id,toLocationId:destination.id,
    expectedArrivalDate:today,idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:2}]});
  const [reserved]=(await read('cash-in-stock','CLEAR-OLD')).rows;
  assert.deepEqual([reserved['Clearance units'],reserved['Recorded position value'],reserved['Allocated book value']],[7,'$24.00','$14.00']);
  await require('../../src/autopilot/lot-controls').recall(db,ctx,{sku:'CLEAR-LOT',lot:'BATCH-A',action:'hold',revision:0,reason:'Supplier recalled this batch'});
  assert.deepEqual((await read('cash-in-stock','CLEAR-LOT')).rows,[]);
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:sku,locationId:location.id,quantity:1,idempotencyKey:randomUUID()});
  const unclear=await read('cash-in-stock','CLEAR-OLD');
  assert.match(unclear.summary,/incomplete cost records/);
  assert.equal(unclear.rows[0]['Allocated book value'],'Needs cost review');
  const cashPage=await browser.get('/autopilot/reviews/cash-in-stock?filter=CLEAR-OLD').expect(200);
  assert.match(cashPage.text,/Review cash tied up in stock/);
  const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.agent_review');
  const exactCash=await ask.prepare(null,db,ctx,'',{agentJob:'cash-in-stock',search:'CLEAR-OLD'});
  assert.equal(exactCash.rows[0].SKU,'CLEAR-OLD');
  await assert.rejects(read('clearance-plan','CLEAR-OLD',101),/0% to 100%/);
  assert.equal((await pricing.currentPrice(db,ctx.workspaceId,sku)).amount_minor,999);
});
