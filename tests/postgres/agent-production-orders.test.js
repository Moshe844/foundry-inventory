'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('production drafts learn an exact BOM and cost limit while physical consumption and output stay individually confirmed',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:24}),{db,ctx,subscribe}=f;
 await subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const service=require('../../src/manufacturing/postgres-service'),assistant=require('../../src/assistant/postgres-service');
 const output=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Agent assembly',baseCode:'AGENT-ASSEMBLY',trackingMode:'quantity'});
 const wip=await require('../../src/accounting/postgres-ledger').createAccount(db,ctx,{code:'1225',name:'Work in progress',type:'ASSET'});await service.configure(db,ctx,{wipAccountId:wip.id});
 const bom=await service.createBom(db,ctx,{outputSkuId:output.skuIds[0],outputQuantity:1,components:[{skuId:f.item.skuIds[0],quantity:2}]});await service.activateBom(db,ctx,bom.id,{expectedHash:bom.integrity_hash});
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const args={action:'manufacturing.create_work_order',manufacturingInput:JSON.stringify({bomId:bom.id,quantity:2,neededBy:today})},prepare=()=>assistant.prepareAction(db,ctx,'Create two assemblies',args);
 const payload=async p=>(await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.proposal.id])).rows[0].payload;
 await subscribe('starter');await assert.rejects(prepare(),e=>e.code==='entitlement_required');
 let example;
 for(const tier of ['growth','pro','enterprise']){
  await subscribe(tier);const p=await prepare();assert.match(p.proposal.summary,/\$4.00/);await assistant.executeProposal(db,ctx,p.proposal.id);await assistant.executeProposal(db,ctx,p.proposal.id);example=p;
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM manufacturing_work_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,3);
 const order=(await db.query('SELECT * FROM manufacturing_work_orders WHERE workspace_id=$1 ORDER BY order_number LIMIT 1',[ctx.workspaceId])).rows[0];
 await subscribe('growth');
 const plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 const next=await prepare();
 await plans.save(db,ctx,'Create the draft and check catalogue',randomUUID(),[
  {contract:registry.get(args.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}
 ],[{result:next},{result:{status:'CLARIFY'}}]);
 await assert.rejects(assistant.executeMission(db,ctx,next.proposal.id),e=>e.code==='entitlement_required');
 await require('../../src/autopilot/draft-authority').save(db,ctx,example.proposal.id,{mode:'save',maximum:'5',revision:0});
 await assistant.executeMission(db,ctx,next.proposal.id);
 const larger=await assistant.prepareAction(db,ctx,'Create four assemblies',{...args,manufacturingInput:JSON.stringify({bomId:bom.id,quantity:4,neededBy:today})});
 assert.equal(await require('../../src/autopilot/draft-authority').trained(db,ctx.workspaceId,args.action,await payload(larger)),false,'The estimated material value must stay below the owner limit');
 await require('../../src/autopilot/job-modes').save(db,ctx,14,{mode:'watch',revision:0});
 const watched=await prepare();await assert.rejects(assistant.executeProposal(db,ctx,watched.proposal.id),/Watch only/);
 await require('../../src/autopilot/job-modes').save(db,ctx,14,{mode:'inherit',revision:1});
 const stale=await prepare();await db.transaction(c=>require('../../src/pricing/postgres-service').setPurchaseCostsInTransaction(c,ctx,[{skuId:f.item.skuIds[0],amountMinor:150,currency:'USD'}]));
 await assert.rejects(assistant.executeProposal(db,ctx,stale.proposal.id),/costs or BOM changed/);
 const changed=await prepare();assert.equal(await require('../../src/autopilot/draft-authority').trained(db,ctx.workspaceId,args.action,await payload(changed)),false,'A different component cost needs a new trained scope');
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,changed.proposal.id),e=>e.code==='entitlement_required');
 await subscribe('growth');
 const start=await assistant.prepareAction(db,ctx,'Confirmed: four components are entering production',{action:'manufacturing.start',recordReference:order.order_number,manufacturingInput:JSON.stringify({confirmed:'yes',materials:[{component:0,skuId:f.item.skuIds[0],locationId:f.location.id,quantity:4}]})});
 await subscribe('starter');await assert.rejects(assistant.executeProposal(db,ctx,start.proposal.id),e=>e.code==='entitlement_required');await subscribe('growth');
 assert.equal(await f.balance(),24);await assistant.executeProposal(db,ctx,start.proposal.id);await assistant.executeProposal(db,ctx,start.proposal.id);assert.equal(await f.balance(),20);
 const done=await assistant.prepareAction(db,ctx,'Confirmed: two finished assemblies received',{action:'manufacturing.complete',recordReference:order.order_number,manufacturingInput:JSON.stringify({good:2,scrap:0,confirmed:'yes',locationId:f.location.id})});
 await assistant.executeProposal(db,ctx,done.proposal.id);await assistant.executeProposal(db,ctx,done.proposal.id);
 assert.equal((await service.getWorkOrder(db,ctx.workspaceId,order.id)).status,'COMPLETED');
 assert.equal((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,output.skuIds[0],f.location.id])).rows[0].on_hand,'2');
 assert.equal((await db.query('SELECT total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,output.skuIds[0],f.location.id])).rows[0].total_cost_minor,'400');
 assert(require('../../src/commercial/agent-plan').needsPerson('manufacturing.start'));
 assert(require('../../src/commercial/agent-plan').needsPerson('manufacturing.complete'));
 for(const tier of ['pro','enterprise']){
  await subscribe(tier);const p=await prepare();
  await plans.save(db,ctx,'Create a production draft and check catalogue',randomUUID(),[
   {contract:registry.get(args.action),args:{},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'catalog-health'},dependsOn:[0]}
  ],[{result:p},{result:{status:'CLARIFY'}}]);
  await assistant.executeMission(db,ctx,p.proposal.id);
 }
 assert.equal((await db.query('SELECT count(*)::int n FROM manufacturing_work_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,6);
});
