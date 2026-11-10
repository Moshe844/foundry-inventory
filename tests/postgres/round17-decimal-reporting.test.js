'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('reported fractional-stock quantities work in Money, reports, stock overview and every Ask inventory read',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Decimal owner',businessName:'Decimal reporting qualification',email:'decimal-reporting@example.test',password:'Decimal-reporting-qualification!'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const ledger=require('../../src/accounting/postgres-ledger'),catalog=require('../../src/domain/postgres-catalog-service'),inventory=require('../../src/domain/postgres-inventory-engine'),costing=require('../../src/accounting/postgres-costing');
 await ledger.configure(db,ctx,{startDate:'2026-01-01',currency:'USD'});
 const location=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Stockroom',kind:'warehouse'});
 // Minimized copy of the reported quantities and book totals; no customer IDs,
 // contacts or financial documents are copied into the repository fixture.
 const coffee=await catalog.createItem(db,ctx,{name:'Coffee beans in kg',baseCode:'DECIMAL-KG',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'});
 await require('../../src/domain/postgres-opening-stock').receive(db,ctx,{skuId:coffee.skuIds[0],locationId:location.id,quantity:'2.5',unitCost:'8.00',idempotencyKey:'decimal:coffee-costed'});
 await inventory.receive(db,ctx,{skuId:coffee.skuIds[0],locationId:location.id,quantity:'1.25',idempotencyKey:'decimal:coffee-uncosted'});
 const quoted=await catalog.createItem(db,ctx,{name:'Other costed stock',baseCode:'DECIMAL-COSTED',trackingMode:'quantity'});
 await db.transaction(async c=>{const received=await inventory.receiveInTransaction(c,ctx,{skuId:quoted.skuIds[0],locationId:location.id,quantity:358,idempotencyKey:'decimal:other-costed'}),journal=await ledger.postInTransaction(c,ctx,{sourceKey:'decimal:opening-value',sourceType:'isolated_opening_fixture',postingDate:await require('../../src/lib/business-time').today(c,ctx.workspaceId),currency:'USD',description:'Copied stock value fixture',lines:[{accountKey:'INVENTORY_ASSET',debitMinor:1609900},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:1609900}]});await costing.receiveInTransaction(c,ctx,{movementId:received.movementId,totalCostMinor:1609900,journalEntryId:journal.entry.id,sourceType:'isolated_opening_fixture'});});
 const uncosted=await catalog.createItem(db,ctx,{name:'Other stock awaiting cost',baseCode:'DECIMAL-UNCOSTED',trackingMode:'quantity'});
 await inventory.receive(db,ctx,{skuId:uncosted.skuIds[0],locationId:location.id,quantity:22,idempotencyKey:'decimal:other-uncosted'});
 const copied=(await db.query('SELECT physical_units::text,costed_units::text,missing_units::text,book_cost_minor::text FROM inventory_cost_coverage_totals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 assert.deepEqual(copied,{physical_units:'383.75',costed_units:'360.5',missing_units:'23.25',book_cost_minor:'1611900'});
 const money=require('../../src/accounting/customer-money'),coverage=await money.inventoryCoverage(db,ctx.workspaceId);
 assert.equal(coverage.missingCostUnits,23.25);
 assert.equal(coverage.missingCostCounted,22);
 assert.deepEqual(coverage.missingCostMeasured,[{unit:'kg',quantity:1.25}]);
 const summary=await require('../../src/assistant/postgres-inventory-summary').context(db,ctx.workspaceId,{role:'owner'});
 assert.equal(summary.onHand,380);assert.deepEqual(summary.measured,[{unit:'kg',quantity:3.75}]);assert.equal(summary.complete,true);
 const assistant=require('../../src/assistant/postgres-service'),valuation=await assistant.lookup(db,ctx,{view:'inventory_valuation'});assert.equal(valuation.totals.physicalUnits,383.75);assert.equal(valuation.totals.costedUnits,360.5);assert.equal(valuation.totals.missingCostUnits,23.25);assert.equal(valuation.totals.inventoryBookCostMinor,1611900);
 const counted=await assistant.lookup(db,ctx,{view:'inventory_summary'});
 assert.match(counted.answer,/380 units on hand, plus 3\.75 kg/);
 const stock=await require('../../src/web/postgres-presenters').inventoryPosition(db,ctx.workspaceId);assert.equal(stock.stockValue.missingCostUnits,23.25);
 await t.test('Home aggregates ordinary stock once while retaining measured stock, empty SKUs and tenant scope',async()=>{
  await catalog.createItem(db,ctx,{name:'No stock yet',baseCode:'DECIMAL-EMPTY',trackingMode:'quantity'});
  const brief=await require('../../src/projections/postgres-service').brief(db,ctx.workspaceId,ctx.actorId);
  assert.equal(brief.stats.unitsOnHand,380,'Kilograms must not be added to the ordinary-unit count');assert.equal(brief.stats.hasMeasuredStock,true);assert.equal(brief.stats.skuCount,4);assert.equal(brief.stats.zeroCount,1);assert.equal(brief.stats.available,383.75);
  const other=await auth.createBusiness(db,{name:'Other Home owner',businessName:'Other Home tenant',email:'other-home@example.test',password:'Other-Home-tenant-fixture!'});
  const empty=await require('../../src/projections/postgres-service').brief(db,other.workspaceId,other.userId);assert.equal(empty.stats.itemCount,0);assert.equal(empty.stats.skuCount,0);assert.equal(empty.stats.unitsOnHand,0);assert.equal(empty.stats.zeroCount,0);assert.equal(empty.stats.available,0);
 });
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'round17-decimal-reporting'});t.after(()=>app.locals.sessionStore.close());
 const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:'decimal-reporting@example.test',password:'Decimal-reporting-qualification!'}).expect(302);
 for(const route of ['/','/money','/money/invoices','/money/bills','/money/profit','/reports','/inventory','/inventory/overview']){const page=await agent.get(route);assert.equal(page.status,200,route+': '+page.text.slice(0,300));assert.doesNotMatch(page.text,/exceeds the exact reporting range|INVENTORY_SUMMARY_PRECISION/);}
 assert.equal((await money.snapshot(db,ctx.workspaceId,{summary:true})).missingCostUnits,23.25);
 assert.equal((await money.snapshot(db,ctx.workspaceId,{summary:false})).missingCostUnits,23.25);
 // Each product's line names its own unit: kilograms are never "units".
 const valueReport=(await agent.get('/reports/business/stock-value')).text.replace(/<[^>]+>/g,' ');assert.match(valueReport,/1.25 kg need purchase costs/);assert.match(valueReport,/22 units need purchase costs/);assert.doesNotMatch(valueReport,/d.d+ units/);
 // Currency cents remain integer-only: supporting fractional stock does not
 // weaken financial precision or silently round a malformed money amount.
 assert.throws(()=>money.exact('1.25'),/exact reporting range/);
 // Simulate a damaged projection in this disposable database. The unaffected
 // positions stay visible, and every affected page names the excluded SKU.
 const tea=await catalog.createItem(db,ctx,{name:'Measured tea awaiting cost',baseCode:'DECIMAL-TEA',trackingMode:'quantity',unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'});
 await inventory.receive(db,ctx,{skuId:tea.skuIds[0],locationId:location.id,quantity:'0.5',idempotencyKey:'decimal:other-measured'});
 await db.query("UPDATE inventory_cost_coverage_positions SET physical_units='NaN'::numeric WHERE workspace_id=$1 AND sku_id=$2",[ctx.workspaceId,coffee.skuIds[0]]);
 await inventory.receive(db,ctx,{skuId:uncosted.skuIds[0],locationId:location.id,quantity:1,idempotencyKey:'decimal:invalidate-summary'});
 const partial=await money.snapshot(db,ctx.workspaceId,{summary:true});
 assert.equal(partial.missingCostUnits,23.5);assert.equal(partial.missingCostCounted,23);
 assert.deepEqual(partial.missingCostMeasured,[{unit:'kg',quantity:0.5}]);
 assert.equal(partial.quantityTotalsIncomplete,true);assert.equal(partial.excludedQuantityPositions,1);assert.equal(partial.quantityWarnings[0].sku,'DECIMAL-KG');
 for(const route of ['/money','/money/invoices','/money/bills','/money/profit','/reports','/inventory/overview']){const page=await agent.get(route);assert.equal(page.status,200,route);assert.match(page.text,/data-quantity-warning/);assert.match(page.text,/Coffee beans in kg/);assert.match(page.text,/excluded from this quantity total/);}
 const outsider=await require('../../src/accounting/postgres-quantity-coverage').read(db,'other-inventory');assert.deepEqual(outsider,{missingCostUnits:0,missingCostCounted:0,missingCostMeasured:[]});
});
