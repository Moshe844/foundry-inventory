'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-workflow-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const reviews=require('../../src/autopilot/job-reviews');
const notices=require('../../src/autopilot/operational-notices');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const runtime=require('../../src/operations/postgres-runtime-handlers');
const queue=require('../../src/operations/postgres-job-queue');

test('all plans receive read-only pricing notices with approved discounts, measured costs and exact revisions',{timeout:240000},async t=>{
  const f=await fixture(t,{units:12});
  const {db,ctx,subscribe,browser,workflows}=f;
  const sku=f.item.skuIds[0],locationId=f.location.id;
  const review=(filter='')=>reviews.run(db,ctx,'order-price-exceptions',{filter});
  const refresh=()=>db.transaction(c=>notices.refresh(c,ctx.workspaceId));
  const notice=async(actor=ctx.actorId)=>(await notices.inbox(db,ctx.workspaceId,actor)).find(n=>n.sourceId==='agent-notice-82');
  const orderInfo=async id=>(await db.query('SELECT id,pricing_quote_id,version FROM sales_orders WHERE id=$1',[id])).rows[0];
  const quote=async id=>(await db.query('SELECT quote FROM stockchief_runtime.pricing_order_snapshots WHERE id=$1',[id])).rows[0].quote;
  const order=(line,fields={})=>workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',
    fulfillmentLocationId:locationId,idempotencyKey:randomUUID(),lines:[line],...fields});
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);

  const good=await order({skuId:sku,quantity:3,unitPriceMinor:200},{discountMinor:100,taxMinor:60});
  const original=await orderInfo(good.salesOrderId);
  const originalQuote=await quote(original.pricing_quote_id);
  assert.deepEqual(originalQuote.lineIds,good.lineIds);
  assert.equal(originalQuote.discountMinor,100);
  assert.deepEqual((await review(good.orderNumber)).rows,[],'the owner-approved discount and tax are valid');
  await workflows.reviseDraftSalesOrderLine(db,ctx,good.salesOrderId,{skuId:sku,expectedVersion:original.version,
    expectedQuantity:3,expectedUnitPriceMinor:200,quantity:3,unitPriceMinor:240,idempotencyKey:randomUUID()});
  const revised=await orderInfo(good.salesOrderId);
  assert.notEqual(revised.pricing_quote_id,original.pricing_quote_id);
  assert.deepEqual((await review(good.orderNumber)).rows,[]);
  assert.deepEqual(await quote(original.pricing_quote_id),originalQuote,'revision preserved the historical source price');

  const measured=await catalog.createItem(db,ctx,{name:'Measured cuts',baseCode:'ORDER-CUTS-KG',trackingMode:'quantity',
    unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3});
  const measuredSku=measured.skuIds[0];
  for(const unitCost of [1,1.01]){
    const purchase=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:locationId,
      idempotencyKey:randomUUID(),lines:[{skuId:measuredSku,quantityUnits:1,secondaryQuantity:1,unitCost}]});
    await workflows.approvePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.receivePurchaseOrder(db,ctx,purchase.purchaseOrderId,{idempotencyKey:randomUUID(),
      lines:[{lineId:purchase.lineIds[0],locationId,quantity:1,secondaryQuantity:1}]});
  }
  const weighedLine={skuId:measuredSku,quantity:2,secondaryQuantity:2,unitPriceMinor:101};
  const breakEven=await order(weighedLine,{discountMinor:1,taxMinor:31});
  const weightQuote=await quote((await orderInfo(breakEven.salesOrderId)).pricing_quote_id);
  assert.deepEqual(weightQuote.lines[0].costEvidence,{basis:'inventory',currency:'USD',unit:'kg',amountMinor:'201',quantity:'2'});
  assert.equal(weightQuote.lines[0].costUnitMinor,101,'the former rounded unit cost would have produced a false exception');
  assert.deepEqual((await review(breakEven.orderNumber)).rows,[]);
  await workflows.reviseDraftSalesOrderLine(db,ctx,breakEven.salesOrderId,{skuId:measuredSku,
    expectedVersion:(await orderInfo(breakEven.salesOrderId)).version,expectedQuantity:2,expectedUnitPriceMinor:101,
    quantity:2,unitPriceMinor:102,idempotencyKey:randomUUID()});
  assert.equal((await quote((await orderInfo(breakEven.salesOrderId)).pricing_quote_id)).lines[0].pricingQuantity,2);
  assert.deepEqual((await review(breakEven.orderNumber)).rows,[]);

  const legacy=await order(weighedLine,{discountMinor:1,taxMinor:31});
  const legacyQuote=await quote((await orderInfo(legacy.salesOrderId)).pricing_quote_id);
  delete legacyQuote.lineIds;
  delete legacyQuote.lines[0].costEvidence;
  const legacyId=randomUUID();
  await db.query(`INSERT INTO stockchief_runtime.pricing_order_snapshots(id,workspace_id,sales_order_id,quote,integrity_hash)
    VALUES($1,$2,$3,$4::jsonb,$5)`,[legacyId,ctx.workspaceId,legacy.salesOrderId,JSON.stringify(legacyQuote),
    require('../../src/pricing/postgres-promotions').hash(legacyQuote)]);
  await db.query('UPDATE sales_orders SET pricing_quote_id=$2 WHERE id=$1',[legacy.salesOrderId,legacyId]);
  await db.query('UPDATE sales_order_lines SET pricing_snapshot=$2::jsonb WHERE id=$1',[legacy.lineIds[0],JSON.stringify(legacyQuote.lines[0])]);
  assert.deepEqual((await review(legacy.orderNumber)).rows.map(r=>r.Problem),['Cost precision needs review']);

  const below=await order(weighedLine,{discountMinor:3,taxMinor:31});
  const [measuredIssue]=(await review(below.orderNumber)).rows;
  assert.equal(measuredIssue.Problem,'Selling below recorded cost');
  assert.equal(measuredIssue['Recorded amount'],'$1.99','tax does not conceal below-cost goods');
  assert.equal(measuredIssue['Compared amount'],'$2.01 per 2 kg');
  const posted=await order({skuId:sku,quantity:1,unitPriceMinor:80});
  await workflows.confirmSalesOrder(db,ctx,posted.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,posted.salesOrderId,{idempotencyKey:randomUUID(),
    lines:[{lineId:posted.lineIds[0],locationId,quantity:1}]});
  const [actual]=(await review(posted.orderNumber)).rows;
  assert.equal(actual.Evidence,'Posted goods revenue and cost');
  assert.equal(actual['Compared amount'],'$1.00');

  await db.query('UPDATE sales_orders SET pricing_quote_id=$2,discount_minor=25 WHERE id=$1',[good.salesOrderId,original.pricing_quote_id]);
  await db.query(`UPDATE sales_order_lines SET pricing_snapshot=jsonb_set(jsonb_set(pricing_snapshot,'{discountMinor}','25'),
    '{netMinor}',to_jsonb((pricing_snapshot->>'grossMinor')::int-25)) WHERE id=$1`,[good.lineIds[0]]);
  assert.deepEqual((await review(good.orderNumber)).rows.map(r=>r.Problem).sort(),[
    'Line discount differs from reviewed amounts','Order discount differs from approved quote','Order uses an older pricing revision'
  ]);

  const records=async()=>(await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.id) FROM sales_orders o WHERE o.workspace_id=$1) AS orders,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM sales_order_lines l WHERE l.workspace_id=$1) AS lines,
    (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM stockchief_runtime.pricing_order_snapshots q WHERE q.workspace_id=$1) AS quotes,
    (SELECT count(*) FROM sku_prices WHERE workspace_id=$1) AS catalogue,
    (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,
    (SELECT count(*) FROM accounting_journal_entries WHERE workspace_id=$1) AS journals`,[ctx.workspaceId])).rows[0];
  const before=await records();
  await subscribe('starter');
  const scheduledAt=Date.now()+3*60_000;
  const sweep=await db.transaction(c=>runtime.runtimeSweep({payload:{now:scheduledAt}},c));
  assert.equal(sweep.scheduledAutopilotChecks,1);
  const checked=await queue.processOne(db,{'autopilot.evaluate':runtime.autopilotEvaluate},{owner:'order-price-fixture',now:scheduledAt});
  assert.equal(checked.status,'COMPLETED',JSON.stringify(checked.lastError));
  for(const plan of ['starter','growth','pro','enterprise']){
    await subscribe(plan);
    await refresh();
    assert.equal((await review()).mode,'alone');
    assert.match((await notice()).happened,/^3 orders/);
    assert.equal(await notice('another-member'),undefined);
  }
  assert.deepEqual(await records(),before,'all alerts and reviews leave price, discount, stock and accounting evidence intact');
  assert.match((await browser.get('/needs-you').expect(200)).text,/Review order prices and discounts/);
  const page=await browser.get('/autopilot/reviews/order-price-exceptions?filter='+encodeURIComponent(good.orderNumber)).expect(200);
  assert.match(page.text,/Order uses an older pricing revision/);

  await modes.save(db,ctx,82,{mode:'watch',revision:0});
  assert.equal(await notice(),undefined);
  await refresh();
  assert.equal(await notice(),undefined);
  assert.equal((await review(good.orderNumber)).rows.length,3);
  await modes.save(db,ctx,82,{mode:'inherit',revision:1});
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await refresh();
  assert.equal(await notice(),undefined);
  await autopilot.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  await db.query("UPDATE accounts SET created_at=(now()-interval '7 days')::text WHERE id=$1",[f.owner.accountId]);
  await refresh();
  assert.equal(await notice(),undefined,'the first 14 days suppress scheduled notifications');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`UPDATE sales_orders SET order_date=(current_date-interval '30 months')::date::text
    WHERE id=ANY($1::text[])`,[[good.salesOrderId,below.salesOrderId,posted.salesOrderId]]);
  await refresh();
  assert.ok(await notice());
  await subscribe('growth');
  assert.equal(await notice(),undefined,'a wider-history notice is immediately held on downgrade');
  await refresh();
  assert.deepEqual((await review(good.orderNumber)).rows,[]);
  assert.equal(await notice(),undefined);
});
