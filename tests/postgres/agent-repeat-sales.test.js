'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const assistant=require('../../src/assistant/postgres-service');
const prices=require('../../src/pricing/postgres-service');
const {addDays}=require('../../src/accounting/customer-money');

test('repeating last month’s order uses current prices, refuses ambiguity and checks a downgrade before creating the draft',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:30});
  const {db,ctx,subscribe,workflows}=f,sku=f.item.skuIds[0];
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),lastMonth=addDays(today.slice(0,7)+'-01',-1);
  await subscribe('pro');
  async function source(qty){
    const sale=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',orderDate:lastMonth,deliveryMethod:'PICKUP',
      fulfillmentLocationId:f.location.id,lines:[{skuId:sku,quantity:qty,unitPriceMinor:400}],idempotencyKey:randomUUID()});
    await workflows.confirmSalesOrder(db,ctx,sale.salesOrderId,{idempotencyKey:randomUUID()});return sale;
  }
  const original=await source(3);
  const setPrice=amountMinor=>prices.setPrice(db,ctx,{skuId:sku,currency:'USD',amountMinor});
  const request=extra=>assistant.prepareAction(db,ctx,'Repeat the fixture customer order from last month',
    {action:'sales_order.repeat',recordReference:'fixture-customer',repeatPeriod:'previous-month',...extra});
  await setPrice(700);
  const first=await request();assert.match(first.proposal.summary,/\$21.00/);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '15 days')::text WHERE id=$1",[f.owner.accountId]);
  await subscribe('starter');
  await assert.rejects(request(),/Growth/);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/Growth/);
  await subscribe('growth');
  await setPrice(800);
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/prices changed/);
  await source(2);
  await assert.rejects(request(),/More than one customer order/);
  for(const tier of ['growth','pro','enterprise']){
    await subscribe(tier);
    const action=await request({sourceOrderNumber:original.orderNumber});
    assert.match(action.proposal.summary,/\$24.00/);
    await assistant.executeProposal(db,ctx,action.proposal.id);
    await assistant.executeProposal(db,ctx,action.proposal.id);
  }
  const results=await db.query(`SELECT o.status,o.pricing_total_minor,l.quantity_ordered,l.quantity_fulfilled FROM sales_orders o
    JOIN sales_order_lines l ON l.workspace_id=o.workspace_id AND l.sales_order_id=o.id WHERE o.workspace_id=$1 AND o.reference=$2`,[ctx.workspaceId,original.orderNumber]);
  assert.equal(results.rowCount,3);
  for(const r of results.rows){
    assert.equal(r.status,'DRAFT');assert.equal(Number(r.pricing_total_minor),2400);
    assert.equal(Number(r.quantity_ordered),3);assert.equal(Number(r.quantity_fulfilled),0);
  }
});
