'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];}
function step(capability,args={}){return {capability,arguments:Object.entries(args).map(([name,value])=>({name,value:String(value)})),
  dependsOn:[],continuesPending:false};}

test('Ask selects a registered operation, resolves unique records, and executes only after approval',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-capability-ask'});
    await migratePostgres(database);
    const plans=[step('inventory.receive',{quantity:11,reference:'CARTON-11'}),
      step('navigate.purchasing')];
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      if(input.schemaName!=='stockchief_capability_plan')throw new Error(`Unexpected model request ${input.schemaName}`);
      return {data:{steps:[plans.shift()],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'capability-ask-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Capable Business',email:'capable@example.test',password:'password-for-testing'});
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Capable Business'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    const place=await locations.createLocation(database,ctx,{name:'Only Store',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Blue Work Glove',trackingMode:'quantity'});
    const ask=await agent.get('/ask');
    const prepared=await agent.post('/ask').type('form').send({_csrf:csrf(ask.text),
      message:'A carton of eleven arrived; make the stock record reflect the delivery.',usageKey:'contract-ask-1'});
    assert.equal(prepared.status,303);
    const proposal=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
    assert.equal(proposal.action_type,'inventory.receive');
    assert.equal(proposal.payload.skuId,item.skuIds[0]);
    assert.equal(proposal.payload.locationId,place.id);
    const before=(await database.query(`SELECT COALESCE(SUM(on_hand),0) AS units FROM balances WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0];
    assert.equal(Number(before.units),0);
    const review=await agent.get(`/actions/${proposal.id}`);
    const approved=await agent.post(`/actions/${proposal.id}/approve`).type('form').send({_csrf:csrf(review.text)});
    assert.equal(approved.status,303);
    const after=(await database.query(`SELECT COALESCE(SUM(on_hand),0) AS units FROM balances WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0];
    assert.equal(Number(after.units),11);
    const opened=await agent.post('/ask').type('form').send({_csrf:csrf(ask.text),
      message:'Bring up the area where supplier orders live.',usageKey:'contract-ask-2'});
    assert.equal(opened.status,303);assert.equal(opened.headers.location,'/purchasing');
  });

test('a dependent capability is prepared after the first approval, never executed early',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-capability-plan'});
    await migratePostgres(database);
    const first=step('catalog.create_item',{search:'Copper Clip'});
    const second={...step('inventory.receive',{sku:'Copper Clip',quantity:3}),dependsOn:[0]};
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      assert.equal(input.schemaName,'stockchief_capability_plan');
      return {data:{steps:[first,second],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'capability-plan-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Sequential Business',email:'sequential@example.test',password:'password-for-testing'});
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Sequential Business'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    await locations.createLocation(database,ctx,{name:'Only Store',kind:'warehouse'});
    const ask=await agent.get('/ask');
    const prepared=await agent.post('/ask').type('form').send({_csrf:csrf(ask.text),
      message:'Put Copper Clip in the catalog, then register three delivered units.',usageKey:'sequential-ask'});
    assert.equal(prepared.status,303);
    const initial=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows;
    assert.equal(initial.length,1);assert.equal(initial[0].action_type,'catalog.create_item');
    const plan=(await database.query(`SELECT * FROM stockchief_runtime.assistant_capability_plans
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(plan.steps[1].state,'BLOCKED');
    const review=await agent.get(`/actions/${initial[0].id}`);
    const approved=await agent.post(`/actions/${initial[0].id}/approve`).type('form').send({_csrf:csrf(review.text)});
    assert.equal(approved.status,303);
    const after=(await database.query(`SELECT * FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at`,[ctx.workspaceId])).rows;
    assert.equal(after.length,2);assert.equal(after[0].status,'EXECUTED');
    assert.equal(after[1].action_type,'inventory.receive');assert.equal(after[1].status,'PENDING');
    const onHand=(await database.query(`SELECT COALESCE(SUM(on_hand),0) AS units FROM balances WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0];
    assert.equal(Number(onHand.units),0);
    const replay=await agent.post(`/actions/${initial[0].id}/approve`).type('form').send({_csrf:csrf(review.text)});
    assert.equal(replay.status,303);
    const count=(await database.query(`SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1`,[ctx.workspaceId])).rows[0];
    assert.equal(count.total,2);
  });

test('a correction replaces the pending proposal instead of leaving two approvable versions',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-capability-correction'});
    await migratePostgres(database);
    const plans=[step('inventory.receive',{quantity:11}),
      {...step('inventory.receive',{quantity:12}),continuesPending:true}];
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      if(input.schemaName==='stockchief_capability_fit')return {data:{aligned:true,reason:''},usage:pricedUsage()};
      assert.equal(input.schemaName,'stockchief_capability_plan');
      return {data:{steps:[plans.shift()],clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'capability-correction-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Corrected Business',email:'corrected@example.test',password:'password-for-testing'});
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Corrected Business'`)).rows[0];
    const ctx={workspaceId:owner.workspace_id,actorId:owner.actor_id};
    await locations.createLocation(database,ctx,{name:'Only Store',kind:'warehouse'});
    await catalog.createItem(database,ctx,{name:'Copper Clip',trackingMode:'quantity'});
    const ask=await agent.get('/ask');
    await agent.post('/ask').type('form').send({_csrf:csrf(ask.text),
      message:'A box with eleven arrived.',usageKey:'correction-first'});
    await agent.post('/ask').type('form').send({_csrf:csrf(ask.text),
      message:'Correction: it held twelve.',usageKey:'correction-second'});
    const proposals=(await database.query(`SELECT status,payload FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at,id`,[ctx.workspaceId])).rows;
    assert.equal(proposals.length,2);
    assert.equal(proposals.filter((row)=>row.status==='PENDING').length,1);
    assert.equal(proposals.find((row)=>row.status==='PENDING').payload.quantity,12);
  });
