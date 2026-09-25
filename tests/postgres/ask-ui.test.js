'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { migratePostgres }=require('../../src/db/migrate-postgres');
const { createPostgresApp }=require('../../src/postgres-app');
const commerce=require('../../src/operations/postgres-commerce');

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
  if(message.includes('Trail Shoes received'))throw new Error('Exercise deterministic fallback');
  if(message.includes('and move 2'))throw new Error('Exercise deterministic multi-request fallback');
  if(message.includes('show me locations'))throw new Error('Exercise deterministic multi-lookup fallback');
  if(message.includes('available, and in which warehouse'))return {data:fields({view:'locations'}),usage:{}};
  if(message.includes('how many'))return {data:fields({search:'Trail Shoe'}),usage:{}};
  if(message==='Show payment history')return {data:fields({view:'payments'}),usage:{}};
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
    assert.match(answer.text,/This conversation/);
    assert.match(answer.text,/Tell me what happened, ask me anything/);
    assert.doesNotMatch(answer.text,/Back to StockChief/);

    const wholeInventory=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(answer.text),
      message:'How many items are in my inventory currently?'});
    assert.equal(wholeInventory.status,303);
    const wholeInventoryAnswer=await agent.get('/ask');
    assert.match(wholeInventoryAnswer.text,/1 SKU matched with 0 units on hand/);
    assert.doesNotMatch(wholeInventoryAnswer.text,/No product or SKU matched/);

    const financial=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(wholeInventoryAnswer.text),
      message:'Did I lose any money yet?'});
    assert.equal(financial.status,303);
    const financialAnswer=await agent.get('/ask');
    assert.match(financialAnswer.text,/broken even so far this month/i);
    assert.match(financialAnswer.text,/Revenue is/);

    const owner=(await database.query(`SELECT w.id AS workspace_id,u.id AS actor_id FROM workspaces w
      JOIN users u ON u.workspace_id=w.id AND u.role='owner' WHERE w.name='Ask Business'`)).rows[0];
    const supplier=await commerce.createSupplier(database,{workspaceId:owner.workspace_id,actorId:owner.actor_id},
      {name:'Balance Supply',currency:'USD'});
    const customer=await commerce.createCustomer(database,{workspaceId:owner.workspace_id,actorId:owner.actor_id},
      {name:'Balance Buyer'});
    const at='2026-09-24T12:00:00.000Z';
    await database.query(`INSERT INTO accounting_supplier_bills
      (id,workspace_id,bill_number,supplier_id,issue_date,status,match_status,currency,subtotal_minor,total_minor,
       balance_minor,source_key,created_by_user_id,created_at,updated_at,opened_at)
      VALUES('ask-bill',$1,'BILL-ASK', $2,'2026-09-24','PARTIALLY_PAID','MATCHED','USD',8000,8000,5000,
        'ask-bill-source',$3,$4,$4,$4)`,[owner.workspace_id,supplier.id,owner.actor_id,at]);
    await database.query(`INSERT INTO accounting_customer_invoices
      (id,workspace_id,invoice_number,customer_id,issue_date,status,currency,subtotal_minor,total_minor,balance_minor,
       source_key,created_by_user_id,created_at,updated_at,opened_at)
      VALUES('ask-invoice',$1,'INV-ASK',$2,'2026-09-24','PARTIALLY_PAID','USD',12000,12000,7000,
        'ask-invoice-source',$3,$4,$4,$4)`,[owner.workspace_id,customer.id,owner.actor_id,at]);
    const balances=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(financialAnswer.text),
      message:'What do we currently owe suppliers, and what customer money is still outstanding?'});
    assert.equal(balances.status,303);
    const balanceAnswer=await agent.get('/ask');
    assert.match(balanceAnswer.text,/StockChief · part 1 of 2/);
    assert.match(balanceAnswer.text,/StockChief · part 2 of 2/);
    assert.match(balanceAnswer.text,/We currently owe suppliers \$50\.00 USD across 1 open supplier bill/);
    assert.match(balanceAnswer.text,/Customers currently owe us \$70\.00 USD across 1 open customer invoice/);
    assert.match(balanceAnswer.text,/INV-ASK/);
    assert.doesNotMatch(balanceAnswer.text,/No payment matched that request/);
    const balanceTurns=(await database.query(`SELECT intent->>'view' AS view,status FROM stockchief_runtime.assistant_interactions
      WHERE intent->>'sourceMessage'=$1 ORDER BY (intent->>'requestIndex')::integer`,
    ['What do we currently owe suppliers, and what customer money is still outstanding?'])).rows;
    assert.deepEqual(balanceTurns,[{view:'payables',status:'ANSWERED'},{view:'receivables',status:'ANSWERED'}]);
    const balanceEvidence=(await database.query(`SELECT evidence FROM stockchief_runtime.assistant_interactions
      WHERE intent->>'sourceMessage'=$1 ORDER BY (intent->>'requestIndex')::integer`,
    ['What do we currently owe suppliers, and what customer money is still outstanding?'])).rows;
    assert.equal(balanceEvidence[0].evidence[0].document,'BILL-ASK');
    assert.equal(balanceEvidence[1].evidence[0].document,'INV-ASK');
    for(const wording of ['Show AP and AR outstanding.','Any unpaid supplier bills and customer invoices?',
      'How much is due to vendors and due from customers?']){
      const page=await agent.get('/ask');
      await agent.post('/ask').type('form').send({_csrf:csrfFrom(page.text),message:wording});
      const routed=(await database.query(`SELECT intent->>'view' AS view FROM stockchief_runtime.assistant_interactions
        WHERE intent->>'sourceMessage'=$1 ORDER BY (intent->>'requestIndex')::integer`,[wording])).rows;
      assert.deepEqual(routed,[{view:'payables'},{view:'receivables'}]);
    }
    const paymentPage=await agent.get('/ask');
    await agent.post('/ask').type('form').send({_csrf:csrfFrom(paymentPage.text),message:'Show payment history'});
    const paymentTurn=(await database.query(`SELECT intent->>'view' AS view,answer FROM stockchief_runtime.assistant_interactions
      WHERE message='Show payment history' ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0];
    assert.equal(paymentTurn.view,'payments');assert.match(paymentTurn.answer,/No payment matched/);

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
    const multiLookup=await agent.post('/ask').type('form').send({_csrf:csrfFrom(groundedAfterTransfer),
      message:'How many items are in my inventory and show me locations'});
    assert.equal(multiLookup.status,303);
    const multiLookupAnswer=(await agent.get('/ask')).text;
    assert.match(multiLookupAnswer,/StockChief · part 1 of 2/);
    assert.match(multiLookupAnswer,/StockChief · part 2 of 2/);
    assert.match(multiLookupAnswer,/1 SKU matched with 7 units on hand/);
    assert.match(multiLookupAnswer,/2 active locations hold 7 units/);
    const multi=await agent.post('/ask').type('form').send({_csrf:csrfFrom(groundedAfterTransfer),
      message:'How many Trail Shoe do we have and move 2 SHOE-BLACK-8 from Main Warehouse to Overflow Store'});
    assert.equal(multi.status,303);
    const multiAnswer=(await agent.get('/ask')).text;
    assert.match(multiAnswer,/1 SKU matched with 7 units on hand/);
    assert.match(multiAnswer,/Move 2 × Trail Shoe[\s\S]*from Main Warehouse to Overflow Store/);
    const multiTurns=(await database.query(`SELECT message,intent,status FROM stockchief_runtime.assistant_interactions
      WHERE intent->>'sourceMessage'=$1 ORDER BY created_at,id`,
    ['How many Trail Shoe do we have and move 2 SHOE-BLACK-8 from Main Warehouse to Overflow Store'])).rows;
    assert.equal(multiTurns.length,2);assert.deepEqual(multiTurns.map((turn)=>turn.status),['ANSWERED','PREPARED']);
    assert.deepEqual(multiTurns.map((turn)=>Number(turn.intent.requestIndex)),[1,2]);
    const warehouseQuestion=await agent.post('/ask').type('form').send({_csrf:csrfFrom(groundedAfterTransfer),
      message:'How many Trail Shoes are available, and in which warehouse?'});
    assert.equal(warehouseQuestion.status,303);
    const latestWarehouseAnswer=(await database.query(`SELECT answer FROM stockchief_runtime.assistant_interactions
      ORDER BY created_at DESC,id DESC LIMIT 1`)).rows[0].answer;
    assert.match(latestWarehouseAnswer,/1 SKU matched with 7 units on hand, 0 committed, 7 available and 3 incoming/);
    assert.match(latestWarehouseAnswer,/Stock is in Main Warehouse/);
    const left=await agent.post('/ask/leave-the-rest').type('form').send({_csrf:csrfFrom((await agent.get('/ask')).text),back:'/'});
    assert.equal(left.status,303);assert.equal(left.headers.location,'/');

    const fallback=await agent.post('/ask').type('form').send({_csrf:csrfFrom((await agent.get('/ask')).text),
      message:'Record 5 Trail Shoes received into Main Warehouse with reference FALLBACK-RECEIPT.'});
    assert.equal(fallback.status,303);
    const fallbackAnswer=await agent.get('/ask');
    assert.match(fallbackAnswer.text,/Receive 5 × Trail Shoe.*into Main Warehouse/);
    assert.match(fallbackAnswer.text,/Nothing has changed yet/);
    assert.equal((await database.query(`SELECT COUNT(*) AS count FROM movements`)).rows[0].count,'1');
    const fallbackProposal=(await database.query(`SELECT payload FROM stockchief_runtime.assistant_action_proposals
      WHERE action_type='inventory.receive' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    assert.equal(fallbackProposal.payload.reference,'FALLBACK-RECEIPT');
  });
