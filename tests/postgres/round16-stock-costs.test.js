'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('item receipts and positive counts retain exact purchase cost; damaged stock reduces value',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Lotion',trackingMode:'quantity',purchaseCost:'40',sellingPrice:'100',currency:'USD'}),skuId=item.skuIds[0];
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'round16-costs'});f.cleanup(()=>app.locals.sessionStore.close());const agent=request.agent(app);
 let page=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(page.text),email:f.email,password:f.password});
 const stock=async()=>(await db.query('SELECT b.on_hand,c.quantity_units,c.total_cost_minor FROM balances b LEFT JOIN accounting_inventory_cost_balances c USING(workspace_id,sku_id,location_id) WHERE b.workspace_id=$1 AND b.sku_id=$2',[ctx.workspaceId,skuId])).rows[0];
 page=await agent.get('/inventory/'+item.itemId);assert.match(page.text,/name="unitCost"/);
 const input={_csrf:csrf(page.text),skuId,locationId:f.location.id,quantity:'10',idempotencyKey:'round16-receive'};
 await agent.post('/inventory/'+item.itemId+'/receive').type('form').send(input).expect(303);
 assert.deepEqual(await stock(),{on_hand:'10',quantity_units:'10',total_cost_minor:'40000'});
 await agent.post('/inventory/'+item.itemId+'/receive').type('form').send(input).expect(303);assert.equal(Number((await stock()).on_hand),10);
 const count={_csrf:csrf(page.text),skuId,locationId:f.location.id,countedQty:'11',unitCost:'40',reasonCode:'found',idempotencyKey:'round16-count'};
 for(const invalid of ['-3','abc']){const refused=await agent.post('/inventory/'+item.itemId+'/adjust').set('Accept','application/json').type('form').send({...count,unitCost:invalid});assert.equal(refused.status,400);assert.equal(Number((await stock()).on_hand),10);}
 await agent.post('/inventory/'+item.itemId+'/adjust').type('form').send(count).expect(303);assert.deepEqual(await stock(),{on_hand:'11',quantity_units:'11',total_cost_minor:'44000'});
 await agent.post('/inventory/'+item.itemId+'/issue').type('form').send({_csrf:csrf(page.text),skuId,locationId:f.location.id,quantity:'1',reasonCode:'damaged',idempotencyKey:'round16-damage'}).expect(303);
 assert.deepEqual(await stock(),{on_hand:'10',quantity_units:'10',total_cost_minor:'40000'});
 const pnl=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{from:'2026-01-01',to:'2026-12-31'});assert.equal(pnl.revenueMinor,0,'Receiving purchased stock does not create income');assert.equal(pnl.netIncomeMinor,0,'One found and one damaged unit offset; receipts are assets awaiting a bill');
 const sold=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'round16-sale',lines:[{skuId,quantity:2,unitPriceMinor:10000}]});await f.workflows.confirmSalesOrder(db,ctx,sold.salesOrderId,{idempotencyKey:'round16-confirm'});await f.workflows.fulfillSalesOrder(db,ctx,sold.salesOrderId,{idempotencyKey:'round16-fulfill',lines:[{lineId:sold.lineIds[0],quantity:2,locationId:f.location.id}]});
 assert.deepEqual(await stock(),{on_hand:'8',quantity_units:'8',total_cost_minor:'32000'});
 const after=await require('../../src/accounting/postgres-reports').profitAndLoss(db,ctx.workspaceId,{from:'2026-01-01',to:'2026-12-31'});assert.equal(after.revenueMinor,20000);assert.equal(after.netIncomeMinor,12000);
 const measured=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Weighed pieces',trackingMode:'quantity',unitLabel:'piece',secondaryUnitLabel:'kg',secondaryPrecision:3,purchaseCost:'10',currency:'USD'});
 await require('../../src/accounting/postgres-stock-receipt').receive(db,ctx,{skuId:measured.skuIds[0],locationId:f.location.id,quantity:2,secondaryQuantity:'5',idempotencyKey:'measured-receipt'});
 await require('../../src/accounting/postgres-physical-count').apply(db,ctx,{skuId:measured.skuIds[0],locationId:f.location.id,countedQuantity:3,secondaryCountedQuantity:'8',unitCost:'10',reasonCode:'found',idempotencyKey:'measured-count'});
 const weight=(await db.query('SELECT quantity_units,secondary_quantity_units,total_cost_minor FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,measured.skuIds[0]])).rows[0];assert.equal(Number(weight.quantity_units),3);assert.equal(Number(weight.secondary_quantity_units),8);assert.equal(Number(weight.total_cost_minor),8000,'Cost follows the added weight, rather than piece count');
});
