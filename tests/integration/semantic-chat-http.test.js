'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {createApp}=require('../../src/app');
const {makeDatabase,seedWorkspace,makeQuantityItem,cleanupAll,signIn,csrfFrom,plain}=require('../helpers');
test.after(cleanupAll);
function read(){return {decision:'answer',interpretation:'Count the requested catalogue entries',clarification:'',parts:[{
 question:'How many catalogue products?',intent:'record_query',entityQuery:'',locationQuery:'',windowDays:30,limit:10,unsupportedReason:'',recordQuery:{
 dataset:'products',entityScope:'set',fields:[],filters:[{field:'active',operator:'eq',value:1}],filterMode:'all',aggregate:'count',measure:'',metrics:[],groupBy:[],sortField:'',sortDirection:'asc',limit:25,
 }}]};}
function setup(provider){const {db}=makeDatabase();const w=seedWorkspace(db);makeQuantityItem(db,w.ctx,{name:'Composite Bush',baseCode:'CB'});return {db,w,app:createApp({db,env:'test',sessionSecret:'semantic-chat-http',aiProvider:provider})};}
test('Ask composer continues a clarification with workspace-scoped context and no operational intake',async()=>{
 let calls=0;
 const provider={async complete(r){calls++;if(calls===1)return {data:{decision:'clarify',interpretation:'Clarify catalogue scope',clarification:'Do you mean products or individual SKUs?',parts:[]}};
  const prompt=JSON.parse(r.prompt);assert.equal(prompt.previous.question,'How many entries?');assert.match(prompt.previous.clarification,/products or individual SKUs/);assert.equal(prompt.question,'Products.');return {data:read()};}};
 const {app,w,db}=setup(provider);const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 const first=await agent.get('/ask').query({q:'How many entries?'});assert.equal(first.status,200);assert.match(plain(first.text),/Reply below to continue/);assert.match(first.text,/name="queryConversation" value="1"/);
 const before=db.prepare('SELECT COUNT(*) n FROM movements').get().n;
 const posted=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(first.text),queryConversation:'1',message:'Products.'});
 assert.equal(posted.status,303);assert.equal(calls,2,'one semantic interpretation at submission; no operational classifier');
 const result=await agent.get(posted.headers.location);assert.equal(result.status,200);assert.match(plain(result.text),/1 products match your question/);assert.match(plain(result.text),/You How many entries\? StockChief Do you mean products or individual SKUs\? You Products\./,'the earlier turn stays on the page as it was said');
  assert.equal(calls,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM movements').get().n,before);
 const refreshed=await agent.get(posted.headers.location);assert.equal(refreshed.status,200);
 assert.equal(calls,3,'refresh uses the same prior question, not its own answer');
});
test('multi-part evidence renders separately and a semantic action offers the real manager review',async()=>{
 let next=read();next.parts.push({...next.parts[0],question:'And quantities?',recordQuery:{...next.parts[0].recordQuery,aggregate:'sum',measure:'on_hand'}});
 const {app,w}=setup({complete:async()=>({data:next})});const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 const page=await agent.get('/ask').query({q:'How many products and how many units?'});
 assert.equal(page.status,200);assert.match(plain(page.text),/How many catalogue products\? 1 match/);assert.match(plain(page.text),/And quantities\? 1 match/);
 next={decision:'action',interpretation:'Prepare a supplier email',clarification:'This needs a reviewed supplier communication.',parts:[]};
 const action=await agent.get('/ask').query({q:'Send an order to a supplier'});assert.equal(action.status,200);
 assert.match(action.text,/action="\/foundry\/tell"/);assert.match(plain(action.text),/Nothing has changed/);
});
test('an interpreter failure leaves the original question editable rather than clearing it',async()=>{
 const {app,w}=setup({complete:async()=>{throw new Error('offline');}});const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 const question='Count current products by tracking method.';
 const page=await agent.get('/ask').query({q:question});assert.equal(page.status,200);
 assert.match(plain(page.text),/no figures were guessed/);
 assert.ok(page.text.includes(`>${question}</textarea>`));
});

test('a failed composer submission is shown once and does not automatically retry the paid interpretation',async()=>{
 let calls=0;const {app,w}=setup({complete:async()=>{calls++;throw new Error('offline');}});
 const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 const form=await agent.get('/ask');const message='Prepare a replenishment preview for my warehouse.';
 const posted=await agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(form.text),queryConversation:'1',message});
 assert.equal(posted.status,303);assert.equal(calls,1);
 const page=await agent.get(posted.headers.location);assert.equal(page.status,200);assert.equal(calls,1);
 assert.match(plain(page.text),/no figures were guessed/);assert.ok(page.text.includes(`>${message}</textarea>`));
});

test('action decisions without questions never display an analytics clarification',async()=>{
 const {app,w}=setup({complete:async()=>({data:{decision:'action',interpretation:'Prepare the requested business work',clarification:'',parts:[]}})});
 const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 for(const q of ['Prepare a purchase order','Raise a customer order','Move stock to another warehouse','Email a supplier']){
  const page=await agent.get('/ask').query({q});assert.equal(page.status,200);
  assert.doesNotMatch(plain(page.text),/Which records and measure/);
  assert.match(plain(page.text),/prepare it for review/);
 }
});

test('the same Ask submission reaches PO, sales and movement review without another action-routing click',async()=>{
 const auth=require('../../src/domain/auth-service');
 const suppliers=require('../../src/purchasing/supplier-service');
 const sales=require('../../src/sales/sales-order-service');
 const prices=require('../../src/pricing/price-service');
 let kind='purchase';
 const provider={async complete(r){
  if(r.schemaName==='stockchief_semantic_query')return {data:{decision:'action',interpretation:'Prepare the requested work',clarification:'',parts:[]}};
  if(r.schemaName==='sales_order_intent')return {data:{operation:'create',customerText:'Buyer Sigma',orderText:'',itemText:'Composite Bush',variantText:'',locationText:'',quantity:4,neededBy:'',reason:''}};
  if(r.schemaName==='inventory_action_intent')throw new Error('Fixture expects a grounded transaction grammar');
  return {data:{intentClass:kind==='sales'?'SALES_ORDER':'INVENTORY_ACTION',confidence:'high',reason:'Prepare the requested work',resolvedReference:'',clarifyingQuestion:''}};
 }};
 const {app,w,db}=setup(provider);const member=auth.getMembership(db,w.workspaceId,w.accountId);
 const sku=db.prepare('SELECT id FROM skus WHERE workspace_id=?').get(w.workspaceId).id;
 const supplier=suppliers.createSupplier(db,w.ctx,member,{name:'Vendor Lambda',email:'vendor@example.test'});
 suppliers.linkItem(db,w.ctx,member,{supplierId:supplier.id,skuId:sku,purchaseUnit:'unit',unitsPerPurchaseUnit:1,lastUnitCost:'2.00'});
 sales.createCustomer(db,w.ctx,{name:'Buyer Sigma'});prices.setPrice(db,w.ctx,{skuId:sku,amount:'5.00',currency:'USD'});
 const agent=request.agent(app);await signIn(agent,w.account.email,w.account.password);
 const page=await agent.get('/ask');
 const before=db.prepare('SELECT COUNT(*) n FROM movements').get().n;
 const post=message=>agent.post('/foundry/tell').type('form').send({_csrf:csrfFrom(page.text),queryConversation:'1',message});
 const po=await post('Order 4 Composite Bush from Vendor Lambda');assert.equal(po.status,303);assert.match(po.headers.location,/^\/purchasing\/orders\/po_/);
 assert.equal(db.prepare('SELECT status FROM purchase_orders WHERE workspace_id=?').get(w.workspaceId).status,'DRAFT');
 kind='sales';const so=await post('Create a sales order for Buyer Sigma for 4 Composite Bush');assert.equal(so.status,303);assert.match(so.headers.location,/^\/sales\/orders\//);
 assert.equal(db.prepare('SELECT status FROM sales_orders WHERE workspace_id=?').get(w.workspaceId).status,'DRAFT');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM sales_order_allocations').get().n,0);
 kind='movement';const move=await post(`Receive 3 Composite Bush into ${w.main.name}`);assert.equal(move.status,303);assert.match(move.headers.location,/^\/actions\//);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM movements').get().n,before,'no execution before review');
});
