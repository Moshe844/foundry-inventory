'use strict';
process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {addDays}=require('../../src/accounting/customer-money');
const reviews=require('../../src/autopilot/job-reviews');
const playbooks=require('../../src/autopilot/playbooks');

test('supplier scorecards distinguish timely, late and incomplete orders, checked bills and comparable prices on each plan',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4,timeZone:'America/New_York'});
  const {db,ctx,owner,workflows,subscribe,location,item,browser}=f;
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[owner.accountId]);
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
  const path='/autopilot/reviews/supplier-scorecard';
  const supplier='fixture-supplier',sku=item.skuIds[0];
  const other=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:'Another supplier',currency:'USD'});
  const first=(await db.query('SELECT id FROM purchase_orders WHERE workspace_id=$1 AND supplier_id=$2',[ctx.workspaceId,supplier])).rows[0].id;
  await db.query('UPDATE purchase_orders SET expected_date=$3,ordered_at=$4 WHERE workspace_id=$1 AND id=$2',
    [ctx.workspaceId,first,today,addDays(today,-9)+'T13:00:00Z']);
  const create=async(supplierId,units,cost,expected,currency='USD')=>{
    const order=await workflows.createPurchaseOrder(db,ctx,{supplierId,currency,destinationLocationId:location.id,
      expectedDate:expected,lines:[{skuId:sku,quantityUnits:units,unitCost:cost}],idempotencyKey:randomUUID()});
    await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    return order;
  };
  const receive=(po,quantity)=>workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:po.lineIds[0],locationId:location.id,quantity}]});
  const late=await create(supplier,4,2,addDays(today,-3));
  await receive(late,4);
  const short=await create(supplier,8,2,addDays(today,-2));
  await receive(short,4);
  await create(supplier,10,2,addDays(today,5));
  await receive(await create(other.id,3,3,today),3);
  const firstLine=(await db.query('SELECT id FROM purchase_order_lines WHERE workspace_id=$1 AND purchase_order_id=$2',
    [ctx.workspaceId,first])).rows[0].id;
  const bill=(po,line,price)=>workflows.recordSupplierInvoice(db,ctx,{supplierId:supplier,purchaseOrderId:po,
    supplierInvoiceNumber:randomUUID(),issueDate:today,dueDate:today,currency:'USD',idempotencyKey:randomUUID(),
    lines:[{purchaseOrderLineId:line,skuId:sku,quantity:1,unitCostMinor:price}]});
  assert.equal((await bill(first,firstLine,100)).status,'OPEN');
  assert.equal((await bill(late.purchaseOrderId,late.lineIds[0],300)).status,'DISPUTED');
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const data=await reviews.run(db,ctx,'supplier-scorecard',{filter:'Fixture parts'});
    if(tier==='starter'){
      assert.deepEqual(data.rows,[{Suggestion:'Review Fixture parts using its 4 recorded purchase orders.'}]);
      await assert.rejects(reviews.run(db,ctx,'supplier-scorecard',{scheduled:true}),e=>e.code==='entitlement_required');
    }else{
      const [score]=data.rows;
      assert.deepEqual([score['Reliability score'],...['Placed orders','On time %','Filled %','Dated completed orders','Overdue open orders',
        'Comparable prices','Price increases','Bill errors','Matched bills reviewed'].map(key=>Number(score[key]))],
        [61,4,50,83.3,2,1,3,1,1,2]);
      assert.equal(score.link,'/suppliers/'+supplier);
      const page=await browser.get(path+'?filter=Fixture+parts').expect(200);
      assert.match(page.text,/Reliability score/);
      await browser.get(score.link).expect(200);
      const otherScore=(await reviews.run(db,ctx,'supplier-scorecard',{filter:'Another supplier'})).rows[0];
      assert.deepEqual([Number(otherScore['Placed orders']),Number(otherScore['Filled %']),Number(otherScore['Bill errors'])],[1,100,0]);
    }
  }
  await subscribe('growth');
  const id=await playbooks.create(db,ctx,{name:'Supplier reliability',cadence:'daily',steps:['supplier-scorecard','low-stock']});
  await db.query("UPDATE stockchief_runtime.agent_playbooks SET next_at=now()-interval '1 minute' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,id]);
  await db.transaction(playbooks.schedule);
  const queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const job=await queue.processOne(db,handlers,{owner:'supplier-scorecard-test',kinds:['agent.playbook']});
  assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));
  assert.equal(job.result[0].rows.find(row=>row.Supplier==='Fixture parts')['Reliability score'],61);
  await subscribe('starter');
  const after=(await playbooks.list(db,ctx)).books.find(row=>row.id===id);
  assert.equal(after.result,null);
});
