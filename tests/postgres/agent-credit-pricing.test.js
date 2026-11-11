'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews'),assistant=require('../../src/assistant/postgres-service');
const pricing=require('../../src/pricing/postgres-service');

test('scheduled cost and adjustment watches honor current tier, local night hours and owner thresholds',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe}=f;
  const watches=require('../../src/autopilot/activity-watches'),notices=require('../../src/autopilot/operational-notices');
  const inventory=require('../../src/domain/postgres-inventory-engine'),time=require('../../src/lib/business-time');
  const sku=f.item.skuIds[0],root='/autopilot/reviews/';
  await subscribe('pro');
  await db.query("UPDATE workspaces SET time_zone='America/New_York' WHERE id=$1",[ctx.workspaceId]);
  const {calendarDate,timeZone}=await time.forWorkspace(db,ctx.workspaceId),date=require('../../src/accounting/customer-money').addDays(calendarDate,-1);
  const stamp=h=>time.wall(date,h,30,timeZone).toISOString();
  await pricing.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor:1000});
  for(const amountMinor of [400,600])await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  await inventory.adjust(db,ctx,{skuId:sku,locationId:f.location.id,countedQuantity:15,reasonCode:'cycle_count',occurredAt:stamp(12),idempotencyKey:randomUUID()});
  await inventory.receive(db,ctx,{skuId:sku,locationId:f.location.id,quantity:1,occurredAt:stamp(23),idempotencyKey:randomUUID()});
  const channel=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,config,provides,setup_status,authorized_by_user_id,
    provider_account_id,last_synced_at,created_at,updated_at,expected_interval_minutes) VALUES($1,$2,$1,'Test shop','shopify','connected','[]','{}','[]','CONNECTED',$3,
    'example-shop',(now()-interval '30 days')::text,(now()-interval '31 days')::text,now(),60)`,[channel,ctx.workspaceId,ctx.actorId]);
  await db.query(`INSERT INTO connection_commerce_positions(id,workspace_id,connector_id,sku_id,location_id,external_id,external_location_id,field,mode,
    baseline_provider,last_verified_at,authorized_by_user_id) VALUES($1,$2,$3,$4,$5,'sample-item','test-room','quantity','outbound','40',now(),$6)`,
    [randomUUID(),ctx.workspaceId,channel,sku,f.location.id,ctx.actorId]);
  const set=async(job,key,body)=>{const page=await browser.get(root+key).expect(200);await browser.post('/autopilot/alert-settings/'+job).type('form').send({_csrf:f.csrf(page.text),revision:0,...body}).expect(303);};
  await set(170,'cost-alerts',{marginPct:45});await set(171,'unusual-stock-activity',{adjustmentUnits:5,nightFrom:22,nightUntil:6});
  await assert.rejects(watches.save(db,ctx,170,{marginPct:0,revision:0}),/changed/);
  const handler=require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate;
  await db.transaction(c=>handler({id:randomUUID(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  await db.transaction(c=>handler({id:randomUUID(),workspaceId:ctx.workspaceId,payload:{actorId:ctx.actorId,requestedByUser:true}},c));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM workspace_daily_digests WHERE workspace_id=$1 AND report_date=$2',[ctx.workspaceId,date])).rows[0].n,1);
  for(const tier of ['enterprise','pro','growth','starter']){
    await subscribe(tier);
    const current=(await notices.inbox(db,ctx.workspaceId)).map(n=>n.sourceId);
    assert.ok(current.includes('agent-notice-169'));
    const channelRows=(await reviews.run(db,ctx,'channel-alerts',{filter:'Test shop'})).rows;
    assert.deepEqual(new Set(channelRows.map(r=>r.Alert)),new Set(['No recent sync activity','Channel quantity exceeds available stock']));
    assert.ok(Number(channelRows.find(r=>r.SKU)['Stock after sales commitments'])<40);
    for(const [job,key,allowed] of [[170,'cost-alerts',tier!=='starter'],[171,'unusual-stock-activity',['enterprise','pro'].includes(tier)]]){
      const read=()=>reviews.run(db,ctx,key,{scheduled:true});assert.equal(current.includes('agent-notice-'+job),allowed,tier+' '+key);
      if(!allowed){await assert.rejects(read(),e=>e.code==='entitlement_required');await browser.get(root+key).expect(402);continue;}
      const {rows}=await read();
      if(job===170){
        assert.deepEqual(new Set(rows.map(r=>r.Alert)),new Set(['Below your gross margin','Purchase cost increased']));
        assert.equal(rows[0].Cost,'$6.00');assert.equal(rows[0]['Previous cost'],'$4.00');assert.equal(Number(rows[0]['Gross margin %']),40);
      }else{
        assert.ok(rows.some(r=>r.Alert==='Large adjustment'&&Number(r['Units changed'])===-5));
        assert.ok(rows.some(r=>r.Alert==='Stock change during watched hours'&&r['Local time']===date+' 23:30'));
      }
    }
    const inbox=await browser.get('/needs-you').expect(200);
    assert.equal(inbox.text.includes('/autopilot/reviews/unusual-stock-activity'),['enterprise','pro'].includes(tier));
    assert.ok(inbox.text.includes('/autopilot/reviews/daily-briefing?filter='+date));
    const briefing=await reviews.run(db,ctx,'daily-briefing',{filter:date});
    assert.equal(briefing.rows.find(r=>r.Activity==='Count adjustments').Count,1);
    assert.equal(briefing.rows.find(r=>r.Activity==='Stock receipts').Count,1);
    assert.ok(briefing.rows.every(r=>r['Team member']===undefined));
    if(tier==='starter')await browser.get(root+'daily-team-summary').expect(402);
    else{
      const team=(await reviews.run(db,ctx,'daily-team-summary',{filter:date})).rows;
      assert.ok(team.some(r=>r['Team member']==='Owner'&&r.Activity==='Stock receipts'&&r.Count===1));
      assert.ok(team.some(r=>r.Activity==='Overdue orders, shipments and invoices'));
    }
  }
  await subscribe('growth');
  await db.query('UPDATE workspace_connectors SET last_synced_at=now()::text WHERE id=$1',[channel]);
  await db.query("UPDATE connection_commerce_positions SET baseline_provider='0' WHERE connector_id=$1",[channel]);
  await notices.refresh(db,ctx.workspaceId);assert.equal((await reviews.run(db,ctx,'channel-alerts')).rows.length,0);
  await watches.save(db,ctx,170,{marginPct:40,revision:1});
  assert.deepEqual((await reviews.run(db,ctx,'cost-alerts')).rows.map(r=>r.Alert),['Purchase cost increased']);
  await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'EUR',amountMinor:900});await notices.refresh(db,ctx.workspaceId);
  assert.equal((await reviews.run(db,ctx,'cost-alerts')).rows.length,0);
});
test('credit reviews reconcile partial billing and price proposals protect margin with individual approval',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10});
  const {db,ctx,workflows,subscribe,browser}=f,sku=f.item.skuIds[0];
  await subscribe('pro');
  await db.query("UPDATE accounts SET created_at=(now()-interval '20 days')::text WHERE id=$1",[f.owner.accountId]);
  await db.query(`INSERT INTO customer_payment_terms(id,workspace_id,customer_id,kind,credit_limit_minor,created_at,updated_at)
    VALUES($1,$2,'fixture-customer','ON_ACCOUNT',400,now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
  const order=(quantity,unitPriceMinor)=>workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,
    idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity,unitPriceMinor}]});
  const partial=await order(3,50);
  await workflows.confirmSalesOrder(db,ctx,partial.salesOrderId,{idempotencyKey:randomUUID()});
  await workflows.fulfillSalesOrder(db,ctx,partial.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:partial.lineIds[0],locationId:f.location.id,quantity:1}]});
  const pending=await order(1,300);
  const notices=require('../../src/autopilot/operational-notices');
  const modes=require('../../src/autopilot/job-modes');
  const alerts=async()=>(await notices.inbox(db,ctx.workspaceId,ctx.actorId)).filter(n=>n.sourceId==='agent-notice-80');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const orderPage=await browser.get('/orders/'+pending.salesOrderId).expect(200);
  assert.match(orderPage.text,/Check customer credit/);
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await pricing.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor:1000});
  for(const amountMinor of [400,500])await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const credit=(await reviews.run(db,ctx,'order-credit-limits',{filter:pending.orderNumber})).rows[0];
    const page=await browser.get('/orders/'+pending.salesOrderId).expect(200);
    const panel=page.text.match(/aria-label="Customer credit check"[\s\S]*?<\/section>/)?.[0];
    assert.match(panel,/Over limit/);
    await notices.refresh(db,ctx.workspaceId);
    assert.equal((await alerts()).length,tier==='starter'?0:1);
    if(tier==='starter'){
      assert.match(credit.Suggestion,/Over limit/);
      assert.doesNotMatch(panel,/Exposure with this order/);
    }
    else{
      assert.equal(credit['Open invoices'],'$0.50');assert.equal(credit['Unbilled orders'],'$4.00');assert.equal(credit['Exposure with this order'],'$4.50');
      assert.equal(credit.Result,'Over limit');
      assert.match(panel,/Exposure with this order[\s\S]*?\$4\.50/);
    }
    const bad=(await reviews.run(db,ctx,'order-price-exceptions',{filter:partial.orderNumber})).rows;
    assert.ok(bad.some(r=>r.Problem==='Selling below recorded cost'));
    const prices=(await reviews.run(db,ctx,'margin-prices',{filter:code})).rows;
    const prep=()=>assistant.prepareAction(db,ctx,'Review selling price',{action:'catalog.restore_margin',sku:code});
    if(['starter','growth'].includes(tier)){
      assert.match(prices[0].Suggestion,/\$12.50/);await assert.rejects(prep(),e=>e.code==='entitlement_required');
    }else{
      assert.equal(prices[0]['Suggested selling price'],'$12.50');
      const page=await browser.get('/autopilot/reviews/margin-prices').expect(200);
      assert.match(page.text,/Prepare price change/);
      const form=await browser.post('/autopilot/reviews/margin-prices/prepare').type('form').send({_csrf:f.csrf(page.text),sku:code}).expect(303);
      const proposalId=form.headers.location.split('/').pop();
      assert.equal((await pricing.currentPrice(db,ctx.workspaceId,sku)).amount_minor,1000);
      await subscribe('growth');await assert.rejects(assistant.executeProposal(db,ctx,proposalId),/Pro/);
      if(tier==='enterprise'){
        await subscribe('enterprise');await assistant.executeProposal(db,ctx,proposalId);
        assert.equal((await pricing.currentPrice(db,ctx.workspaceId,sku)).amount_minor,1250);
        assert.deepEqual((await reviews.run(db,ctx,'margin-prices',{filter:code})).rows,[]);
      }
    }
  }
  await modes.save(db,ctx,80,{mode:'watch',revision:0});
  assert.deepEqual(await alerts(),[]);
  await modes.save(db,ctx,80,{mode:'routine',revision:1});
  const bill=(await db.query('SELECT id,balance_minor FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,partial.salesOrderId])).rows[0];
  await workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:bill.id,amountMinor:Number(bill.balance_minor),method:'cash',paymentDate:await require('../../src/lib/business-time').today(db,ctx.workspaceId),idempotencyKey:randomUUID()});
  assert.equal((await reviews.run(db,ctx,'order-credit-limits',{filter:pending.orderNumber})).rows[0].Result,'Within limit');
  await notices.refresh(db,ctx.workspaceId);
  assert.deepEqual(await alerts(),[]);
  assert.match((await browser.get('/orders/'+pending.salesOrderId).expect(200)).text,/Within limit/);
  assert.equal((await db.query('SELECT status FROM sales_orders WHERE id=$1',[pending.salesOrderId])).rows[0].status,'DRAFT');
  await db.query('UPDATE sales_orders SET discount_minor=discount_minor+25 WHERE id=$1',[partial.salesOrderId]);
  assert.ok((await reviews.run(db,ctx,'order-price-exceptions',{filter:partial.orderNumber})).rows.some(r=>r.Problem==='Order discount differs from approved quote'));
  const roi=await require('../../src/autopilot/time-saved').report(db,ctx);
  assert.equal(roi.rows.find(r=>r.key==='margin-price').count,1);
});
