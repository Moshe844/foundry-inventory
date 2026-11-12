'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const release=require('../../src/warehouse/agent-pick-release');
const modes=require('../../src/autopilot/job-modes');
const autopilot=require('../../src/autopilot/postgres-service');
const places=require('../../src/domain/postgres-location-service');
const stock=require('../../src/domain/postgres-inventory-engine');
const time=require('../../src/lib/business-time');
const {addDays}=require('../../src/accounting/customer-money');

async function mission(db,ctx,p){
 const assistant=require('../../src/assistant/postgres-service'),plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 const noModel={name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('Warehouse release must use its native saved steps.');}};
 if(!await plans.missionForProposal(db,ctx.workspaceId,ctx.actorId,p.id)){
  const goal=await require('../../src/assistant/postgres-goal-store').create(db,ctx,'Release warehouse work then inspect stock permissions');
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,goal.id]);
  const chain=await plans.save(db,ctx,'Release warehouse work then inspect stock permissions',randomUUID(),[{contract:registry.get(p.action_type),args:{recordReference:p.payload.recordId||p.payload.orderIds[0]},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'financial-permissions'},dependsOn:[0]}],[{result:{status:'PREPARED',proposal:{id:p.id}}},{result:{status:'CLARIFY',reason:'dependency_waiting'}}]);
  await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,chain.id,goal.id]);
 }
 return assistant.executeMission(db,ctx,p.id,{provider:noModel});
}

async function setup(t,units=40){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units}),{db,ctx}=f,ws=ctx.workspaceId;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const assistant=require('../../src/assistant/postgres-service'),sku=f.item.skuIds[0];
 await db.query("UPDATE skus SET barcode='PICK-ITEM' WHERE workspace_id=$1 AND id=$2",[ws,sku]);await db.query("UPDATE locations SET barcode='PICK-BIN' WHERE workspace_id=$1 AND id=$2",[ws,f.location.id]);
 const order=async({quantity=2,price=1000,priority=100,neededBy=null,location=f.location.id,address='10 Jobsite Rd, Albany, NY 12207',customer='fixture-customer',skuId=sku}={})=>{
  const o=await f.workflows.createSalesOrder(db,ctx,{customerId:customer,deliveryMethod:'SHIP',shipToAddress:address,fulfillmentLocationId:location,neededBy,idempotencyKey:randomUUID(),lines:[{skuId,quantity,unitPriceMinor:price}]});
  await f.workflows.confirmSalesOrder(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID()});
  if(priority!==100)await db.query('UPDATE sales_orders SET allocation_priority=$3 WHERE workspace_id=$1 AND id=$2',[ws,o.salesOrderId,priority]);
  return o;};
 const prepare=async(action,reference,extra={})=>{const p=await assistant.prepareAction(db,ctx,'Prepare warehouse work '+randomUUID(),{action,recordReference:reference,...extra});assert.equal(p.status,'PREPARED',JSON.stringify(p));return assistant.getProposal(db,ctx.workspaceId,p.proposal.id);};
 const releases=async(where='true')=>(await db.query(`SELECT * FROM stockchief_runtime.agent_pick_releases WHERE workspace_id=$1 AND ${where} ORDER BY created_at,id`,[ws])).rows;
 const members=async id=>(await db.query('SELECT sales_order_id FROM stockchief_runtime.agent_pick_release_orders WHERE workspace_id=$1 AND release_id=$2 ORDER BY position',[ws,id])).rows.map(r=>r.sales_order_id);
 const audits=async action=>Number((await db.query('SELECT count(*) n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].n);
 const boxes=async()=>Number((await db.query("SELECT count(*) n FROM sales_shipments WHERE workspace_id=$1 AND status<>'CANCELLED'",[ws])).rows[0].n);
 const today=await time.today(db,ws);
 return {...f,ws,sku,assistant,order,prepare,releases,members,audits,boxes,today};
}
const id=o=>o.salesOrderId;

test('local picking and ShipBob submission claim one fulfillment path before either creates work',{timeout:240000},async t=>{
 const f=await setup(t,20),{db,ctx,order}=f,provider=require('../../src/connections/postgres-shipbob-sandbox'),waves=require('../../src/operations/postgres-fulfillment-waves'),code=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]])).rows[0].code,remote=new Map();let posts=0;
 const transport=async(url,input)=>{const u=new URL(url),respond=data=>new Response(JSON.stringify(data),{status:200});if(u.pathname.endsWith('/channel'))return respond([{id:581}]);if(input.method==='POST'){posts++;const payload=JSON.parse(input.body);assert.equal(payload.products[0].reference_id,code);const saved={...payload,id:100+posts,channel:{id:581},status:'Processing',shipments:[]};remote.set(payload.reference_id,saved);return respond(saved);}const reference=u.searchParams.get('ReferenceIds');return respond(remote.has(reference)?[remote.get(reference)]:[]);};
 await provider.connect(db,ctx,{apiKey:'fake-sandbox-token',channelId:'581'},transport);
 await release.configure(db,ctx,{locationId:f.location.id,revision:0,batchOrders:'10'});
 const delegated=await order({quantity:1}),review=await provider.draft(db,ctx,delegated.salesOrderId);await provider.send(db,ctx,delegated.salesOrderId,review.hash,transport);assert.equal(posts,1);assert.equal((await release.run(db,ctx.workspaceId)).released,0);
 const parcel=(o)=>f.shipping.prepare(db,ctx,o.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:o.lineIds[0],locationId:f.location.id,quantity:1}]});await assert.rejects(parcel(delegated),/ShipBob/);await assert.rejects(waves.create(db,ctx,{orderIds:[delegated.salesOrderId],idempotencyKey:randomUUID()}),/ShipBob/);assert.equal((await waves.readyOrders(db,ctx.workspaceId)).length,0);
 const local=await order({quantity:1});await parcel(local);await assert.rejects(provider.draft(db,ctx,local.salesOrderId),/unshipped StockChief box/);assert.equal(posts,1);await assert.rejects(waves.create(db,ctx,{orderIds:[local.salesOrderId],idempotencyKey:randomUUID()}),/unshipped box/);
 assert.equal((await release.run(db,ctx.workspaceId)).released,0,'An order with its own box is not released again.');
 const racing=await order({quantity:1}),preview=await provider.draft(db,ctx,racing.salesOrderId),race=await Promise.allSettled([provider.send(db,ctx,racing.salesOrderId,preview.hash,transport),parcel(racing)]);assert.equal(race.filter(r=>r.status==='fulfilled').length,1);const persisted=(await db.query("SELECT (SELECT count(*) FROM sales_shipments WHERE workspace_id=$1 AND sales_order_id=$2 AND status IN ('PICKING','PACKED')) local,(SELECT count(*) FROM stockchief_runtime.shipbob_sandbox_orders WHERE workspace_id=$1 AND sales_order_id=$2) delegated",[ctx.workspaceId,racing.salesOrderId])).rows[0];assert.equal(Number(persisted.local)+Number(persisted.delegated),1);assert.equal(await f.balance(),20);assert.equal((await db.query('SELECT count(*) n FROM accounting_customer_invoices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
});
