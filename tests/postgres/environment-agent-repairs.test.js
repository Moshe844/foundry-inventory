'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('repaired gateway preserves approvals and durable state for numeric operations and exact draft identifiers',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline owner',businessName:'Offline contract verification',email:`${randomUUID()}@example.test`,password:`Fixture!${randomUUID()}`});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},suffix=randomUUID().slice(0,8),sku=`R-${suffix}`,poNumber=`P-${suffix}`;
 const product=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:`Part ${suffix}`,baseCode:sku,trackingMode:'quantity'});
 const place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:`Depot ${suffix}`,kind:'warehouse'});
 const supplier=await require('../../src/operations/postgres-commerce').createSupplier(db,ctx,{name:`Supplier ${suffix}`});
 const goals=require('../../src/assistant/postgres-goal-store');let providerCalls=0;
 const provider={async complete(){providerCalls++;throw new Error('Paid calls forbidden in offline regression');}};
 const held=await goals.claim(db,ctx,(await goals.create(db,ctx,`Record 7 physically arrived ${sku} at ${place.name}. Prepare draft ${poNumber} for 11 more from ${supplier.name} at USD 2.75 per unit, same destination. Require approvals.`)).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:held.original_request,goalId:held.id,runToken:held.run_token,provider});
 const settings={database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:gateway.authorize};
 const session=require('../../scripts/environment-agent-demo/session').createSession(settings);
 const step=(capability,args)=>({capability,arguments:Object.entries(args).map(([name,value])=>({name,value})),dependsOn:[]});
 const arrival=[step('inventory.receive',{sku,location:place.name,quantity:7,reference:`DEL-${suffix}`})];
 const prepared=await session.execute('business_operations',{stepsJson:JSON.stringify(arrival)},callId=>gateway.operate({steps:arrival,callId}));
 assert.equal(prepared.outcomes[0].result.status,'PREPARED',JSON.stringify(prepared));
 assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 const replay=await session.execute('business_operations',{stepsJson:JSON.stringify([step('inventory.receive',{sku,location:place.name,quantity:'7',reference:`DEL-${suffix}`})])},()=>{throw new Error('Numeric transport must not duplicate proposals');});
 assert.equal(replay.replayed,true);
 // Evaluator simulates explicit human approval only in this disposable fixture.
 await require('../../src/assistant/postgres-service').executeProposal(db,ctx,prepared.outcomes[0].result.proposal.id,{provider});
 assert.equal(Number((await db.query('SELECT on_hand FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[ctx.workspaceId,product.skuIds[0],place.id])).rows[0].on_hand),7);
 const po=[step('purchase_order.create',{supplier:supplier.name,sku,quantity:11,amount:2.75,currency:'USD',location:place.name,poNumber})];
 const draft=await session.execute('business_operations',{stepsJson:JSON.stringify(po)},callId=>gateway.operate({steps:po,callId}));
 assert.equal(draft.outcomes[0].result.status,'PREPARED',JSON.stringify(draft));
 const proposal=(await db.query('SELECT payload,summary FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[draft.outcomes[0].result.proposal.id])).rows[0];
 assert.equal(proposal.payload.poNumber,poNumber);assert.match(proposal.summary,new RegExp(poNumber));
 await require('../../src/assistant/postgres-service').executeProposal(db,ctx,draft.outcomes[0].result.proposal.id,{provider});
 const recorded=(await db.query('SELECT p.po_number,p.status,l.quantity_units,l.unit_cost FROM purchase_orders p JOIN purchase_order_lines l ON l.purchase_order_id=p.id WHERE p.workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(recorded.length,1);assert.equal(recorded[0].po_number,poNumber);assert.equal(recorded[0].status,'DRAFT');
 assert.equal(Number(recorded[0].quantity_units),11);assert.equal(Number(recorded[0].unit_cost),2.75);
 const dataset=require('../../src/reports/postgres-registry').list({role:'owner'}).find(d=>d.fields.sku&&d.fields.on_hand);
 assert.ok(dataset);
 const discovery=await session.execute('environment_interfaces',{names:[dataset.key]},()=>gateway.interfaces({names:[dataset.key]}));
 assert.ok(discovery.datasets[0].queryContract);
 await assert.rejects(()=>session.execute('environment_dataset',{specJson:'bad-contract'},()=>gateway.dataset({spec:{dataset:dataset.key,columns:['sku'],filters:[{field:'sku',op:'eq',value:sku}]}})),/operator/);
 const report=await gateway.dataset({spec:{dataset:dataset.key,columns:['sku','on_hand'],filters:[{field:'sku',operator:'equals',value:sku}]}});
 assert.ok(JSON.stringify(report).includes(sku));
 await session.execute('environment_notebook',{note:'Verify the complete draft and physical receipt separately.',evidenceIds:[]},async()=>({saved:true}));
 const resumed=require('../../scripts/environment-agent-demo/session').createSession(settings),memory=await resumed.workingMemory();
 assert.ok(memory.contracts.some(c=>c.name===dataset.key));assert.match(memory.lastToolError.message,/operator/);assert.match(memory.notebook.note,/separately/);
 const stopped=await resumed.stop({code:'OFFLINE_COST_GATE'});assert.match(stopped.answer,/recorded and verified/);
 assert.equal(providerCalls,0);assert.equal((await goals.get(db,ctx,held.id)).status,'BLOCKED');
 await t.test('adaptive final verification recovers a transient read and preserves diagnostic output on failure',async()=>{
  const flag=process.env.STOCKCHIEF_ADAPTIVE_ASK,spaces=process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES;
  process.env.STOCKCHIEF_ADAPTIVE_ASK='1';process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=ctx.workspaceId;
  try{
   const {PRICED_MODEL,pricedUsage}=require('../helpers/postgres-model-fixture');
   const choose=(action,extra={})=>({action,progress:'Inspecting',query:'',steps:[],answer:'',evidence:[],...extra});
   let phase=0,verificationReads=0,retries=0,failVerdict=false;
   const synthetic={name:'anthropic',model:PRICED_MODEL,async complete(request){
    if(request.schemaName==='stockchief_adaptive_verification'){
     if(failVerdict)throw Object.assign(new Error('Synthetic output limit'),{code:'ai_invalid_output',stopReason:'max_tokens',usage:pricedUsage({outputTokens:500})});
     return {data:{complete:true,grounded:true,reason:''},usage:pricedUsage()};
    }
    const data=[choose('discover',{query:'read.inventory_summary'}),choose('operate',{steps:[step('read.inventory_summary',{})]}),
     choose('finish',{answer:'Seven units are recorded.',evidence:[0]})][phase++];
    return {data,usage:pricedUsage()};
   }};
   const injected={query:async(sql,args)=>{
    if(phase===3&&verificationReads===0&&/\bbalances\b/i.test(sql)){verificationReads++;throw Object.assign(new Error('Transient connection reset'),{code:'08006'});}
    return db.query(sql,args);
   }};
   const transientDb={...db,query:(sql,args)=>require('../../scripts/environment-agent-demo/read-recovery').query(injected,sql,args,()=>retries++)};
   const controller=require('../../src/assistant/postgres-goal-controller');
   const outcome=await controller.start(transientDb,ctx,'Check the current inventory summary.',{provider:synthetic});
   assert.equal(outcome.goalStatus,'COMPLETED');assert.equal(retries,1);assert.equal(verificationReads,1);
   phase=0;failVerdict=true;
   const failed=await controller.start(db,ctx,'Check the current inventory summary again.',{provider:synthetic});
   assert.equal(failed.goalStatus,'BLOCKED');
   const event=(await db.query("SELECT detail FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1 AND kind='stopped'",[failed.goalId])).rows[0];
   assert.equal(event.detail.code,'ai_invalid_output');assert.equal(event.detail.stopReason,'max_tokens');assert.equal(event.detail.outputTokens,500);
  }finally{
   if(flag===undefined)delete process.env.STOCKCHIEF_ADAPTIVE_ASK;else process.env.STOCKCHIEF_ADAPTIVE_ASK=flag;
   if(spaces===undefined)delete process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES;else process.env.STOCKCHIEF_ADAPTIVE_ASK_WORKSPACES=spaces;
  }
 });
});
