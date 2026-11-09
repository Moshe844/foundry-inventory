'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('known-customer order creation still needs the plan authority for Starter and Growth',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,subscribe,workflows}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 await require('../../src/pricing/postgres-service').setPrice(db,ctx,{skuId:sku,amountMinor:1000,currency:'USD'});
 const original=await workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:sku,quantity:1,unitPriceMinor:1000}]});
 await workflows.confirmSalesOrder(db,ctx,original.salesOrderId,{idempotencyKey:randomUUID()});
 const assistant=require('../../src/assistant/postgres-service'),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 const args={action:'create_sales_order',customer:'Receiver',sku:code,quantity:1,amount:null,currency:'USD',deliveryMethod:'PICKUP',location:f.location.name};
 const prepare=(patch={})=>assistant.prepareAction(db,ctx,'Draft one item for Receiver',{...args,...patch});
 const mission=async(patch={})=>{const p=await prepare(patch);assert.equal(p.status,'PREPARED',JSON.stringify(p));await plans.save(db,ctx,'Prepare this order then check products',randomUUID(),[
  {contract:registry.get('sales_order.create'),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}
 ],[{result:p},{result:{status:'CLARIFY'}}]);return p;};
 await subscribe('starter');const pending=await mission();
 await assert.rejects(assistant.executeMission(db,ctx,pending.proposal.id),/own confirmation/);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 await assistant.executeProposal(db,ctx,pending.proposal.id);
 await subscribe('growth');const untrained=await mission();await assert.rejects(assistant.executeMission(db,ctx,untrained.proposal.id),/Individually approve/);
 await require('../../src/autopilot/draft-authority').save(db,ctx,pending.proposal.id,{mode:'save',maximum:'15',revision:0});
 await assistant.executeMission(db,ctx,untrained.proposal.id);
 const tooLarge=await mission({quantity:2});await assert.rejects(assistant.executeMission(db,ctx,tooLarge.proposal.id),/Individually approve/);
 const other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Other pickup',kind:'warehouse'});
 const changedPickup=await mission({location:other.name});await assert.rejects(assistant.executeMission(db,ctx,changedPickup.proposal.id),/Individually approve/);
 const downgraded=await mission();await subscribe('starter');await assert.rejects(assistant.executeMission(db,ctx,downgraded.proposal.id),/own confirmation/);
 for(const tier of ['pro','enterprise']){await subscribe(tier);const p=await mission();await assistant.executeMission(db,ctx,p.proposal.id);}
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,5);
 await subscribe('pro');await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'New Receiver'});
 const newcomer=await mission({customer:'New Receiver'});await assert.rejects(assistant.executeMission(db,ctx,newcomer.proposal.id),/Individually approve/);
 assert.equal(await f.balance(),20);
});
