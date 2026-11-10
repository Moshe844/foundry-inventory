'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];

// Every page and Ask give one on-hand total: whole units of counted products,
// with stock measured in kilograms (or metres, litres) named apart in its own
// unit, never added to the units.
test('Home, Stock, Ask and the business list give the same units on hand, with measured stock apart',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const catalog=require('../../src/domain/postgres-catalog-service'),engine=require('../../src/domain/postgres-inventory-engine');
 const pairs=await catalog.createItem(db,ctx,{name:'Totals test boots',baseCode:'TOTALS-BOOT',trackingMode:'quantity'});
 await engine.receive(db,ctx,{skuId:pairs.skuIds[0],locationId:f.location.id,quantity:'1234',idempotencyKey:'totals-boots'});
 const flour=await catalog.createItem(db,ctx,{name:'Totals test flour',baseCode:'TOTALS-KG',trackingMode:'quantity'});
 await require('../../src/domain/stock-quantity').save(db,ctx,flour.itemId,{unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'});
 await engine.receive(db,ctx,{skuId:flour.skuIds[0],locationId:f.location.id,quantity:'3.75',idempotencyKey:'totals-flour'});

 // What the stock positions themselves hold.
 const expected=(await db.query(`SELECT coalesce(sum(b.on_hand) FILTER(WHERE coalesce(i.quantity_precision,0)=0),0)::text units
   FROM balances b JOIN skus s ON s.workspace_id=b.workspace_id AND s.id=b.sku_id JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   WHERE b.workspace_id=$1`,[ctx.workspaceId])).rows[0];
 const units=Number(expected.units),kg=[{unit:'kg',quantity:3.75}];
 assert.ok(units>=1234&&Number.isInteger(units),'counted units are whole: '+units);

 const brief=await require('../../src/projections/postgres-service').brief(db,ctx.workspaceId,ctx.actorId,{includeLocationStock:true,includeAvailability:false});
 assert.equal(brief.stats.unitsOnHand,units,'Home');assert.deepEqual(brief.stats.measuredStock,kg);
 assert.equal(brief.locations.reduce((sum,l)=>sum+l.onHand,0),units,'Home locations add up to the same units');
 const position=await require('../../src/web/postgres-presenters').inventoryPosition(db,ctx.workspaceId);
 assert.equal(position.position.totals.onHand,units,'Stock overview');assert.deepEqual(position.position.totals.measured,kg);
 const summary=await require('../../src/assistant/postgres-inventory-summary').read(db,ctx.workspaceId);
 assert.equal(summary.onHand,units,'Ask stock summary');assert.deepEqual(summary.measured,kg);
 const account=(await db.query('SELECT account_id FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0].account_id;
 const listed=(await require('../../src/domain/postgres-auth-service').listWorkspacesForAccount(db,account)).find(w=>w.id===ctx.workspaceId);
 assert.equal(Number(listed.units_on_hand),units,'business list');

 // The pages say the same thing, with thousands separators and the kilograms named.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
 const shown=units.toLocaleString('en-US');
 const home=(await agent.get('/')).text,overview=(await agent.get('/inventory/overview')).text,list=(await agent.get('/inventories')).text;
 assert.match(home,new RegExp(shown.replace(/,/g,',')),'Home shows '+shown);assert.match(home,/plus 3\.75 kg/);
 assert.match(overview,new RegExp(shown+' units'),'Stock overview shows '+shown+' units');assert.match(overview,/plus 3\.75 kg/);
 assert.doesNotMatch(overview,new RegExp((units+3.75).toLocaleString('en-US')),'kilograms are never added to the units');
 assert.match(list,new RegExp(shown+'(</strong>)? (units )?on hand|'+shown+' units'),'the business list shows '+shown+' on hand');

 // Stock still without a cost splits the same way: whole units, measured stock apart.
 const coverage=await require('../../src/accounting/postgres-quantity-coverage').read(db,ctx.workspaceId);
 const measuredMissing=(coverage.missingCostMeasured||[]).reduce((sum,m)=>sum+m.quantity,0);
 assert.ok(Number.isInteger(coverage.missingCostCounted),'missing-cost units are whole: '+JSON.stringify(coverage));
 assert.equal(coverage.missingCostUnits,coverage.missingCostCounted+measuredMissing,'the any-missing total still covers both');
 assert.ok((coverage.missingCostMeasured||[]).every(m=>m.unit==='kg'));
 assert.ok(measuredMissing>0&&coverage.missingCostCounted>0,'the uncosted boots and flour are both counted, apart: '+JSON.stringify(coverage));
 assert.match(overview,new RegExp(coverage.missingCostCounted.toLocaleString('en-US')+' units and '+measuredMissing+' kg still need a cost'),'the Stock overview names both');
 for(const [name,page] of [['Home',home],['Stock overview',overview]])
  assert.doesNotMatch(page.replace(/<[^>]+>/g,' '),/\d\.\d+ units?\b/,name+' never shows a fraction of a unit');

});
