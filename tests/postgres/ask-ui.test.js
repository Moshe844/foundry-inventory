'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');

function csrfFrom(html){
  const value=/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
  if(!value)throw new Error('No CSRF token in response');
  return value;
}

function fields(overrides={}){
  return {intent:'lookup',view:'inventory',action:null,search:null,sku:null,location:null,fromLocation:null,
    toLocation:null,quantity:null,countedQuantity:null,reason:null,reference:null,...overrides};
}

const provider={name:'fixture',model:'fixture',async complete(request){
  const message=JSON.parse(request.prompt).message;
  if(message.includes('how many'))return {data:fields({search:'Trail Shoe'}),usage:{}};
  if(message.includes('Receive seven'))return {data:fields({intent:'action',view:null,action:'receive',sku:'SHOE-BLACK-8',
    location:'Main Warehouse',quantity:7,reference:'ASK-RECEIPT'}),usage:{}};
  if(message.includes('Receive five'))return {data:fields({intent:'action',view:null,action:'receive',sku:'SHOE-BLACK-8',
    quantity:5}),usage:{}};
  if(message.includes('Move three'))return {data:fields({intent:'action',view:null,action:'transfer',sku:'SHOE-BLACK-8',
    fromLocation:'Main Warehouse',toLocation:'Overflow Store',quantity:3,reference:'ASK-TRANSFER'}),usage:{}};
  return {data:fields(),usage:{}};
}};

test('Ask StockChief grounds answers and executes only an approved PostgreSQL proposal',
  {timeout:120000},async(context)=>{
    const cluster=await startCluster();
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-postgres-ask-ui'});
    await migratePostgres(database);
    const app=createPostgresApp({database,env:'test',sessionSecret:'postgres-ask-secret',aiProvider:provider});
    context.after(async()=>{await app.locals.sessionStore.close();await database.close();cluster.stop();});
    const agent=request.agent(app);
    const registration=await agent.get('/register');
    await agent.post('/register').type('form').send({_csrf:csrfFrom(registration.text),name:'Ask Owner',
      businessName:'Ask Business',email:'ask-owner@example.test',password:'ask-password'});
    const locationPage=await agent.get('/locations');
    await agent.post('/locations').type('form').send({_csrf:csrfFrom(locationPage.text),name:'Main Warehouse',kind:'warehouse'});
    const secondLocationPage=await agent.get('/locations');
    await agent.post('/locations').type('form').send({_csrf:csrfFrom(secondLocationPage.text),name:'Overflow Store',kind:'store'});
    const newItem=await agent.get('/inventory/new');
    const item=await agent.post('/inventory').type('form').send({_csrf:csrfFrom(newItem.text),name:'Trail Shoe',baseCode:'SHOE',
      trackingMode:'quantity',hasVariants:'1','options[0][name]':'Colour','options[0][values]':'Black',
      'options[1][name]':'Size','options[1][values]':'8'});
    assert.equal(item.status,303);

    const askPage=await agent.get('/ask');
    assert.equal(askPage.status,200);
    const asked=await agent.post('/ask').type('form').send({_csrf:csrfFrom(askPage.text),message:'how many Trail Shoe do we have?'});
    assert.equal(asked.status,303);
    const answer=await agent.get('/ask');
    assert.match(answer.text,/1 SKU matched with 0 units on hand/);
    assert.match(answer.text,/SHOE-BLACK-8/);

    const prepared=await agent.post('/ask').type('form').send({_csrf:csrfFrom(answer.text),
      message:'Receive seven SHOE-BLACK-8 into Main Warehouse, reference ASK-RECEIPT'});
    assert.equal(prepared.status,303);
    const afterPrepared=await agent.get('/ask');
    assert.match(afterPrepared.text,/Nothing has changed yet/);
    const proposalHref=/href="(\/actions\/pgprop_[a-z0-9]+)"/.exec(afterPrepared.text)?.[1];
    assert.ok(proposalHref);
    const before=(await database.query('SELECT COUNT(*) AS count FROM movements')).rows[0].count;
    assert.equal(before,'0');
    const review=await agent.get(proposalHref);
    assert.match(review.text,/Receive 7 × Trail Shoe/);
    const approved=await agent.post(`${proposalHref}/approve`).type('form').send({_csrf:csrfFrom(review.text)});
    assert.equal(approved.status,303);
    const completed=await agent.get(proposalHref);
    assert.match(completed.text,/EXECUTED/);
    assert.match(completed.text,/retries will not perform it twice/);
    const secondApproval=await agent.post(`${proposalHref}/approve`).type('form').send({_csrf:csrfFrom(completed.text)});
    assert.equal(secondApproval.status,303);
    assert.equal((await database.query('SELECT COUNT(*) AS count FROM movements')).rows[0].count,'1');
    assert.equal((await database.query('SELECT on_hand FROM balances')).rows[0].on_hand,'7');

    const transferPrepared=await agent.post('/ask').type('form').send({_csrf:csrfFrom((await agent.get('/ask')).text),
      message:'Move three SHOE-BLACK-8 from Main Warehouse to Overflow Store'});
    assert.equal(transferPrepared.status,303);
    const transferAnswer=await agent.get('/ask');
    assert.match(transferAnswer.text,/Move 3 × Trail Shoe/);
    const transferProposalId=(await database.query(`SELECT id FROM stockchief_runtime.assistant_action_proposals
      WHERE action_type='inventory.transfer' ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
    const transferProposalHref=`/actions/${transferProposalId}`;
    const transferReview=await agent.get(transferProposalHref);
    assert.match(transferReview.text,/Move 3 × Trail Shoe/);
    await agent.post(`${transferProposalHref}/approve`).type('form').send({_csrf:csrfFrom(transferReview.text)});
    const approvedTransfer=await agent.get(transferProposalHref);
    assert.match(approvedTransfer.text,/Continue TR-\d+ in the warehouse/);
    assert.equal((await database.query(`SELECT status FROM inventory_transfers`)).rows[0].status,'APPROVED');
    assert.equal((await database.query(`SELECT on_hand FROM balances`)).rows[0].on_hand,'7');

    const missing=await agent.post('/ask').type('form').send({_csrf:csrfFrom((await agent.get('/ask')).text),
      message:'Receive five SHOE-BLACK-8'});
    assert.equal(missing.status,303);
    const clarification=await agent.get('/ask');
    assert.match(clarification.text,/Which location is this for/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.assistant_action_proposals`)).rows[0].count,'2');

    const told=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(clarification.text),
      message:'how many Trail Shoe do we have?'});
    assert.equal(told.status,303);assert.equal(told.headers.location,'/ask#latest');
    const groundedAfterTransfer=(await agent.get('/ask')).text;
    assert.match(groundedAfterTransfer,/1 SKU matched with 7 units on hand/);
    assert.match(groundedAfterTransfer,/3 incoming/);
    const left=await agent.post('/ask/leave-the-rest').type('form').send({_csrf:csrfFrom((await agent.get('/ask')).text),back:'/'});
    assert.equal(left.status,303);assert.equal(left.headers.location,'/');
  });
