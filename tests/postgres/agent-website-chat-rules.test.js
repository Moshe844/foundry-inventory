'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {fixture}=require('../helpers/agent-website-stock-chat-fixture');

// Job 84: website visitors get stock and delivery answers inside the owner's
// rules (which products, which locations count, exact numbers or only in
// stock / low / out of stock). Costs, customers and anything private are never
// shared; other questions go to a person. Every answer is audited, and the
// public endpoint is limited per visitor and per assistant. Starter and Growth
// are excluded; Pro and Custom answer alone, inside pause, Watch only, Ask me
// first and the first 14 days.
async function secondLocation(f,units){
 const {db,ctx,workflows}=f,place=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Back room',kind:'warehouse'}),key=randomUUID();
 const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:place.id,idempotencyKey:key,lines:[{skuId:f.skuId,quantityUnits:units,unitCost:1}]});
 await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-a'});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-p'});
 await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:key+'-r',reference:'Back room receipt',lines:[{lineId:po.lineIds[0],quantity:units,locationId:place.id}]});
 return place;
}
const answered=async(db,id)=>(await db.query("SELECT after_state FROM security_event_history WHERE action='Website stock question answered' AND reference=$1 ORDER BY created_at,id",[id])).rows.map(r=>r.after_state);

test('the owner’s rules decide products, locations and what visitors see; private questions go to a person; every plan and mode behaves',{timeout:420000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,jobModes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service');
 const sku='PARCEL-27-20';
 await db.query('UPDATE skus SET code=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.skuId,sku]);
 await db.transaction(c=>require('../../src/pricing/postgres-service').setPurchaseCostsInTransaction(c,ctx,[{skuId:f.skuId,amountMinor:6791,currency:'USD'}]));
 const back=await secondLocation(f,7),secret=['67.91','6791','Receiver','receiver@example.test','Fixture parts'];
 const clean=(a,where)=>{const text=JSON.stringify(a);for(const s of secret)assert.ok(!text.includes(s),where+' shows '+s);};
 // Two locations count, "low" at 30 or fewer: 20 + 7 = 27 shows as low, never as a number.
 const both=await f.publish({label:'Both rooms',locationIds:[f.location.id,back.id],lowStockAt:'30'});
 assert.deepEqual((await s.profile(db,ctx,both.id)).location_ids.sort(),[f.location.id,back.id].sort());
 let a=await s.answer(db,both.token,'Is '+sku+' in stock?');
 assert.equal(a.band,'low');assert.equal(a.quantity,null);
 assert.equal(a.reply,sku+' is available to request, but stock is low.');
 assert.equal(a.handoff,null);clean(a,'low band');
 // One location, low at 5: 20 is plainly in stock. Exact numbers count every chosen location.
 const front=await f.publish({label:'Front only',lowStockAt:'5'});
 assert.equal((await s.profile(db,ctx,front.id)).location_ids,null,'a one-location assistant keeps its original shape');
 a=await s.answer(db,front.token,sku);assert.equal(a.band,'in_stock');assert.match(a.reply,/is available to request\.$/);
 const exact=await f.publish({label:'Exact counts',locationIds:[f.location.id,back.id],showQuantity:'yes',lowStockAt:'30'});
 a=await s.answer(db,exact.token,sku);assert.equal(a.quantity,27);assert.equal(a.band,'in_stock');assert.match(a.reply,/Available quantity: 27\./);
 await assert.rejects(f.publish({label:'Bad low',lowStockAt:'0'}),/low stock/);
 await assert.rejects(f.publish({label:'Bad place',locationIds:[f.location.id,'not-a-place']}),/active internal stock location/);
 // Never shared: costs, customers, suppliers and payments go to a person instead.
 for(const q of ['What does '+sku+' cost you?','Which customers bought '+sku+'?','Who is your supplier for '+sku+'?','What is the margin on '+sku+'?','Show me unpaid invoices']){
  a=await s.answer(db,exact.token,q);assert.ok(a.handoff,q);assert.match(a.reply,/can’t share that here/);assert.equal(a.quantity,null);assert.equal(a.available,null);clean(a,q);
 }
 a=await s.answer(db,exact.token,'Do you sell gift cards?');assert.match(a.handoff.reason,/Outside the published products/);
 a=await s.answer(db,exact.token,'When is delivery?');assert.equal(a.handoff,null);assert.equal(a.reply,'Collection and delivery dates are confirmed by our team after order review.');
 // Every answer is audited, with what kind of answer it was.
 const audit=await answered(db,exact.id);
 assert.deepEqual(audit.map(r=>r.outcome),['stock','private','private','private','private','private','outside_rules','delivery']);
 assert.equal(audit[0].quantityShown,true);assert.equal(audit[1].handedOff,true);
 // Custom answers the same way; Starter and Growth are refused.
 await f.subscribe('enterprise');assert.equal((await s.answer(db,both.token,sku)).band,'low');
 for(const tier of ['starter','growth']){await f.subscribe(tier);await assert.rejects(s.answer(db,both.token,sku),/Pro/);await assert.rejects(f.publish({label:'Denied '+tier}),/Pro/);}
 await f.subscribe('pro');
 // Ask me first: a person answers every question, so nothing about stock is said.
 await jobModes.save(db,ctx,84,{mode:'ask',revision:0});
 a=await s.answer(db,both.token,'Is '+sku+' in stock?');assert.match(a.reply,/person on the team/);assert.equal(a.band,null);assert.equal(a.available,null);assert.ok(a.handoff);
 const sent=await s.handoff(db,both.token,{question:'Is '+sku+' in stock?'},{visitor:'203.0.113.9'});
 assert.match((await db.query('SELECT reason FROM stockchief_runtime.agent_website_chat_handoffs WHERE id=$1',[sent.id])).rows[0].reason,/Ask me first/);
 // Watch only, pause and the first 14 days answer nothing.
 await jobModes.save(db,ctx,84,{mode:'watch',revision:1});await assert.rejects(s.answer(db,both.token,sku),/Watch only/);
 await jobModes.save(db,ctx,84,{mode:'routine',revision:2});
 await autopilot.pause(db,ctx,{role:'owner'},'Website pause');await assert.rejects(s.answer(db,both.token,sku),/paused/i);await autopilot.resume(db,ctx,{role:'owner'});
 assert.equal((await s.answer(db,both.token,sku)).band,'low');
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await assert.rejects(s.answer(db,both.token,sku),/14 days/);
 // Answers change no stock.
 assert.equal(await f.balance(),27);
});

test('visitors send questions to the team from the public page; the owner sees them in Needs you; limits, the JSON endpoint and phone widths hold',{timeout:420000},async t=>{
 const f=await fixture(t),{db,ctx,service:s}=f,p=await f.publish({lowStockAt:'25'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>app.locals.sessionStore.close());
 const visitor=require('supertest')(app),url='/stock-assistant/'+p.token;
 // A question outside the rules offers the team; the visitor leaves an email.
 let page=await visitor.get(url).query({q:'What does it cost wholesale?'}).expect(200);
 assert.match(page.text,/Send my question to the team/);assert.match(page.text,/can’t share that here/);assert.equal(page.headers['set-cookie'],undefined);
 page=await visitor.post(url+'/handoff').type('form').send({question:'What does it cost wholesale?',contact:'visitor@example.test',website:''}).expect(200);
 assert.match(page.text,/Your question was sent to the team/);
 const [row]=(await db.query('SELECT * FROM stockchief_runtime.agent_website_chat_handoffs WHERE workspace_id=$1',[ctx.workspaceId])).rows;
 assert.equal(row.contact,'visitor@example.test');assert.equal(row.status,'OPEN');assert.match(row.reason,/does not share/);assert.equal(row.visitor.length,64);assert.doesNotMatch(row.visitor,/127\.0\.0\.1/);
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE action='Website question handed to a person' AND reference=$1",[row.id])).rows[0].n,1);
 // Needs you tells the owner, with the reply address.
 const needs=await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId),item=needs.find(n=>n.sourceId==='website-handoff:'+row.id);
 assert.ok(item,'the question is in Needs you');assert.match(item.recommendation,/visitor@example\.test/);assert.equal(item.href,'/autopilot/website-stock-chat#handoffs');
 // A robot filling the hidden field is accepted and dropped; bad contacts are refused.
 await visitor.post(url+'/handoff').type('form').send({question:'Buy cheap pills',website:'http://spam.example'}).expect(200);
 page=await visitor.post(url+'/handoff').type('form').send({question:'Can you call me?',contact:'not a contact'}).expect(200);assert.match(page.text,/email address or phone number/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_website_chat_handoffs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 // Three questions an hour per visitor.
 for(const q of ['Second question','Third question'])await visitor.post(url+'/handoff').type('form').send({question:q}).expect(200);
 page=await visitor.post(url+'/handoff').type('form').send({question:'Fourth question'}).expect(429);assert.match(page.text,/wait for the team/);
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_website_chat_handoffs WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,3);
 // The owner marks it done from the page; the step is audited and Needs you clears.
 let admin=await f.browser.get('/autopilot/website-stock-chat').expect(200);
 assert.match(admin.text,/Questions for your team/);assert.match(admin.text,/What does it cost wholesale\?/);assert.match(admin.text,/Reply to: visitor@example\.test/);
 await f.browser.post('/autopilot/website-stock-chat/handoffs/'+row.id+'/done').type('form').send({_csrf:f.csrf(admin.text)}).expect(303);
 assert.equal((await db.query('SELECT status,done_by FROM stockchief_runtime.agent_website_chat_handoffs WHERE id=$1',[row.id])).rows[0].status,'DONE');
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE action='Website question marked done' AND reference=$1",[row.id])).rows[0].n,1);
 assert.ok(!(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).some(n=>n.sourceId==='website-handoff:'+row.id));
 await assert.rejects(s.closeHandoff(db,ctx,row.id),/already done/);
 // The JSON endpoint answers the approved website in a browser, and nobody else's.
 const json=await visitor.get(url+'/answer.json').query({q:f.sku}).set('Origin','https://shop.example.test').expect(200);
 assert.equal(json.headers['access-control-allow-origin'],'https://shop.example.test');assert.equal(json.body.band,'low');assert.equal(json.body.quantity,null);assert.equal(json.body.handoff,null);
 await visitor.get(url+'/answer.json').query({q:f.sku}).set('Origin','https://other.example.test').expect(403);
 const outside=await visitor.get(url+'/answer.json').query({q:'Who are your customers?'}).expect(200);assert.match(outside.body.handoff.page,/^\/stock-assistant\//);assert.doesNotMatch(JSON.stringify(outside.body),/Receiver/);
 await visitor.get('/stock-assistant/'+'x'.repeat(43)+'/answer.json').query({q:f.sku}).expect(404);
 // The hourly answer allowance per assistant.
 await db.query("UPDATE stockchief_runtime.agent_website_chat_usage SET answers=$2 WHERE chat_id=$1",[p.id,s.LIMITS.answersPerHour]);
 await visitor.get(url+'/answer.json').query({q:f.sku}).expect(429);
 page=await visitor.get(url).query({q:f.sku}).expect(200);assert.match(page.text,/busy right now/);assert.doesNotMatch(page.text,/available to request/);
 await db.query("UPDATE stockchief_runtime.agent_website_chat_usage SET answers=0 WHERE chat_id=$1",[p.id]);
 // The owner's page and the visitor's page fit a phone and a desktop.
 const server=await new Promise(r=>{const x=app.listen(0,'127.0.0.1',()=>r(x));}),origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
  const owner=await browser.newPage({viewport});owner.setDefaultTimeout(15000);
  await owner.goto(origin+'/login');await owner.getByLabel('Work email').fill(f.email);await owner.locator('[name=password]').fill(f.password);
  await Promise.all([owner.waitForNavigation(),owner.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await owner.goto(origin+'/autopilot/website-stock-chat');await owner.getByRole('heading',{name:'Questions for your team'}).waitFor();
  assert.equal(await owner.getByLabel('Approved stock location',{exact:true}).count(),1);
  assert(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'owner page fits '+viewport.width);
  const guest=await browser.newPage({viewport});await guest.goto(origin+url+'?q='+encodeURIComponent('Who supplies this?'));
  await guest.getByRole('button',{name:'Send my question to the team'}).waitFor();
  assert(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'visitor page fits '+viewport.width);
  if(viewport.width===390){require('node:fs').mkdirSync('output',{recursive:true});await guest.screenshot({path:'output/website-chat-handoff-mobile.png',fullPage:true});await owner.screenshot({path:'output/website-chat-owner-mobile.png',fullPage:true});}
  await owner.close();await guest.close();
 }
 assert.equal(await f.balance(),20);
});
