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

function csrf(html){const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];if(!value)throw new Error('Missing CSRF');return value;}

test('Ask routes broad questions through supported evidence and general knowledge without fake business claims',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-ask-evidence'});
    await migratePostgres(database);
    const observed=[];
    const provider=fixture({name:'evidence-fixture',model:'fixture',async complete(input){
      if(input.schemaName==='stockchief_postgres_request'){
        const question=JSON.parse(input.prompt).message;
        const view=question.includes('FIFO')?'general_knowledge':question.includes('reorder')?'replenishment':'business_analysis';
        return {data:{intent:'lookup',view,search:null},usage:{}};
      }
      observed.push({schema:input.schemaName,prompt:JSON.parse(input.prompt)});
      if(input.schemaName==='stockchief_postgres_general_answer'){
        return {data:{answer:'FIFO means first in, first out. This is general information, not a reading of your inventory.',
          supported:true,evidenceKeys:[]},usage:{}};
      }
      const evidence=JSON.parse(input.prompt).evidence;
      assert.equal(evidence.inventory,undefined);
      assert.equal(evidence.customerOrders.currentCount,1);
      assert.equal(evidence.customerOrders.priorComparableCount,2);
      if(JSON.parse(input.prompt).question.includes('caused'))return {data:{answer:'The recorded order count changed, but these records do not establish what caused it.',
        supported:false,evidenceKeys:['customerOrders']},usage:{}};
      return {data:{answer:'One customer order is recorded this month versus two in the comparable period last month. The cause of the decline is not established by these counts.',
        supported:true,evidenceKeys:['customerOrders']},usage:{}};
    }});
    const app=createPostgresApp({database,env:'test',sessionSecret:'ask-evidence-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);
    const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrf(registration.text),name:'New Owner',
      businessName:'New Business',email:'evidence-owner@example.test',password:'evidence-password'});
    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id WHERE w.name='New Business'`)).rows[0];
    const customer=await commerce.createCustomer(database,{workspaceId:owner.workspace_id,actorId:owner.actor_id},
      {name:'Sample Buyer'});
    const now=new Date(),current=`${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-02`;
    const priorDate=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,2));
    const prior=priorDate.toISOString().slice(0,10);
    for(const [index,date] of [current,prior,prior].entries()){
      const at=nowIso();
      await database.query(`INSERT INTO sales_orders
        (id,workspace_id,customer_id,order_number,order_date,delivery_method,ship_to_address,status,
         created_by_user_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'SHIP','1 Sample Road','CONFIRMED',$6,$7,$7)`,
      [newId('so'),owner.workspace_id,customer.id,`SO-EVIDENCE-${index}`,date,owner.actor_id,at]);
    }
    const ask=async(message)=>{
      const page=await agent.get('/ask');
      const sent=await agent.post('/ask').type('form').send({_csrf:csrf(page.text),message});
      assert.equal(sent.status,303);
      return (await agent.get('/ask')).text;
    };
    const analysis=await ask('Why are sales down this month?');
    assert.match(analysis,/cause of the decline is not established/);
    assert.match(analysis,/Customer orders/);
    const uncertain=await ask('What caused orders to fall?');
    assert.match(uncertain,/Could not verify from these records/);
    assert.doesNotMatch(uncertain,/Reply below to continue this question/);
    const general=await ask('What does FIFO mean?');
    assert.match(general,/FIFO means first in, first out/);
    assert.match(general,/General knowledge/);
    assert.equal(observed.find((entry)=>entry.schema==='stockchief_postgres_general_answer').prompt.evidence,undefined);
    const reorder=await ask('What should I reorder?');
    assert.match(reorder,/has not run its first business check/);
  });
