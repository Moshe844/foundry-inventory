'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('returning from a pricing review restores every order line, contact, discount and reference',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'round16-order-draft'});f.cleanup(()=>app.locals.sessionStore.close());
 const agent=request.agent(app),login=await agent.get('/login');await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password}).expect(302);
 const page=await agent.get('/orders/new'),form={_csrf:csrf(page.text),customerId:'fixture-customer',customerEmail:'specific@example.test',customerPhone:'1234567890',customerShippingAddress:'Specific address',deliveryMethod:'SHIP',fulfillmentLocationId:f.location.id,skuId:Array(40).fill(f.item.skuIds[0]),quantity:Array.from({length:40},(_,i)=>String(i+1)),unitPrice:Array(40).fill('12.34'),priceOverride:Array(40).fill('1'),discount:'2.50',tax:'1.25',orderDate:'2026-11-01',neededBy:'2026-11-15',reference:'Forty lines & special reference',notes:'Keep these notes',emailManual:'1',phoneManual:'1',addressManual:'1',nextStep:'draft',idempotencyKey:'review-preserves-forty-lines'};
 const review=await agent.post('/sales/orders').type('form').send(form);assert.equal(review.status,200);assert.match(review.text,/Review order pricing/);
 const href=/href="(\/orders\/new\?review=[^"]+)"/.exec(review.text)?.[1];assert(href,'Review links to the stored draft');
 const restored=await agent.get(href);assert.equal(restored.status,200);
 // Values are server-rendered; no browser cache is involved.
 assert.equal((restored.text.split('<template id="order-line-template">')[0].match(/name="skuId"/g)||[]).length,40);
 for(const value of ['specific@example.test','1234567890','Specific address','2.50','1.25','2026-11-15','Forty lines &amp; special reference','Keep these notes'])assert(restored.text.includes(value),value);
 assert(restored.text.includes('value="40"'));assert(restored.text.includes('value="12.34"'));
 assert.equal(Number((await db.query('SELECT count(*) n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0,'Returning to edit must not create an order');
 const oldApproval=/action="(\/sales\/pricing\/order-reviews\/[^/]+\/approve)"/.exec(review.text)?.[1];assert(oldApproval);const stale=await agent.post(oldApproval).set('Accept','application/json').type('form').send({_csrf:csrf(restored.text)});assert.equal(stale.status,400,'Returning to edit invalidates the previous approval');
});
