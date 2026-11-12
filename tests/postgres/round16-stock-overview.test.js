'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
test('overview counts missing cost per stock position and incoming links agree with the catalogue',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service'),presenters=require('../../src/web/postgres-presenters');
 // Reproduce a legacy physical-only write-off: its excess recorded-cost unit
 // must never cancel an unrelated product's missing purchase cost.
 await require('../../src/domain/postgres-inventory-engine').adjust(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,countedQuantity:3,reasonCode:'damaged',idempotencyKey:'overview-old-writeoff'});
 const empty=await catalog.createItem(db,ctx,{name:'Uncosted lotion',trackingMode:'quantity'});
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:empty.skuIds[0],locationId:f.location.id,quantity:17,reasonCode:'opening',idempotencyKey:'overview-no-cost'});
 const position=await presenters.inventoryPosition(db,ctx.workspaceId);assert.equal(position.stockValue.missingCostUnits,17);
 const money=await presenters.money(db,ctx.workspaceId,{},ctx.actorId);assert.equal(money.story.inventory.missingCostUnits,17);
 const coverage=await require('../../src/accounting/customer-money').inventoryCoverage(db,ctx.workspaceId);assert.equal(coverage.missingCostUnits,17);
 const po=await f.workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:f.location.id,idempotencyKey:'overview-incoming',lines:[{skuId:empty.skuIds[0],quantityUnits:4,unitCost:2}]});await f.workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'overview-approve'});await f.workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:'overview-place'});
 const incoming=await presenters.inventoryPosition(db,ctx.workspaceId),list=await catalog.listItems(db,ctx.workspaceId,{group:'incoming'});assert.equal(incoming.position.totals.incoming,4);assert.equal(list.totalCount,1);assert.equal(list.items[0].id,empty.itemId);assert.equal(list.items[0].onOrder,4);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'overview-costs'});f.cleanup(()=>app.locals.sessionStore.close());const agent=request.agent(app),csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];let page=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(page.text),email:f.email,password:f.password});page=await agent.get('/inventory/overview').expect(200);assert.match(page.text,/missing for <strong>17 units<\/strong>/);assert.match(page.text,/On the way<\/span>\s*<strong\b[^>]*>4 units<\/strong>/);page=await agent.get('/inventory/table?group=incoming').expect(200);assert.match(page.text,/Uncosted lotion/);
});
