'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
const text=html=>html.replace(/<script[\s\S]*?<\/script>/g,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');

// Each box on Home opens exactly what it counts, and the page it opens says
// so in the same words and with the same number.
test('every Home box opens the records it counts, named and counted the same way',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 await catalog.createItem(db,ctx,{name:'Destination empty one',baseCode:'DEST-EMPTY-1',trackingMode:'quantity'});
 await catalog.createItem(db,ctx,{name:'Destination empty two',baseCode:'DEST-EMPTY-2',trackingMode:'quantity'});
 // One open order and one draft, so "open" is not "every order".
 const open=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'dest-open',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1000}]});
 await f.workflows.confirmSalesOrder(db,ctx,open.salesOrderId,{idempotencyKey:'dest-open-confirm'});
 await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',fulfillmentLocationId:f.location.id,idempotencyKey:'dest-draft',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1000}]});

 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
 const home=(await agent.get('/')).text;
 const boxes=Object.fromEntries([...home.matchAll(/<a class="sc-metric[^"]*"[^>]*href="([^"]+)"[^>]*><span>([^<]+)<[\s\S]*?<strong data-home-number="[a-z]+">([^<]+)</g)]
  .map(m=>[m[2].trim(),{href:m[1].replace(/&amp;/g,'&'),number:m[3].trim()}]));
 assert.deepEqual(Object.keys(boxes).sort(),['Open orders','Out of stock','Sales this month','Units on hand'],JSON.stringify(boxes));

 const out=await agent.get(boxes['Out of stock'].href);assert.equal(out.status,200);
 assert.match(out.text,/<h1>Out of stock<\/h1>/,'the page is named as Home names it');
 assert.match(text(out.text),new RegExp(boxes['Out of stock'].number+' SKUs? '),'it counts the same '+boxes['Out of stock'].number);
 assert.match(text(out.text),/Destination empty one/);assert.doesNotMatch(text(out.text),/Parcel item/,'stock that is on hand is not listed');
 assert.match(out.text,/<a href="\/inventory\/table"[^>]*>Show all stock<\/a>/);

 const orders=await agent.get(boxes['Open orders'].href);assert.equal(orders.status,200);
 assert.match(text(orders.text),new RegExp('Open orders · '+boxes['Open orders'].number+' '),'the list says it holds the open orders Home counted');
 assert.match(orders.text,/<a href="\/orders"[^>]*>Show all orders<\/a>/);

 assert.match(boxes['Sales this month'].href,/^\/money\/sources\/revenue\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}$/,'Sales opens the sales that make up this month');
 assert.equal((await agent.get(boxes['Sales this month'].href)).status,200);
 const units=await agent.get(boxes['Units on hand'].href);assert.equal(units.status,200);
 assert.match(boxes['Units on hand'].href,/sort=stock_desc/,'Units on hand opens the stock with the most on hand first');
});
