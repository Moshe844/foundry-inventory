'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');
const reviews=require('../../src/autopilot/job-reviews');
const notices=require('../../src/autopilot/operational-notices');
const modes=require('../../src/autopilot/job-modes');

test('native customer activity scores compare actual local shipments and notify only eligible current plans',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:36,timeZone:'America/New_York'});
  const {db,ctx,owner,subscribe,workflows,browser,location,item}=f;
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const boundary=addDays(today,-29);
  const customer='fixture-customer';
  const another=await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'New buyer'});
  const path='/autopilot/reviews/customer-health';
  await db.query("UPDATE accounts SET created_at=(now()-interval '40 days')::text WHERE id=$1",[owner.accountId]);
  await subscribe('growth');
  const order=async(customerId,quantity)=>workflows.createSalesOrder(db,ctx,{
    customerId,currency:'USD',deliveryMethod:'PICKUP',fulfillmentLocationId:location.id,
    lines:[{skuId:item.skuIds[0],quantity,unitPriceMinor:1200}],idempotencyKey:randomUUID()});
  const ship=async(customerId,quantity,at)=>{
    const sale=await order(customerId,quantity);
    await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});
    const fulfilled=await workflows.fulfillSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID(),shipment:{handover:'COLLECTED'},
      lines:[{lineId:sale.lineIds[0],locationId:location.id,quantity}]});
    assert.equal(fulfilled.shipments.length,1);
    await db.query('UPDATE sales_shipments SET shipped_at=$3 WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,sale.salesOrderId,at]);
  };
  await ship(customer,8,boundary+'T01:00:00Z');
  await ship(customer,2,boundary+'T16:00:00Z');
  await ship(another.id,1,today+'T16:00:00Z');
  await ship(customer,3,addDays(today,5)+'T16:00:00Z');
  await order(customer,7);
  const run=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const inbox=async()=>(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).find(n=>n.sourceId==='agent-notice-88');
  const reviewed=()=>reviews.run(db,ctx,'customer-health');
  const source=async()=>(await db.query(`SELECT resolved,reminders FROM stockchief_runtime.agent_operational_notices
    WHERE workspace_id=$1 AND job_id=88 AND reference=$2`,[ctx.workspaceId,customer])).rows[0];
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    await run();
    const result=await reviewed();
    if(tier==='starter'){
      assert.deepEqual(result.rows,[{Suggestion:'Review the ordering history for Receiver. Buying less.'}]);
      await assert.rejects(reviews.run(db,ctx,'customer-health',{scheduled:true}),e=>e.code==='entitlement_required');
      assert.equal(await inbox(),undefined);
    }else{
      const row=result.rows.find(r=>r.Customer==='Receiver');
      assert.deepEqual([row.Health,row['Activity score'],Number(row['Prior orders']),Number(row['Recent orders']),Number(row['Products with fewer shipped units'])],
        ['Buying less',63,1,1,1]);
      const first=result.rows.find(r=>r.Customer==='New buyer');
      assert.deepEqual([first.Health,first['Activity score']],['New activity',null]);
      assert.equal((await inbox()).href,path);
      assert.deepEqual(await source(),{resolved:false,reminders:1});
      const page=await browser.get(path+'?filter=Receiver').expect(200);
      assert.match(page.text,/Buying less/);
      assert.match(page.text,/Activity score/);
      assert.doesNotMatch(page.text,/New buyer/);
    }
  }
  await modes.save(db,ctx,88,{mode:'watch',revision:0});
  assert.equal(await inbox(),undefined);
  await run();assert.equal((await source()).resolved,true);
  await modes.save(db,ctx,88,{mode:'routine',revision:1});
  await run();assert.equal((await source()).resolved,false);
  await subscribe('starter');assert.equal(await inbox(),undefined);
  await subscribe('growth');
  await ship(customer,6,boundary+'T18:00:00Z');
  await run();
  assert.equal(await inbox(),undefined);
  assert.equal((await source()).resolved,true);
  const row=(await reviewed()).rows.find(r=>r.Customer==='Receiver');
  assert.deepEqual([row.Health,row['Activity score']],['Buying more',100]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM customer_communications WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
