'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {pricedUsage,PRICED_MODEL}=require('../helpers/postgres-model-fixture');
const discovery=require('../../src/assistant/postgres-discovery');
const {registry}=require('../../src/assistant/postgres-capability-registry');
const catalog=require('../../src/domain/postgres-catalog-service');
const auth=require('../../src/domain/postgres-auth-service');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];}

test('Ask suggestions come only from registered, currently available capabilities',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-discovery'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'discovery-secret'});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Discovery Business',email:'discovery@example.test',password:'password-for-testing'});
    const ctx=(await database.query(`SELECT w.id AS "workspaceId",u.id AS "actorId" FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Discovery Business'`)).rows[0];
    const capabilities=await discovery.available(database,ctx);
    const examples=await discovery.suggestions(database,ctx);
    assert.equal(examples[0],'What can you help me do here?');
    assert.ok(capabilities.length>0);
    assert.ok(capabilities.every((entry)=>registry.get(entry.name)?.discovery?.prompt===entry.prompt));
    assert.ok(!capabilities.some((entry)=>entry.name==='communication.send_email'),
      'an unconnected mailbox must not be advertised');
    assert.ok(!capabilities.some((entry)=>entry.name==='shipping.labels'),
      'unsupported Ask actions must not be advertised');
    const page=await agent.get('/ask');
    assert.equal(page.status,200);
    assert.match(page.text,/What can you help me do here\?/);
    for(const example of examples)assert.match(page.text,new RegExp(example.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    const item=await catalog.createItem(database,ctx,{name:'Discovery Clamp',trackingMode:'quantity'});
    const contextual=await agent.get(`/ask?from=${encodeURIComponent(`/inventory/${item.itemId}`)}`);
    assert.equal(contextual.status,200);
    assert.match(contextual.text,/name="sourcePath" value="\/inventory\//);
    const productSuggestions=await discovery.suggestions(database,ctx,4,
      {path:`/inventory/${item.itemId}`,sku:'Discovery Clamp'});
    assert.match(productSuggestions[0],/stock|inventory|reorder/i);
    const hinted=await agent.get(`/ask?from=${encodeURIComponent(`/inventory/${item.itemId}`)}`+
      `&q=${encodeURIComponent(productSuggestions[0])}`);
    assert.match(hinted.text,new RegExp(`<textarea[^>]*>${productSuggestions[0].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}</textarea>`));
    assert.match(hinted.text,/name="sourcePath" value="\/inventory\//);
    const followup=await agent.get('/ask');
    assert.match(followup.text,/name="sourcePath" value="\/inventory\//,
      'verified page context should survive a follow-up in the same conversation');
    const other=await auth.createBusiness(database,{businessName:'Other Discovery Business',
      name:'Other Owner',email:'other-discovery@example.test',password:'isolated-password'});
    const privateItem=await catalog.createItem(database,{workspaceId:other.workspaceId,actorId:other.userId},
      {name:'Private Clamp',trackingMode:'quantity'});
    const forged=await agent.get(`/ask?from=${encodeURIComponent(`/inventory/${privateItem.itemId}`)}`);
    assert.equal(forged.status,200);
    assert.doesNotMatch(forged.text,/name="sourcePath" value="\/inventory\//,
      'a record in another workspace must not become Ask page context');
    await database.query('UPDATE users SET role=$2,permissions=$3 WHERE id=$1',
      [ctx.actorId,'staff',JSON.stringify(['VIEW'])]);
    const restricted=await discovery.available(database,ctx);
    assert.ok(restricted.every((entry)=>entry.kind==='read'||entry.kind==='navigation'));
    assert.ok(!restricted.some((entry)=>entry.name==='read.payables'||entry.name==='navigate.connections'));
  });

test('Ask explains only verified registered capabilities and never changes business data',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-discovery-answer'});
    await migratePostgres(database);
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      assert.equal(input.schemaName,'stockchief_capability_plan');
      assert.match(input.system,/read.capabilities/);
      return {data:{steps:[{capability:'read.capabilities',arguments:[],dependsOn:[],continuesPending:false}],
        clarifyingQuestion:''},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'discovery-answer-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Discovery Answer',email:'discovery-answer@example.test',password:'password-for-testing'});
    const page=await agent.get('/ask');
    const response=await agent.post('/ask').type('form').send({_csrf:csrf(page.text),
      message:'I am new here. How can you help me run this business?',usageKey:'discovery-answer-1'});
    assert.equal(response.status,303);
    const rendered=await agent.get('/ask');
    assert.match(rendered.text,/I can help you/);
    assert.match(rendered.text,/stock receipt/i,
      'capability discovery should represent executable work, not only its first four reads');
    assert.match(rendered.text,/no products yet; I can help add your first one/);
    assert.doesNotMatch(rendered.text,/create carrier labels|initiate bank transfers/i);
    const proposals=(await database.query('SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals')).rows[0];
    assert.equal(proposals.total,0);
  });

test('unavailable effects offer only a different registered and permitted alternative',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-discovery-fallback'});
    await migratePostgres(database);
    const provider={name:'anthropic',model:PRICED_MODEL,async complete(input){
      assert.equal(input.schemaName,'stockchief_capability_plan');
      return {data:{steps:[],clarifyingQuestion:'',closestAlternative:'supplier_payment.record'},usage:pricedUsage()};
    }};
    const app=createPostgresApp({database,env:'test',sessionSecret:'discovery-fallback-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Owner',
      businessName:'Fallback Business',email:'fallback@example.test',password:'password-for-testing'});
    const page=await agent.get('/ask');
    await agent.post('/ask').type('form').send({_csrf:csrf(page.text),
      message:'Send a bank transfer to my supplier now',usageKey:'fallback-1'});
    const rendered=await agent.get('/ask');
    assert.match(rendered.text,/I cannot complete that exact request here/);
    assert.match(rendered.text,/record a supplier payment already made/i);
    assert.match(rendered.text,/different result/);
    const proposals=(await database.query('SELECT COUNT(*)::int AS total FROM stockchief_runtime.assistant_action_proposals')).rows[0];
    assert.equal(proposals.total,0);
  });
