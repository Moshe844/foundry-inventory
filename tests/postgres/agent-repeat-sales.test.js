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
  const modes=require('../../src/autopilot/postgres-service');
  await modes.setMode(db,ctx,{role:'owner'},'OBSERVE');
  await assert.rejects(assistant.executeProposal(db,ctx,first.proposal.id),/watch-only/);
  await modes.setMode(db,ctx,{role:'owner'},'SUPERVISED');
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
  const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
  const payload={customerId:'fixture-customer',currency:'USD',deliveryMethod:'SHIP',shipToAddress:'500 Brand New Street, Brooklyn, NY 11201, US',
    fulfillmentLocationId:f.location.id,lines:[{skuId:sku,quantity:1,unitPriceMinor:800}]};
  const action=await assistant.createProposal(db,ctx,'Ship to our new address','sales_order.create',payload,'Prepare an order to the new address.');
  await plans.save(db,ctx,'Prepare the order and review open customer orders',randomUUID(),
    [{contract:registry.get('sales_order.create'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'sales-order-checks'},dependsOn:[0]}],
    [{result:action},{result:{status:'CLARIFY'}}]);
  await assert.rejects(assistant.executeMission(db,ctx,action.proposal.id),/Individually approve/);
  assert.equal((await assistant.getProposal(db,ctx.workspaceId,action.proposal.id)).status,'PENDING');
  await assistant.executeProposal(db,ctx,action.proposal.id);
  assert.equal((await assistant.getProposal(db,ctx.workspaceId,action.proposal.id)).status,'EXECUTED');
  await subscribe('growth');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const repeatExample=await request({sourceOrderNumber:original.orderNumber});
  await assistant.executeProposal(db,ctx,repeatExample.proposal.id);
  await require('../../src/autopilot/draft-authority').save(db,ctx,repeatExample.proposal.id,{mode:'save',maximum:'24',revision:0});
  const auto=await request({sourceOrderNumber:original.orderNumber});
  await plans.save(db,ctx,'Repeat the approved customer draft and review open orders',randomUUID(),
    [{contract:registry.get('sales_order.repeat'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'sales-order-checks'},dependsOn:[0]}],
    [{result:auto},{result:{status:'CLARIFY'}}]);
  const result=await assistant.executeMission(db,ctx,auto.proposal.id);
  assert.equal(result.result.pricing.totalMinor,2400);
  const roi=await require('../../src/autopilot/time-saved').report(db,ctx);
  assert.equal(roi.rows.find(r=>r.key==='repeat-sale').count,5);
});
