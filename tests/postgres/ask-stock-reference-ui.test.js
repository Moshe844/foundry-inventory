'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {fixture}=require('../helpers/postgres-model-fixture');
const catalog=require('../../src/domain/postgres-catalog-service');
const locations=require('../../src/domain/postgres-location-service');
const inventory=require('../../src/domain/postgres-inventory-engine');
const commerce=require('../../src/operations/postgres-commerce');
const {newId,nowIso}=require('../../src/lib/util');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];}

test('Ask resolves the only stocked SKU and prepares unpriced or priced purchase drafts without changing stock',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-stock-reference'});
    await migratePostgres(database);
    const model=fixture({async complete(input){
      const prompt=JSON.parse(input.prompt);
      if(prompt.message==='How many products are in inventory?')return {data:{intent:'lookup',view:'inventory_summary'}};
      if(prompt.message==='$8 per unit')return {data:{intent:'action',view:null,
        action:'create_purchase_order',amount:8,continuesPrevious:true}};
      return {data:{intent:'action',view:null,action:'create_purchase_order',sku:null,skuReference:'stocked',quantity:20}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-stock-reference-secret',aiProvider:model});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Stock Owner',
      businessName:'Stock Reference Test',email:'stock-reference@example.test',password:'stock-reference-password'});
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Stock Reference Test'`)).rows[0];
    const ctx={workspaceId:identity.workspace_id,actorId:identity.actor_id};
    const ask=async(message)=>{
      const page=await agent.get('/ask');
      assert.equal(page.status,200,`Ask page redirect: ${page.headers.location}`);
      const sent=await agent.post('/ask').set('Accept','application/json').type('form').send({_csrf:csrf(page.text),message});
      assert.equal(sent.status,303,`Ask response: ${JSON.stringify(sent.body)}; csrf=${csrf(page.text)}`);
      if(sent.headers.location!=='/ask#latest')assert.fail(`Ask response ${sent.status}: ${JSON.stringify(sent.body)}`);
      const latest=(await database.query(`SELECT * FROM stockchief_runtime.assistant_interactions
        WHERE workspace_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
      return {latest,html:(await agent.get('/ask')).text};
    };
    const location=await locations.createLocation(database,ctx,{name:'Main Warehouse',kind:'warehouse'});
    const item=await catalog.createItem(database,ctx,{name:'Safety Shoe',baseCode:'SHOE',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:item.skuIds[0],locationId:location.id,quantity:4,
      reference:'OPENING',idempotencyKey:'stock-reference-opening'});
    const supplier=await commerce.createSupplier(database,ctx,{name:'Safe Supply',currency:'USD'});

    let result=await ask('whatever i have in stock i need 20 more');
    assert.equal(result.latest.status,'PREPARED');
    assert.match(result.latest.answer,/Supplier cost is not recorded; the draft cannot be placed until it is priced/);
    assert.doesNotMatch(result.html,/What product or SKU do you need 20 more of/);
    assert.equal(result.latest.intent.supplier,'Safe Supply');
    assert.equal(result.latest.intent.quantity,20);
    assert.equal(result.latest.intent.sku,'SHOE');
    assert.equal(result.latest.intent.presentation.awaitingField,null);

    result=await ask('$8 per unit');
    assert.equal(result.latest.status,'PREPARED');
    assert.match(result.latest.answer,/Prepare a draft purchase order to Safe Supply: 20 × Safety Shoe/);
    assert.match(result.latest.answer,/Main Warehouse/);
    assert.match(result.latest.answer,/Nothing has changed yet/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM purchase_orders WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].count,'0');
    assert.equal((await database.query(`SELECT SUM(on_hand) AS units FROM balances WHERE workspace_id=$1`,
      [ctx.workspaceId])).rows[0].units,'4');

    const at=nowIso();
    await database.query(`INSERT INTO supplier_items
      (id,workspace_id,supplier_id,sku_id,purchase_unit,units_per_purchase_unit,last_unit_cost,
       is_preferred,is_active,created_at,updated_at)
      VALUES($1,$2,$3,$4,'unit',1,8,1,1,$5,$5)`,
    [newId('supplier-item'),ctx.workspaceId,supplier.id,item.skuIds[0],at]);
    let fresh=await agent.get('/ask');
    let restarted=await agent.post('/ask/new').type('form').send({_csrf:csrf(fresh.text)});
    assert.equal(restarted.headers.location,'/ask');
    fresh=await agent.get('/ask');
    assert.doesNotMatch(fresh.text,/Earlier in this conversation/);
    assert.doesNotMatch(fresh.text,/Safe Supply: 20 × Safety Shoe/);
    assert.match(fresh.text,/What can I help you run\?/);
    result=await ask('whatever i have in stock i need 20 more');
    assert.equal(result.latest.status,'PREPARED');
    assert.match(result.latest.answer,/Safe Supply: 20 × Safety Shoe/);

    const next=await catalog.createItem(database,ctx,{name:'Work Glove',baseCode:'GLOVE',trackingMode:'quantity'});
    await inventory.receive(database,ctx,{skuId:next.skuIds[0],locationId:location.id,quantity:3,
      reference:'OPENING-GLOVE',idempotencyKey:'stock-reference-glove'});
    fresh=await agent.get('/ask');
    restarted=await agent.post('/ask/new').type('form').send({_csrf:csrf(fresh.text)});
    assert.equal(restarted.status,303);
    assert.equal(restarted.headers.location,'/ask');
    fresh=await agent.get('/ask');
    assert.doesNotMatch(fresh.text,/Earlier in this conversation/);
    assert.doesNotMatch(fresh.text,/Safe Supply: 20 × Safety Shoe/);
    result=await ask('whatever i have in stock i need 20 more');
    assert.equal(result.latest.status,'CLARIFY');
    assert.match(result.latest.answer,/more than one product currently in stock/);
    assert.equal(result.latest.intent.presentation.choices.length,2);
    const proposals=(await database.query(`SELECT status,summary FROM stockchief_runtime.assistant_action_proposals
      WHERE workspace_id=$1 ORDER BY created_at,id`,[ctx.workspaceId])).rows;
    assert.deepEqual(proposals.map((row)=>row.status),['CANCELLED','PENDING','PENDING']);

    result=await ask('How many products are in inventory?');
    assert.equal(result.latest.status,'ANSWERED',JSON.stringify({intent:result.latest.intent,answer:result.latest.answer}));
    assert.equal(result.latest.intent.view,'inventory_summary');
  });
