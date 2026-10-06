'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createPostgresApp}=require('../../src/postgres-app');
const {fixture}=require('../helpers/postgres-model-fixture');
const commerce=require('../../src/operations/postgres-commerce');
const {newId,nowIso}=require('../../src/lib/util');

function csrf(html){return /name="_csrf" value="([^"]+)"/.exec(html)?.[1];}

test('Ask distinguishes recorded sales totals from filtered customer-order lists',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-sales-semantics'});
    await migratePostgres(database);
    const model=fixture({async complete(input){
      const message=JSON.parse(input.prompt).message;
      if(message==='Show me orders from Acme')return {data:{intent:'lookup',view:'sales_orders',search:'Acme'}};
      if(message==='List customer orders')return {data:{intent:'lookup',view:'sales_orders',search:null}};
      if(message==='Compare orders for Acme')return {data:{intent:'lookup',view:'business_analysis',search:'Acme'}};
      return {data:{intent:'lookup',view:'sales_activity',search:null}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-sales-semantics-secret',aiProvider:model});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);
    const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'Sales Owner',
      businessName:'Sales Test',email:'sales-semantics@example.test',password:'sales-semantics-password'});
    const identity=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='Sales Test'`)).rows[0];
    const ask=async(message)=>{
      const page=await agent.get('/ask');
      const sent=await agent.post('/ask').type('form').send({_csrf:csrf(page.text),message});
      assert.equal(sent.status,303);
      return (await agent.get('/ask')).text;
    };
    const empty=await ask('Have I sold anything yet?');
    assert.match(empty,/don&#39;t see any customer orders or posted sales revenue recorded in StockChief so far/);
    assert.doesNotMatch(empty,/No customer order matched that request/);
    const emptyList=await ask('List customer orders');
    assert.match(emptyList,/No customer orders are recorded in StockChief/);

    const acme=await commerce.createCustomer(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {name:'Acme'});
    const other=await commerce.createCustomer(database,{workspaceId:identity.workspace_id,actorId:identity.actor_id},
      {name:'Other Buyer'});
    const now=new Date();
    const current=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-02`;
    const previous=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,2)).toISOString().slice(0,10);
    for(const [index,customer,date] of [[0,acme,current],[1,other,previous]]){
      const at=nowIso();
      await database.query(`INSERT INTO sales_orders
        (id,workspace_id,customer_id,order_number,order_date,delivery_method,ship_to_address,status,
         created_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'SHIP','1 Test Road','CONFIRMED',$6,$7,$7)`,
      [newId('so'),identity.workspace_id,customer.id,`SO-SALES-${index}`,date,identity.actor_id,at]);
    }
    const allTime=await ask('Did we make any sales?');
    assert.match(allTime,/2 customer orders so far/);
    const stillAllTime=await ask('Have I sold anything yet?');
    assert.match(stillAllTime,/2 customer orders so far/);
    const month=await ask('What have we sold this month?');
    assert.match(month,/1 customer order this month/);
    const unsupportedPeriod=await ask('Have I sold anything last week?');
    assert.match(unsupportedPeriod,/cannot verify that time period from this summary/);
    const filtered=await ask('Show me orders from Acme');
    assert.match(filtered,/SO-SALES-0/);
    assert.doesNotMatch(filtered,/SO-SALES-1/);
    const invalid=await ask('Compare orders for Acme');
    assert.match(invalid,/cannot apply a named record filter to a business-wide summary/);
  });
