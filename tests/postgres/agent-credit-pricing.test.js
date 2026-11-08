'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const reviews=require('../../src/autopilot/job-reviews'),assistant=require('../../src/assistant/postgres-service');
const pricing=require('../../src/pricing/postgres-service');
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
  const orderPage=await browser.get('/orders/'+pending.salesOrderId).expect(200);
  assert.match(orderPage.text,/Check customer credit/);
  const code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
  await pricing.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor:1000});
  for(const amountMinor of [400,500])await pricing.setPurchaseCost(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  for(const tier of ['starter','growth','pro','enterprise']){
    await subscribe(tier);
    const credit=(await reviews.run(db,ctx,'order-credit-limits',{filter:pending.orderNumber})).rows[0];
    if(tier==='starter')assert.match(credit.Suggestion,/Over limit/);
    else{
      assert.equal(credit['Open invoices'],'$0.50');assert.equal(credit['Unbilled orders'],'$4.00');assert.equal(credit['Exposure with this order'],'$4.50');
      assert.equal(credit.Result,'Over limit');
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
  const bill=(await db.query('SELECT id,balance_minor FROM accounting_customer_invoices WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,partial.salesOrderId])).rows[0];
  await workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:bill.id,amountMinor:Number(bill.balance_minor),method:'cash',paymentDate:await require('../../src/lib/business-time').today(db,ctx.workspaceId),idempotencyKey:randomUUID()});
  assert.equal((await reviews.run(db,ctx,'order-credit-limits',{filter:pending.orderNumber})).rows[0].Result,'Within limit');
  await db.query('UPDATE sales_orders SET discount_minor=discount_minor+25 WHERE id=$1',[partial.salesOrderId]);
  assert.ok((await reviews.run(db,ctx,'order-price-exceptions',{filter:partial.orderNumber})).rows.some(r=>r.Problem==='Order discount differs from approved quote'));
});
