'use strict';
const {randomUUID}=require('node:crypto');
async function fixture(t,plan='pro'){
 const f=await require('./agent-workflow-fixture').fixture(t,{units:20}),{db,ctx}=f;await f.subscribe(plan);await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 async function order(quantity=2,extra={}){return f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity,unitPriceMinor:1000}],...extra});}
 const known=await order(1);await f.workflows.confirmSalesOrder(db,ctx,known.salesOrderId,{idempotencyKey:randomUUID()});
 const prepare=(o,action='sales_order.reserve_all',extra={})=>assistant.prepareAction(db,ctx,'Apply the exact reviewed customer stock request',{action,recordReference:o.salesOrderId,...extra});
 async function mission(o,action='sales_order.reserve_all',extra={}){const p=await prepare(o,action,extra);if(p.status!=='PREPARED')throw Error(JSON.stringify(p));await plans.save(db,ctx,'Apply this exact stock request then check products',randomUUID(),[{contract:registry.get(action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}],[{result:p},{result:{status:'CLARIFY'}}]);return p;}
 const reserved=async o=>Number((await db.query('SELECT coalesce(sum(a.quantity),0) n FROM sales_order_allocations a JOIN sales_order_lines l ON l.workspace_id=a.workspace_id AND l.id=a.sales_order_line_id WHERE l.workspace_id=$1 AND l.sales_order_id=$2',[ctx.workspaceId,o.salesOrderId])).rows[0].n);
 return {...f,assistant,plans,order,known,prepare,mission,reserved};
}
module.exports={fixture};
