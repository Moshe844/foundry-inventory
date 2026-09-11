'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {createApp}=require('../../src/app');
const inventory=require('../../src/domain/inventory-engine');
const locations=require('../../src/domain/location-service');
const prices=require('../../src/pricing/price-service');
const sales=require('../../src/sales/sales-order-service');
const {makeDatabase,cleanupAll,seedWorkspace,makeQuantityItem,signIn,csrfFrom,plain}=require('../helpers');

test.after(cleanupAll);

function fixture(){
  const store=makeDatabase();const workspace=seedWorkspace(store.db,{workspaceName:'Mission 8 browser'});
  locations.updateLocation(store.db,workspace.ctx,workspace.main.id,{name:workspace.main.name,kind:workspace.main.kind,barcode:'M8-MAIN'});
  const item=makeQuantityItem(store.db,workspace.ctx,{name:'Browser count shoe',baseCode:'BROWSER-M8'});
  prices.setPrice(store.db,workspace.ctx,{skuId:item.skuId,amount:'30.00',currency:'USD'});
  inventory.receive(store.db,workspace.ctx,{skuId:item.skuId,locationId:workspace.main.id,quantity:10});
  const app=createApp({db:store.db,env:'test',sessionSecret:'mission8-http'});
  return {...store,workspace,item,app};
}

test('owner completes a blind count and recount through the real browser contract',async()=>{
  const f=fixture(),agent=request.agent(f.app);await signIn(agent,f.workspace.account.email);
  let page=await agent.get('/warehouse/operations');
  assert.equal(page.status,200);assert.match(plain(page.text),/Count it, return it, or fulfill it/);
  assert.match(plain(page.text),/Schedule a recurring count/);
  const created=await agent.post('/warehouse/counts').type('form').send({_csrf:csrfFrom(page.text),countKind:'CYCLE',
    locationId:f.workspace.main.id,skuId:f.item.skuId,blindCount:'1',name:'Browser blind count'});
  assert.equal(created.status,303);assert.match(created.headers.location,/^\/warehouse\/counts\/cnts_/);
  page=await agent.get(created.headers.location);assert.match(plain(page.text),/system quantities hidden until submission/);
  assert.doesNotMatch(plain(page.text),/10 recorded/);
  const line=f.db.prepare('SELECT id FROM inventory_count_lines WHERE session_id=?').get(created.headers.location.split('/').at(-1));
  await agent.post(`${created.headers.location}/lines/${line.id}`).type('form').send({_csrf:csrfFrom(page.text),quantity:9});
  page=await agent.get(created.headers.location);
  const submitted=await agent.post(`${created.headers.location}/submit`).type('form').send({_csrf:csrfFrom(page.text)});
  page=await agent.get(submitted.headers.location);assert.match(plain(page.text),/RECOUNT REQUIRED/);
  const recount=await agent.post(`${created.headers.location}/recount`).type('form').send({_csrf:csrfFrom(page.text)});
  assert.match(recount.headers.location,/^\/warehouse\/counts\/cnts_/);
});

test('customer return and fulfillment wave pages are actionable rather than dead summaries',async()=>{
  const f=fixture(),agent=request.agent(f.app);await signIn(agent,f.workspace.account.email);
  let shipped=sales.createOrder(f.db,f.workspace.ctx,{customerName:'Returned Browser Customer',fulfillmentLocationId:f.workspace.main.id,
    lines:[{skuId:f.item.skuId,quantity:2}]});shipped=sales.confirm(f.db,f.workspace.ctx,shipped.id);
  sales.fulfill(f.db,f.workspace.ctx,shipped.id,{}, {idempotencyKey:'m8-browser-fulfilled'});
  let ready=sales.createOrder(f.db,f.workspace.ctx,{customerName:'Wave Browser Customer',fulfillmentLocationId:f.workspace.main.id,
    lines:[{skuId:f.item.skuId,quantity:2}]});ready=sales.confirm(f.db,f.workspace.ctx,ready.id);
  const quarantine=locations.createLocation(f.db,f.workspace.ctx,{name:'Browser quarantine',kind:'zone',barcode:'M8-QUAR'});
  let page=await agent.get('/warehouse/operations');
  const rma=await agent.post('/warehouse/returns/customer').type('form').send({_csrf:csrfFrom(page.text),salesOrderId:shipped.id,
    salesOrderLineId:shipped.lines[0].id,quantity:1,quarantineLocationId:quarantine.id,resolution:'NO_REFUND',reason:'Wrong size'});
  assert.equal(rma.status,303);page=await agent.get(rma.headers.location);assert.match(plain(page.text),/Authorize return/);
  const wave=await agent.post('/warehouse/waves').type('form').send({_csrf:csrfFrom(page.text),strategy:'WAVE',orderIds:ready.id,title:'Browser wave'});
  assert.equal(wave.status,303);page=await agent.get(wave.headers.location);assert.match(plain(page.text),/Location scan/);
  assert.match(plain(page.text),/Report a shortage/);assert.match(plain(page.text),/Packing does not move stock/);
});

