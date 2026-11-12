'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 9: Starter suggests. Growth drafts a move, a return or a discount for each
// dead or slow finding. Pro drafts until the owner approved one of a kind and
// saved a limit; Custom acts within limits without teaching. A discount is
// always a clearance plan whose prices a person approves.
test('slow stock findings become moves, supplier returns and clearance plans on each plan',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe,location,workflows}=f,ws=ctx.workspaceId;
  const catalog=require('../../src/domain/postgres-catalog-service'),receipt=require('../../src/accounting/postgres-stock-receipt');
  const prices=require('../../src/pricing/postgres-service'),steps=require('../../src/forecasting/agent-slow-stock-steps');
  const plans=require('../../src/pricing/agent-clearance-plans'),transfers=require('../../src/transfers/postgres-transfer-service');
  const queue=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();
  const reviews=require('../../src/autopilot/job-reviews'),modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
  const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
  await age('30 days');
  await subscribe('enterprise');
  const today=await require('../../src/lib/business-time').today(db,ws);
  const old=require('../../src/accounting/customer-money').addDays(today,-210)+'T12:00:00Z';
  // The books started before the stock was bought.
  await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ws,old.slice(0,10)]);
  const shop=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Shop',kind:'warehouse'});
  const item=async(code,trackingMode='quantity')=>{
    const sku=(await catalog.createItem(db,ctx,{name:'Slow '+code,baseCode:code,trackingMode,purchaseCost:'2'})).skuIds[0];
    await prices.setPrice(db,ctx,{skuId:sku,amountMinor:999,currency:'USD'});
    return sku;
  };
  const oldStock=(sku,quantity)=>receipt.receive(db,ctx,{skuId:sku,locationId:location.id,quantity,occurredAt:old,idempotencyKey:randomUUID()});
  const bought=async(sku,quantity,lotCode)=>{
    const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),
      lines:[{skuId:sku,quantityUnits:quantity,unitCost:2}]});
    await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
    await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),receivedAt:old,
      lines:[{lineId:po.lineIds[0],quantity,locationId:location.id,...(lotCode?{lotCode}:{})}]});
  };
  // The item sells at the shop: six recent units, sold in two orders.
  const sellsAtShop=async sku=>{
    await receipt.receive(db,ctx,{skuId:sku,locationId:shop.id,quantity:6,idempotencyKey:randomUUID()});
    for(let i=0;i<2;i++){
      const order=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'SHIP',fulfillmentLocationId:shop.id,
        idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:3,unitPriceMinor:999}]});
      await workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});
      await workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:shop.id,quantity:3}]});
    }
  };
  const M=await item('SLOW-M');await oldStock(M,10);await sellsAtShop(M);
  const R=await item('SLOW-R');await bought(R,4);
  const L=await item('SLOW-L','lot');await bought(L,3,'LOT-1');
  const R2=await item('SLOW-R2');await bought(R2,2);
  const M2=await item('SLOW-M2');await oldStock(M2,8);await sellsAtShop(M2);
  const D=await item('SLOW-D');await oldStock(D,5);

  const sweep=()=>steps.run({workspaceId:ws,payload:{}},db);
  const open=async sku=>Object.fromEntries((await db.query(`SELECT kind,status,quantity::text,reason,would_apply,fingerprint,id,automatic
    FROM stockchief_runtime.agent_slow_stock_steps WHERE workspace_id=$1 AND sku_id=$2 AND status IN ('DRAFT','HELD')`,[ws,sku])).rows.map(r=>[r.kind,r]));
  const latest=async(sku,kind)=>(await db.query(`SELECT * FROM stockchief_runtime.agent_slow_stock_steps WHERE workspace_id=$1 AND sku_id=$2 AND kind=$3
    ORDER BY created_at DESC,id DESC LIMIT 1`,[ws,sku,kind])).rows[0];
  const approve=async(sku,kind,extra={})=>{const s=(await open(sku))[kind];return steps.approve(db,ctx,s.id,{confirmed:'yes',fingerprint:s.fingerprint,...extra});};
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].count);
  const returnsFor=sku=>count(`SELECT count(*) FROM supplier_return_lines l JOIN supplier_returns r ON r.id=l.supplier_return_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND r.status='REQUESTED'`,[sku]);
  const transfersFor=sku=>count(`SELECT count(*) FROM inventory_transfer_lines l JOIN inventory_transfers t ON t.id=l.transfer_id
    WHERE l.workspace_id=$1 AND l.sku_id=$2 AND t.status='REQUESTED'`,[sku]);
  const plansFor=sku=>count(`SELECT count(*) FROM stockchief_runtime.agent_clearance_plans WHERE workspace_id=$1 AND sku_id=$2 AND status='DRAFT'`,[sku]);
  const audits=action=>count('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);

  // Starter: one suggestion with a concrete step; the page and drafting are locked.
  await subscribe('starter');
  const [suggestion]=(await reviews.run(db,ctx,'slow-stock',{filter:'SLOW-M'})).rows;
  assert.deepEqual(Object.keys(suggestion),['Suggestion']);
  assert.match(suggestion.Suggestion,/Move 3 to Shop, where it sells\./);
  assert.match((await browser.get(steps.path).expect(200)).text,/data-agent-plan-locked/);
  await assert.rejects(steps.check(db,ctx),e=>e.code==='entitlement_required');
  assert.equal((await sweep()).skipped,true);
  assert.deepEqual(await steps.inbox(db,ws),[]);

  // Growth: every step is a draft. Nothing is requested, sent or priced.
  await subscribe('growth');
  const review=(await reviews.run(db,ctx,'slow-stock',{filter:'SLOW-R'})).rows[0];
  assert.match(review['Suggested next step'],/^Send 4 back to Fixture parts \(bought on [^)]+\), or Discount 4 with a clearance plan\.$/);
  await steps.check(db,ctx);
  const processed=await queue.processOne(db,handlers,{owner:'slow-stock-worker',kinds:[steps.kind]});
  assert.equal(processed.status,'COMPLETED',JSON.stringify(processed.lastError));
  let m=await open(M),r=await open(R),l=await open(L);
  assert.deepEqual([m.MOVE.status,m.MOVE.quantity,m.DISCOUNT.quantity,m.RETURN],['DRAFT','3.000000','7.000000',undefined]);
  assert.deepEqual([r.RETURN.status,r.RETURN.quantity,r.DISCOUNT.status],['DRAFT','4.000000','DRAFT']);
  assert.equal(r.RETURN.reason,'A person approves each step on this plan.');
  assert.deepEqual([l.RETURN.status,l.DISCOUNT.status],['HELD','DRAFT']);
  assert.match(l.RETURN.reason,/Choose the exact batches/);
  assert.equal(Object.keys(await open(D)).join(),'DISCOUNT');
  assert.equal(await count("SELECT count(*) FROM inventory_transfers WHERE workspace_id=$1"),0);
  assert.equal(await count("SELECT count(*) FROM supplier_returns WHERE workspace_id=$1"),0);
  assert.equal(await count("SELECT count(*) FROM stockchief_runtime.agent_clearance_plans WHERE workspace_id=$1"),0);
  const [notice]=await steps.inbox(db,ws);
  assert.match(notice.happened,/steps wait for your approval\. 1 step needs you to pick exact units\./);
  assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===9).allowed,['inherit','watch','ask']);
  await assert.rejects(steps.configure(db,ctx,'MOVE',{revision:0,confirmed:'yes',minimumDays:'90',maximumQuantity:'5'}),e=>e.code==='entitlement_required');

  // Approving through the page requests the transfer, which holds the stock.
  const page=await browser.get(steps.path).expect(200);
  assert.match(page.text,new RegExp('data-slow-step="'+m.MOVE.id+'"'));
  await browser.post(steps.path+'/steps/'+m.MOVE.id+'/approve').type('form')
    .send({_csrf:f.csrf(page.text),fingerprint:m.MOVE.fingerprint,confirmed:'yes'}).expect(303);
  const moved=await latest(M,'MOVE');
  const transfer=await transfers.get(db,ws,moved.transfer_id);
  assert.deepEqual([moved.status,moved.automatic,transfer.status,transfer.source_location_id,transfer.destination_location_id,Number(transfer.lines[0].requested_quantity)],
    ['DONE',false,'REQUESTED',location.id,shop.id,3]);
  assert.deepEqual(await steps.approve(db,ctx,moved.id,{confirmed:'yes',fingerprint:moved.fingerprint}),{replayed:true});
  // A held step and a stale confirmation stop.
  await assert.rejects(approve(L,'RETURN'),/no longer waiting|Choose the exact batches/);
  await assert.rejects(steps.approve(db,ctx,r.RETURN.id,{confirmed:'yes',fingerprint:'old'}),/Review the current step/);
  // The supplier return is requested only; nothing leaves and no credit is assumed.
  const returned=await approve(R,'RETURN');
  const rtv=(await db.query('SELECT status,expected_credit_minor,reason FROM supplier_returns WHERE id=$1',[returned.supplier_return_id])).rows[0];
  assert.deepEqual([rtv.status,rtv.expected_credit_minor],['REQUESTED',null]);assert.match(rtv.reason,/Confirm the supplier takes it back/);
  assert.equal((await latest(R,'DISCOUNT')).status,'DISMISSED');
  // A discount becomes a clearance plan; the price waits for a person.
  await assert.rejects(approve(L,'DISCOUNT',{markdown:'',stepDays:''}),/Enter how many days/);
  const discounted=await approve(L,'DISCOUNT',{markdown:'20',stepDays:'30'});
  assert.equal((await plans.load(db,ctx,discounted.clearance_plan_id)).status,'DRAFT');
  assert.equal((await prices.currentPrice(db,ws,L)).amount_minor,999);
  assert.equal((await latest(L,'RETURN')).status,'DISMISSED');
  // Changed stock invalidates a prepared step.
  await receipt.receive(db,ctx,{skuId:D,locationId:location.id,quantity:1,idempotencyKey:randomUUID()});
  await assert.rejects(approve(D,'DISCOUNT',{markdown:'20',stepDays:'30'}),/stock changed since this step was prepared/);
  // Undo while the return is untouched.
  assert.deepEqual(await steps.undo(db,ctx,(await latest(R,'RETURN')).id,{confirmed:'yes'}),{undone:true});
  assert.equal((await db.query('SELECT status FROM supplier_returns WHERE id=$1',[returned.supplier_return_id])).rows[0].status,'CANCELLED');
  await sweep();
  m=await open(M);r=await open(R);
  assert.equal(m.MOVE,undefined,'the requested transfer covers the shop');assert.equal(await transfersFor(M),1);
  assert.equal(r.RETURN.quantity,'4.000000');assert.equal((await open(D)).DISCOUNT.quantity,'6.000000');

  // Pro: drafts until the owner approves one of a kind and saves a limit.
  await subscribe('pro');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  assert.ok((await modes.page(db,ctx)).find(x=>x.id===9).allowed.includes('routine'));
  await assert.rejects(steps.configure(db,ctx,'RETURN',{revision:0,confirmed:'yes',minimumDays:'90',maximum:'3.00'}),/Approve one step of this kind yourself first/);
  await sweep();
  assert.match((await open(R2)).RETURN.reason,/Save a limit/);
  await approve(R,'RETURN');
  await steps.configure(db,ctx,'RETURN',{revision:0,confirmed:'yes',minimumDays:'90',maximum:'3.00'});
  await sweep();
  assert.match((await open(R2)).RETURN.reason,/over your limit of \$3\.00 recorded cost per return/);
  await steps.configure(db,ctx,'RETURN',{revision:1,confirmed:'yes',minimumDays:'90',maximum:'5.00'});
  // Pause, shadow and Ask me first keep it a draft and say it would act.
  await autopilot.pause(db,ctx,{role:'owner'},'checking');
  await sweep();
  assert.deepEqual([(await open(R2)).RETURN.would_apply,/paused/.test((await open(R2)).RETURN.reason)],[true,true]);
  await autopilot.resume(db,ctx,{role:'owner'});
  await age('1 day');
  await sweep();
  assert.match((await open(R2)).RETURN.reason,/watching during the first 14 days/);
  await age('30 days');
  await modes.save(db,ctx,9,{mode:'ask',revision:0});
  await sweep();
  assert.match((await open(R2)).RETURN.reason,/Ask me first/);
  await modes.save(db,ctx,9,{mode:'inherit',revision:1});
  assert.equal(await returnsFor(R2),0);
  await sweep();
  const auto=await latest(R2,'RETURN');
  assert.deepEqual([auto.status,auto.automatic],['DONE',true]);
  assert.equal(await returnsFor(R2),1);assert.equal(await audits('Slow stock step taken on its own'),1);
  assert.equal((await latest(R2,'DISCOUNT')).status,'DISMISSED');
  await sweep();
  assert.equal(await returnsFor(R2),1,'a replay sends no second return');
  await steps.undo(db,ctx,auto.id,{confirmed:'yes'});
  await sweep();
  assert.match((await open(R2)).RETURN.reason,/You undid this step/);

  // Custom: no teaching. A discount on its own is a clearance plan for a person.
  await subscribe('enterprise');
  await steps.configure(db,ctx,'DISCOUNT',{revision:0,confirmed:'yes',minimumDays:'90',markdown:'20',stepDays:'30'});
  await steps.configure(db,ctx,'MOVE',{revision:0,confirmed:'yes',minimumDays:'90',maximumQuantity:'2'});
  await sweep();
  assert.match((await open(M2)).MOVE.reason,/over your limit of 2 units per move/);
  for(const sku of [D,M,M2,R2])assert.equal(await plansFor(sku),1,'a clearance plan waits for its price');
  for(const sku of [D,M,M2,R2])assert.equal((await prices.currentPrice(db,ws,sku)).amount_minor,999);
  assert.equal((await latest(R2,'RETURN')).status,'DISMISSED','the discount was chosen instead');
  assert.equal((await latest(D,'DISCOUNT')).automatic,true);
  assert.match((await plans.inbox(db,ws))[0].title,/clearance prices wait for you/);
  await steps.configure(db,ctx,'MOVE',{revision:1,confirmed:'yes',minimumDays:'90',maximumQuantity:'5'});
  await sweep();
  const autoMove=await latest(M2,'MOVE');
  assert.deepEqual([autoMove.status,autoMove.automatic,(await transfers.get(db,ws,autoMove.transfer_id)).decision_detail.automatic],['DONE',true,true]);
  // Undo while untouched; an approved transfer stays.
  await steps.undo(db,ctx,autoMove.id,{confirmed:'yes'});
  assert.equal((await transfers.get(db,ws,autoMove.transfer_id)).status,'CANCELLED');
  const autoPlan=await latest(D,'DISCOUNT');
  await steps.undo(db,ctx,autoPlan.id,{confirmed:'yes'});
  assert.equal((await plans.load(db,ctx,autoPlan.clearance_plan_id)).status,'CANCELLED');
  await transfers.approve(db,ctx,moved.transfer_id,{idempotencyKey:randomUUID()});
  await assert.rejects(steps.undo(db,ctx,moved.id,{confirmed:'yes'}),/already approved or moved/);
  // Watch mode stops a person's approval too.
  await sweep();
  assert.match((await open(M2)).MOVE.reason,/You undid this step/);
  await autopilot.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(approve(M2,'MOVE'),/watch-only mode/);
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // The routine is queued once per cycle, and the pages render.
  assert.equal((await steps.schedule(db,ws,'cycle-1')).queued,true);
  assert.equal((await steps.schedule(db,ws,'cycle-1')).queued,false);
  const custom=await browser.get(steps.path).expect(200);
  for(const marker of ['data-slow-waiting','data-slow-done','data-slow-limit="MOVE"','data-slow-limit="RETURN"','data-slow-limit="DISCOUNT"'])assert.ok(custom.text.includes(marker),marker);
  assert.match((await browser.get('/autopilot/reviews/slow-stock').expect(200)).text,/Review next steps for slow stock/);
});
