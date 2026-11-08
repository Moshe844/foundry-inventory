'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');
const reviews=require('../../src/autopilot/job-reviews');

test('monthly ABC classes use costed physical sales across the four plans and prioritize the next count',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:3}),{db,ctx,subscribe,browser}=f;
  const time=require('../../src/lib/business-time'),dates=require('../../src/accounting/customer-money'),catalog=require('../../src/domain/postgres-catalog-service');
  const start=(await time.today(db,ctx.workspaceId)).slice(0,7)+'-01',saleDay=dates.addDays(start,-2)+'T17:00:00Z',receiptDay=dates.addDays(start,-3)+'T17:00:00Z';
  const inventory=require('../../src/domain/postgres-inventory-engine'),receipts=require('../../src/accounting/postgres-stock-receipt'),issues=require('../../src/accounting/postgres-stock-removal');
  await subscribe('growth');
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ctx.workspaceId,receiptDay.slice(0,10)]);
  for(const [code,cost] of [['Z-HEAVY',80],['M-MEDIUM',15],['A-LIGHT',5],['U-UNKNOWN',null]]){
    const item=await catalog.createItem(db,ctx,{name:code,baseCode:code,trackingMode:'quantity'});
    const base={skuId:item.skuIds[0],locationId:f.location.id};
    await (cost===null?inventory:receipts).receive(db,ctx,{...base,quantity:cost===5?101:2,unitCost:cost,occurredAt:receiptDay,idempotencyKey:randomUUID()});
    await (cost===null?inventory:issues).issue(db,ctx,{...base,quantity:1,reasonCode:'sold',occurredAt:saleDay,idempotencyKey:randomUUID()});
  }
  const h=require('../../src/operations/postgres-runtime-handlers'),job={workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId},id:randomUUID()};
  await db.transaction(c=>h.autopilotEvaluate(job,c));
  assert.ok((await db.query("SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='planning.monthly-product-classes'",[ctx.workspaceId])).rowCount);
  const calculate=()=>db.transaction(c=>h.create()['planning.monthly-product-classes'](job,c));
  assert.equal((await calculate()).withSales,4);assert.equal((await calculate()).replayed,true);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const result=await reviews.run(db,ctx,'monthly-product-classes');
    const byCode=new Map(result.rows.map(r=>[r['Product code'],r]));
    for(const [key,label] of [['Z-HEAVY','A'],['M-MEDIUM','B'],['A-LIGHT','C'],['U-UNKNOWN','Review']])assert.equal(byCode.get(key).Class,label);
    assert.equal(byCode.get('Z-HEAVY')['Sale cost'],'$80.00');assert.equal(byCode.get('U-UNKNOWN')['Sale cost'],null);
    assert.deepEqual((await reviews.run(db,ctx,'monthly-product-classes',{filter:'B'})).rows.map(r=>r.Product),['M-MEDIUM']);
    await browser.get('/autopilot/reviews/monthly-product-classes').expect(200);
  }
  const priorities=(await reviews.run(db,ctx,'count-priorities')).rows;assert.equal(priorities[0].SKU,'Z-HEAVY');
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.product_class_months WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});

test('dated orders forecast weekly demand and posted stock issues quantify the margin at risk across plans',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:250});
  const {db,ctx,subscribe,browser,workflows}=f,sku=f.item.skuIds[0];
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  await subscribe('pro');
  const pricing=require('../../src/pricing/postgres-service');
  await pricing.setPrice(db,ctx,{skuId:sku,amountMinor:1200,currency:'USD'});
  await pricing.setPurchaseCost(db,ctx,{skuId:sku,amountMinor:300,currency:'USD'});
  for(let weeks=15;weeks>=1;weeks--){
    const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
      orderDate:addDays(today,-weeks*7),idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:7,unitPriceMinor:1200}]});
    await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
  }
  const catalog=require('../../src/domain/postgres-catalog-service');
  const launch=await catalog.createItem(db,ctx,{name:'New fixture part',baseCode:'NEWPART',trackingMode:'quantity'});
  const unrelated=await catalog.createItem(db,ctx,{name:'New unrelated item',baseCode:'OTHERPART',trackingMode:'quantity'});
  await db.query(`INSERT INTO catalogue_item_facts(workspace_id,item_id,category,facts,created_at,updated_at)
    VALUES($1,$2,'Parts','{}',now()::text,now()::text),($1,$3,'Parts','{}',now()::text,now()::text)`,[ctx.workspaceId,f.item.itemId,launch.itemId]);
  const code=async id=>(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0].code;
  const launchCode=await code(launch.skuIds[0]),unrelatedCode=await code(unrelated.skuIds[0]);
  const shipment=await f.parcel({quantity:3});
  await f.shipping.markPacked(db,ctx,shipment.shipmentId);
  await f.shipping.handoff(db,ctx,shipment.shipmentId,{handover:'CARRIER',carrier:'UPS',trackingNumber:'FORECAST-TEST'});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const forecast=await reviews.run(db,ctx,'seasonal-demand',{filter:await code(sku)});
    const newProduct=()=>reviews.run(db,ctx,'new-product-forecast',{filter:launchCode});
    if(tier==='starter')await assert.rejects(newProduct(),e=>e.code==='entitlement_required');
    else if(tier==='growth')assert.deepEqual((await newProduct()).rows,[{Suggestion:'Consider about 30 units for '+launchCode+' over its first 30 days.'}]);
    else{
      const related=(await newProduct()).rows[0];
      assert.equal(related['Comparable SKUs'],1);assert.equal(related['Estimated units in 30 days'],30);
      const missing=(await reviews.run(db,ctx,'new-product-forecast',{filter:unrelatedCode})).rows[0];
      assert.equal(missing['Comparable SKUs'],0);assert.equal(missing['Estimated units in 30 days'],null);
    }
    if(tier==='starter'){
      assert.deepEqual(Object.keys(forecast.rows[0]),['Suggestion']);
      assert.match(forecast.rows[0].Suggestion,/7 units/);
      await assert.rejects(reviews.run(db,ctx,'seasonal-demand',{scheduled:true}),e=>e.code==='entitlement_required');
    }else{
      assert.equal(forecast.rows[0]['Forecast method'],'Day-of-week pattern');
      assert.equal(forecast.rows[0]['Next 7 days'],7);
      assert.equal(forecast.rows[0]['Next 30 days'],35);
      assert.equal(forecast.rows[0]['Holdout error (units/day)'],0);
    }
    const runout=(await reviews.run(db,ctx,'stockout-cost',{filter:await code(sku)})).rows[0];
    assert.equal(runout['Estimated daily gross margin at risk'],'$0.30');
    assert.equal(runout['Available now'],142);
    assert.equal(runout['Estimated runout'],addDays(today,4260));
    assert.ok((await browser.get('/autopilot/reviews/stockout-cost').expect(200)).text.includes('$0.30'));
  }
});

test('a saved prose answer downloads as Excel and PDF on all four plans',{timeout:240000},async t=>{
  const {db,ctx,subscribe,browser}=await require('../helpers/agent-workflow-fixture').fixture(t);
  const store=require('../../src/assistant/postgres-goal-store');
  const id=randomUUID(),answer='We received four cases.\nThe fifth case is still due.';
  await db.query(`INSERT INTO stockchief_runtime.assistant_interactions(id,workspace_id,actor_user_id,message,intent,answer,status)
    VALUES($1,$2,$3,'What is still due?','{}',$4,'ANSWERED')`,[id,ctx.workspaceId,ctx.actorId,answer]);
  const goal=await store.create(db,ctx,'What is still due?');
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',answer=$2 WHERE id=$1",[goal.id,answer]);
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    for(const base of ['/ask/answers/'+id,'/ask/goals/'+goal.id]){
      const csv=await browser.get(base+'/export.csv?content=answer').expect(200);
      assert.ok(csv.text.includes('The fifth case is still due.'));
      for(const [fmt,signature] of [['pdf','%PDF-'],['xlsx','PK']]){
        const response=await browser.get(base+'/export.'+fmt+'?content=answer').buffer(true).parse((res,end)=>{
          const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>end(null,Buffer.concat(chunks)));
        }).expect(200);
        assert.equal(response.body.subarray(0,signature.length).toString(),signature);
      }
    }
  }
});
