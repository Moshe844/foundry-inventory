'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 211 is excluded on Starter and alone on Growth, Pro and Custom. It
// learns each customer's ordering habit (how often, which weekday, how much,
// and whether they are due) and each supplier's delivery habit (usual lead
// time and its spread, how often on time, short or over) from recorded
// confirmed orders and completed receipts. A product with no deliveries of its
// own and no lead time from the owner then plans with its supplier's usual
// lead time: reorder timing and the expected date of a new purchase order.
// Nothing else changes, and the feed stops in shadow, Watch only and pause.
test('customer and supplier habits are learned from records, shown on their pages and used for reorder timing on Growth and up',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:60}),{db,ctx,browser,subscribe,workflows}=f,ws=ctx.workspaceId;
  const commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service');
  const habits=require('../../src/autopilot/partner-habits'),reviews=require('../../src/autopilot/job-reviews'),autonomy=require('../../src/autopilot/postgres-service');
  const state=require('../../src/purchasing/postgres-replenishment-state');
  const today=await require('../../src/lib/business-time').today(db,ws),day=n=>require('../../src/accounting/customer-money').addDays(today,n);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);

  // A supplier with three completed deliveries of one product: 12, 6 and 7
  // days, the last one short at first (6 of 10, then 4 more).
  const vendor=await commerce.createSupplier(db,ctx,{name:'Habit supplier',currency:'USD'});
  const old=(await catalog.createItem(db,ctx,{name:'Habit old',baseCode:'HABIT-OLD',trackingMode:'quantity'})).skuIds[0];
  const fresh=(await catalog.createItem(db,ctx,{name:'Habit new',baseCode:'A-HABIT-NEW',trackingMode:'quantity'})).skuIds[0];
  await commerce.linkSupplierItem(db,ctx,{supplierId:vendor.id,skuId:old,lastUnitCost:2,isPreferred:true,leadTimeDays:20});
  await commerce.linkSupplierItem(db,ctx,{supplierId:vendor.id,skuId:fresh,lastUnitCost:2,isPreferred:true,leadTimeDays:20});
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
    VALUES($1,$2,$3,$4,2,10,'manual',now()::text,now()::text)`,[randomUUID(),ws,fresh,f.location.id]);
  async function delivery(placed,expected,ordered,receipts){
    const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:vendor.id,destinationLocationId:f.location.id,expectedDate:day(expected),
      idempotencyKey:randomUUID(),lines:[{skuId:old,quantityUnits:ordered,unitCost:2}]});
    await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
    for(const [,quantity] of receipts)await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity,locationId:f.location.id}]});
    await db.query('UPDATE purchase_orders SET ordered_at=$2,expected_date=$3 WHERE id=$1',[order.purchaseOrderId,day(placed)+'T12:00:00Z',day(expected)]);
    const ids=(await db.query('SELECT id FROM purchase_order_receipts WHERE purchase_order_id=$1 ORDER BY created_at,id',[order.purchaseOrderId])).rows.map(r=>r.id);
    for(const [index,[ago]] of receipts.entries())await db.query('UPDATE purchase_order_receipts SET received_at=$2 WHERE id=$1',[ids[index],day(ago)+'T12:00:00Z']);
    return order;
  }
  await delivery(-40,-33,5,[[-28,5]]);await delivery(-30,-24,5,[[-24,5]]);await delivery(-20,-12,10,[[-15,6],[-13,4]]);
  // An open order placed 3 days ago that the supplier promised for tomorrow.
  const open=await workflows.createPurchaseOrder(db,ctx,{supplierId:vendor.id,destinationLocationId:f.location.id,expectedDate:day(1),idempotencyKey:randomUUID(),lines:[{skuId:old,quantityUnits:1,unitCost:2}]});
  await workflows.approvePurchaseOrder(db,ctx,open.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.placePurchaseOrder(db,ctx,open.purchaseOrderId,{idempotencyKey:randomUUID()});
  await db.query('UPDATE purchase_orders SET ordered_at=$2 WHERE id=$1',[open.purchaseOrderId,day(-3)+'T12:00:00Z']);

  // A customer who orders every week, and one with too few orders to learn.
  const sale=async(customerId,ago,quantity)=>{const x=await workflows.createSalesOrder(db,ctx,{customerId,orderDate:day(ago),deliveryMethod:'PICKUP',
    fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity,unitPriceMinor:700}]});
    await workflows.confirmSalesOrder(db,ctx,x.salesOrderId,{idempotencyKey:randomUUID()});};
  for(const [ago,quantity] of [[-28,3],[-21,4],[-14,3],[-7,2],[-7,1]])await sale('fixture-customer',ago,quantity);
  const newcomer=(await db.query(`INSERT INTO customers(id,workspace_id,name,record_state,created_by_user_id,created_at,updated_at)
    VALUES('habit-newcomer',$1,'Newcomer','ACTIVE',$2,now()::text,now()::text) RETURNING id`,[ws,ctx.actorId])).rows[0];
  await sale(newcomer.id,-5,1);await sale(newcomer.id,-2,1);
  const weekday=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date(today+'T12:00:00Z').getUTCDay()];

  const lead=async sku=>(await state.rows(db,ws,{onlySkuIds:[sku]})).find(r=>r.location_id===f.location.id);
  const draftDate=async()=>(await autonomy.lowestStockDraft(db,ws)).expectedDate;
  const customerPage=()=>browser.get('/sales/customers/fixture-customer').expect(200);
  const supplierPage=()=>browser.get('/suppliers/'+vendor.id).expect(200);

  // The supplier's own product keeps its own measured lead time (first
  // arrivals 12, 6 and 5 days, so 8) on every plan.
  for(const tier of ['starter','growth'])
  {await subscribe(tier);assert.equal(Number((await lead(old)).lead_time_days),8,tier);}

  // Starter: excluded. The habit is neither shown nor used.
  await subscribe('starter');
  await assert.rejects(reviews.run(db,ctx,'partner-habits'),/Growth/);
  assert.match((await customerPage()).text,/Learning each customer’s habits comes with Growth/);
  assert.match((await supplierPage()).text,/Learning each supplier’s habits comes with Growth/);
  assert.equal(Number((await lead(fresh)).lead_time_days),20,'Starter plans with the promised lead time.');
  assert.equal(await draftDate(),day(20));

  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    const rows=(await reviews.run(db,ctx,'partner-habits')).rows;
    const customer=rows.find(r=>r.Type==='Customer'&&r.Partner==='Receiver'),supplier=rows.find(r=>r.Partner==='Habit supplier');
    assert.equal(customer.Pattern,'Orders about every 7 days',tier);
    assert.equal(customer['Usual day'],'Usually on '+weekday);
    assert.equal(customer['Usual size'],'About 3 units ($21.00)','Two orders on one day are one ordering day of 3 units.');
    assert.equal(customer['Estimated next order'],today);
    assert.equal(customer['Next step'],'Due to order now (expected '+today+')');
    assert.equal(rows.some(r=>r.Partner==='Newcomer'),false,'Two ordering days are not a habit yet.');
    assert.equal(supplier.Pattern,'Delivers in about 7 days');
    assert.equal(supplier.Spread,'6 to 12 days');
    assert.equal(supplier['On time'],'2 of 3 on time (67%)');
    assert.equal(supplier['Short or over'],'First delivery short on 1 of 3 (usually 40% short). Never more than ordered.');
    // The pages show the same habits.
    const cp=(await customerPage()).text;
    assert.match(cp,/data-customer-habits/);assert.match(cp,/Orders about every 7 days/);assert.match(cp,/Due now/);assert.match(cp,new RegExp('Usually on '+weekday));
    assert.match((await browser.get('/sales/customers/'+newcomer.id).expect(200)).text,/learns this customer’s habits after three ordering days/);
    const sp=(await supplierPage()).text;
    assert.match(sp,/About 7 days \(usually 6 to 12\)/);assert.match(sp,/2 of 3 on time/);assert.match(sp,/First delivery short on 1 of 3/);
    assert.match(sp,/usually arrives about [\d-]+ <span class="ox-badge ox-badge--amber">Later than /,'An open order promised sooner than the habit is flagged.');
    assert.match(sp,/Reorders use 7 days for products with no deliveries of their own/);
    // Put to work: the new product plans and dates its order with 7 days, not
    // the promised 20; the product with its own history keeps 8.
    const planned=await lead(fresh);
    assert.equal(Number(planned.lead_time_days),7,tier);assert.equal(planned.lead_time_assumed,false);
    assert.equal(Number((await lead(old)).lead_time_days),8);
    assert.equal(await draftDate(),day(7));
  }
  // No limit or setting changed on its own.
  const saved=(await db.query('SELECT reorder_point::int,target_stock::int,lead_time_days FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2',[ws,fresh])).rows[0];
  assert.deepEqual({...saved},{reorder_point:2,target_stock:10,lead_time_days:null});
  assert.equal(Number((await db.query('SELECT lead_time_days FROM supplier_items WHERE workspace_id=$1 AND sku_id=$2',[ws,fresh])).rows[0].lead_time_days),20);

  // An owner's own lead time on the product wins over the habit.
  await db.query('UPDATE reorder_policies SET lead_time_days=15 WHERE workspace_id=$1 AND sku_id=$2',[ws,fresh]);
  assert.equal(Number((await lead(fresh)).lead_time_days),15);
  await db.query('UPDATE reorder_policies SET lead_time_days=NULL WHERE workspace_id=$1 AND sku_id=$2',[ws,fresh]);

  // Pause, Watch only and the first 14 days: shown, not used.
  await autonomy.pause(db,ctx,{role:'owner'},'Owner paused work');
  assert.equal(Number((await lead(fresh)).lead_time_days),20);assert.equal(await draftDate(),day(20));
  assert.match((await supplierPage()).text,/Automatic work is paused, so reorders still use the promised lead time/);
  await autonomy.resume(db,ctx,{role:'owner'});
  await autonomy.setMode(db,ctx,{role:'owner'},'OBSERVE');
  assert.equal(Number((await lead(fresh)).lead_time_days),20);
  assert.match((await reviews.run(db,ctx,'partner-habits')).summary,/Watch only/);
  await autonomy.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  assert.equal(Number((await lead(fresh)).lead_time_days),20);
  assert.match((await supplierPage()).text,/first 14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal(Number((await lead(fresh)).lead_time_days),7,'The feed resumes with automatic work.');

  // A supplier with only two deliveries has no habit yet; nothing is guessed.
  const twice=await commerce.createSupplier(db,ctx,{name:'Twice supplier',currency:'USD'});
  assert.equal((await habits.suppliers(db,ws,[twice.id])).size,0);
  assert.match((await browser.get('/suppliers/'+twice.id).expect(200)).text,/learns this supplier’s habits after three completed deliveries/);

  // An account on its older terms sees neither panel.
  await db.query(`UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions
    WHERE plan_id='growth' AND (configuration->>'offerId') IS DISTINCT FROM 'agent-v3' ORDER BY version_number LIMIT 1),plan_id='growth' WHERE account_id=$1`,[f.owner.accountId]);
  assert.doesNotMatch((await customerPage()).text,/data-customer-habits/);
  assert.doesNotMatch((await supplierPage()).text,/data-supplier-habits/);
  assert.equal(Number((await lead(fresh)).lead_time_days),20);

  // The pages read well on a desktop and on a 390 px phone.
  await subscribe('pro');
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1600,height:1000},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    for(const [page,heading] of [['/sales/customers/fixture-customer','customer'],['/suppliers/'+vendor.id,'supplier']]){
      await tab.goto(base+page);
      assert(await tab.getByRole('heading',{name:'Habits',exact:true}).isVisible(),name+' '+heading);
      assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+heading+' must not scroll sideways');
      await tab.screenshot({path:require('node:path').join(folder,'partner-habits-'+heading+'-'+name+'.png'),fullPage:true});
    }
    await tab.close();
  }
});
