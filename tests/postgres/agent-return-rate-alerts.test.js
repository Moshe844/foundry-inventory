'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const returns=require('../../src/operations/postgres-returns');
const commerce=require('../../src/operations/postgres-commerce');
const catalog=require('../../src/domain/postgres-catalog-service');
const reviews=require('../../src/autopilot/job-reviews');
const notices=require('../../src/autopilot/operational-notices');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const queue=require('../../src/operations/postgres-job-queue');

test('return rate alerts follow physical receipts, stocking units, history and current owner authority',{timeout:240000},async t=>{
  const f=await fixture(t,{units:12});
  const {db,ctx,owner,subscribe,browser,workflows}=f;
  const sku=f.item.skuIds[0],locationId=f.location.id;
  const comparisonCustomer=await commerce.createCustomer(db,ctx,{name:'Occasional returns'});
  const peer=await catalog.createItem(db,ctx,{name:'Comparable pieces',baseCode:'PEER-PIECES',trackingMode:'quantity'});
  const weight=await catalog.createItem(db,ctx,{name:'Measured goods',baseCode:'MEASURED-KG',trackingMode:'quantity'});
  await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,weight.itemId,
    {unitLabel:'kg',quantityPrecision:2,quantityIncrement:'0.01'}));
  const quantities=[24,5];
  const purchase=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:locationId,
    idempotencyKey:randomUUID(),lines:[peer,weight].map((item,index)=>({skuId:item.skuIds[0],quantityUnits:quantities[index],unitCost:1}))});
  await workflows.approvePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID(),
    lines:purchase.lineIds.map((lineId,index)=>({lineId,locationId,quantity:quantities[index]}))});
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=(now()-interval '21 days')::text WHERE id=$1",[owner.accountId]);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  async function sell(skuId,customerId,quantity,fulfilled=true){
    const order=await workflows.createSalesOrder(db,ctx,{customerId,deliveryMethod:'PICKUP',
      fulfillmentLocationId:locationId,idempotencyKey:randomUUID(),lines:[{skuId,quantity,unitPriceMinor:1200}]});
    if(fulfilled){
      await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
      await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),
        lines:[{lineId:order.lineIds[0],locationId,quantity}]});
    }
    return order;
  }
  async function authorize(order,quantity){
    const {customerReturnId}=await returns.requestCustomerReturn(db,ctx,{salesOrderId:order.salesOrderId,
      quarantineLocationId:locationId,resolution:'NO_REFUND',idempotencyKey:randomUUID(),
      lines:[{salesOrderLineId:order.lineIds[0],quantity}]});
    await returns.authorizeCustomerReturn(db,ctx,customerReturnId,{idempotencyKey:randomUUID()});
    const {rows:[{id,return_number:number}]}=await db.query(`SELECT l.id,r.return_number FROM customer_return_lines l
      JOIN customer_returns r ON r.workspace_id=l.workspace_id AND r.id=l.customer_return_id
      WHERE l.workspace_id=$1 AND r.id=$2`,[ctx.workspaceId,customerReturnId]);
    return {number,receive:(received=quantity)=>returns.receiveCustomerReturn(db,ctx,customerReturnId,
      {idempotencyKey:randomUUID(),lines:[{lineId:id,quantity:received}]})};
  }
  const firstOrder=await sell(sku,'fixture-customer',4),secondOrder=await sell(sku,'fixture-customer',4);
  await sell(sku,'fixture-customer',100,false);
  const low=await authorize(await sell(peer.skuIds[0],comparisonCustomer.id,20),1);
  const measured=await authorize(await sell(weight.skuIds[0],'fixture-customer',1.25),0.25);
  const first=await authorize(firstOrder,2),second=await authorize(secondOrder,2);
  const refresh=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const review=(filter='')=>reviews.run(db,ctx,'customer-return-rates',{filter});
  const notice=async(actor=ctx.actorId)=>(await notices.inbox(db,ctx.workspaceId,actor)).find(n=>n.sourceId==='agent-notice-116');
  const countNotices=async()=>(await db.query(`SELECT count(*)::int AS total,count(*) FILTER (WHERE NOT resolved)::int AS active
    FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=116`,[ctx.workspaceId])).rows[0];
  assert.deepEqual((await review()).rows,[],'authorizations do not count');
  await first.receive(1);
  await first.receive(1);
  await low.receive();
  await measured.receive();
  await refresh();
  assert.equal(await notice(),undefined,'split receipts of one return cannot trigger a high-rate notice');
  const skuRow=(await review()).rows.find(row=>row.link==='/inventory/'+f.item.itemId);
  assert.equal(skuRow['Physical returns'],1);
  assert.equal(skuRow['Received return references'],first.number);
  await second.receive();

  const businessRecords=async()=>(await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sales_orders o WHERE o.workspace_id=$1) AS orders,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM customer_returns r WHERE r.workspace_id=$1) AS returns,
    (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,
    (SELECT count(*) FROM accounting_sale_refunds WHERE workspace_id=$1) AS refunds,
    (SELECT count(*) FROM purchase_orders WHERE workspace_id=$1) AS purchases,
    (SELECT count(*) FROM customer_communications WHERE workspace_id=$1) AS messages,
    (SELECT count(*) FROM stockchief_runtime.agent_draft_rules WHERE workspace_id=$1) AS training`,[ctx.workspaceId])).rows[0];
  const businessBefore=await businessRecords();
  await subscribe('starter');
  await refresh();
  const suggestion=await review();
  assert.equal(suggestion.rows.length,1);
  assert.match(suggestion.rows[0].Suggestion,/4 of 8 fulfilled unit.*High return rate/);
  assert.equal(await notice(),undefined);
  assert.deepEqual(await countNotices(),{total:0,active:0});

  await subscribe('growth');
  // Native stock changes defer the next scan briefly to coalesce activity.
  const scheduledAt=Date.now()+3*60_000;
  const sweep=await db.transaction(c=>runtime.runtimeSweep({payload:{now:scheduledAt}},c));
  assert.equal(sweep.scheduledAutopilotChecks,1);
  const checked=await queue.processOne(db,{'autopilot.evaluate':runtime.autopilotEvaluate},{owner:'return-rates-fixture',now:scheduledAt});
  assert.equal(checked.status,'COMPLETED',JSON.stringify(checked.lastError));
  assert.match((await notice()).happened,/^2 SKU or customer rates/);
  assert.equal(await notice('other-member'),undefined);
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    await refresh();
    const rows=(await review()).rows,high=rows.filter(row=>row.Finding==='High return rate');
    assert.deepEqual(high.map(row=>[row.Group,row.Unit,Number(row['Fulfilled units']),Number(row['Returned units']),
      Number(row['Returned %']),Number(row['Peer return %']),row['Physical returns']]),
    [['Customer','unit',8,4,50,5,2],['SKU','unit',8,4,50,5,2]]);
    assert.ok(high.every(row=>row['Received return references']=== [first.number,second.number].sort().join(', ')));
    const customer=(await review('Receiver')).rows;
    assert.deepEqual(customer.map(row=>[row.Unit,Number(row['Fulfilled units']),Number(row['Returned units'])]),
      [['unit',8,4],['kg',1.25,0.25]]);
    assert.equal(customer[0]['Peer return %'],'5.0','filtering preserves peer evidence');
    assert.equal(customer[1]['Peer return %'],null,'unlike stocking units cannot supply peer evidence');
    const lowRow=rows.find(row=>row.Name===comparisonCustomer.name);
    assert.equal(Number(lowRow['Returned %']),5);
    assert.notEqual(lowRow.Finding,'High return rate');
    assert.equal((await notice()).href,'/autopilot/reviews/customer-return-rates');
    assert.deepEqual(await countNotices(),{total:2,active:2});
  }
  assert.deepEqual(await businessRecords(),businessBefore,'reports and notices do not write business records or train rules');
  assert.match((await browser.get('/needs-you').expect(200)).text,/Review return rates/);
  const reviewPage=await browser.get('/autopilot/reviews/customer-return-rates').expect(200);
  assert.match(reviewPage.text,/Received return references/);
  assert.ok(reviewPage.text.includes(first.number)&&reviewPage.text.includes(second.number));

  await modes.save(db,ctx,116,{mode:'watch',revision:0});
  assert.equal(await notice(),undefined,'Watch hides the existing automatic notice immediately');
  await refresh();
  assert.deepEqual(await countNotices(),{total:2,active:0});
  assert.equal((await review()).rows.filter(row=>row.Finding==='High return rate').length,2,'manual review remains available');
  await modes.save(db,ctx,116,{mode:'routine',revision:1});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await refresh();
  assert.equal(await notice(),undefined);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  await db.query("UPDATE accounts SET created_at=(now()-interval '7 days')::text WHERE id=$1",[owner.accountId]);
  await refresh();
  assert.equal(await notice(),undefined,'the initial Watch period prevents automatic notices');
  await db.query("UPDATE accounts SET created_at=(now()-interval '21 days')::text WHERE id=$1",[owner.accountId]);

  const dateSales=months=>db.query(`UPDATE sales_orders SET order_date=(current_date-make_interval(months=>$3))::date::text
    WHERE workspace_id=$1 AND id=ANY($2::text[])`,[ctx.workspaceId,[firstOrder.salesOrderId,secondOrder.salesOrderId],months]);
  await dateSales(18);
  await subscribe('starter');
  assert.equal((await review()).rows.length,1);
  assert.doesNotMatch((await review()).rows[0].Suggestion,/4 of 8/);
  await subscribe('growth');
  await refresh();
  assert.ok(await notice(),'Growth includes the 18-month sales');
  await dateSales(30);
  await subscribe('pro');
  await refresh();
  assert.ok(await notice(),'Pro includes the 30-month sales');
  await subscribe('growth');
  assert.equal(await notice(),undefined,'downgrade hides the earlier unrestricted notice before a scan');
  await refresh();
  assert.deepEqual(await countNotices(),{total:2,active:0});
  assert.ok((await review()).rows.every(row=>row.Finding!=='High return rate'));
  await subscribe('enterprise');
  await refresh();
  assert.ok(await notice(),'Custom includes the 30-month sales');
});
