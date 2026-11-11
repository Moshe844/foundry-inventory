'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('anonymous HTTP requires CSRF, retains real dated tax and customer totals, exposes no private costing and revokes expired links',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t),{db,ctx,service:s}=f,taxPage=await f.browser.get('/accounting/tax'),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);await f.browser.post('/accounting/tax/rates').type('form').send({_csrf:f.csrf(taxPage.text),name:'Checked fixture sales tax',ratePercent:'10',jurisdiction:'Synthetic qualification only',appliesTo:'SALES',effectiveFrom:today}).expect(303);const rate=(await db.query('SELECT id FROM accounting_tax_rates WHERE workspace_id=$1 AND name=$2',[ctx.workspaceId,'Checked fixture sales tax'])).rows[0],p=await f.publish({taxRateId:rate.id}),app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>app.locals.sessionStore.close());const anonymous=require('supertest').agent(app),url='/customer/order/'+p.token,initial=await anonymous.get(url).expect(200),body={reference:'TAXED-REQUEST','lines[0][skuId]':f.skuId,'lines[0][quantity]':'2'};assert.equal(initial.headers['cache-control'],'no-store');assert.equal(initial.headers['referrer-policy'],'no-referrer');const blocked=await anonymous.post(url+'/review').type('form').send(body).expect(403);assert.match(blocked.text,/Nothing was submitted or charged/);assert.match(blocked.text,/Reload customer order form/);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);const blockedJson=await anonymous.post(url+'/review').set('Accept','application/json').type('form').send(body).expect(403);assert.equal(blockedJson.body.error.code,'invalid_csrf');const preview=await anonymous.post(url+'/review').type('form').send({...body,_csrf:f.csrf(initial.text)}).expect(200);assert.match(preview.text,/\$26\.40/);assert.match(preview.text,/\$2\.40/);assert.doesNotMatch(preview.text,/costUnitMinor|costUnit|receiver@example.test|tax_exempt_reference|source_snapshot/);const expectedHash=/name="expectedHash" value="([^"]+)"/.exec(preview.text)[1];await anonymous.post(url+'/submit').type('form').send({...body,_csrf:f.csrf(preview.text),expectedHash,confirmed:'yes'}).expect(303);const r=(await db.query("SELECT id FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND reference='TAXED-REQUEST'",[ctx.workspaceId])).rows[0],draft=await f.manual(r.id),native=(await db.query('SELECT tax_minor,pricing_quote_id FROM sales_orders WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,draft.salesOrderId])).rows[0];assert.equal(Number(native.tax_minor),240);assert.equal((await s.request(db,ctx,r.id)).snapshot.quote.totalMinor,2640);await db.query('UPDATE stockchief_runtime.agent_customer_order_pages SET expires_at=clock_timestamp()-interval \'1 second\' WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,p.id]);const expired=await anonymous.get(url).expect(404);assert.match(expired.text,/unavailable/);assert.doesNotMatch(expired.text,/name="lines/);
});

test('the customer confirmation redirect waits for the accepted request receipt to reach the session store',{timeout:180000},async t=>{
 const f=await require('../helpers/agent-customer-order-page-fixture').fixture(t),published=await f.publish();
 const app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:randomUUID()});
 const store=app.locals.sessionStore,save=store.set.bind(store),saving=Promise.withResolvers(),release=Promise.withResolvers();
 let first=true;
 store.set=(id,value,done)=>{
  if(first&&value.customerOrderReceipt){
   first=false;saving.resolve();release.promise.then(()=>save(id,value,done));return;
  }
  return save(id,value,done);
 };
 const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
 f.cleanup(async()=>{release.resolve();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();});
 const url='http://127.0.0.1:'+server.address().port+'/customer/order/'+published.token;
 const firstPage=await fetch(url),cookie=firstPage.headers.getSetCookie()[0].split(';')[0];
 const original={reference:'SAVED-BEFORE-REDIRECT','lines[0][skuId]':f.skuId,'lines[0][quantity]':'2'};
 const post=(suffix,input)=>fetch(url+suffix,{method:'POST',redirect:'manual',headers:{cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(input)});
 const preview=await (await post('/review',{...original,_csrf:f.csrf(await firstPage.text())})).text();
 const expectedHash=/name="expectedHash" value="([^"]+)"/.exec(preview)[1];
 let redirected=false;
 const send=post('/submit',{...original,_csrf:f.csrf(preview),expectedHash,confirmed:'yes'}).then(response=>{redirected=true;return response;});
 await saving.promise;
 try{
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(redirected,false,'The browser must not receive redirect headers while the receipt is uncommitted');
 }finally{release.resolve();}
 const response=await send;
 assert.equal(response.status,303);
 const confirmed=await fetch(new URL(response.headers.get('location'),url),{headers:{cookie}});
 const confirmation=await confirmed.text();
 assert.match(confirmation,/Request received/);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND reference='SAVED-BEFORE-REDIRECT'",[f.ctx.workspaceId])).rows[0].n,1);

 store.set=(id,value,done)=>value.customerOrderReceipt?setImmediate(()=>done(Error('Synthetic receipt session write failure'))):save(id,value,done);
 const fallback={...original,reference:'RECEIPT-WITHOUT-REDIRECT'};
 const fallbackPreview=await (await post('/review',{...fallback,_csrf:f.csrf(preview)})).text();
 const fallbackHash=/name="expectedHash" value="([^"]+)"/.exec(fallbackPreview)[1];
 const accepted=await post('/submit',{...fallback,_csrf:f.csrf(fallbackPreview),expectedHash:fallbackHash,confirmed:'yes'});
 assert.equal(accepted.status,200);
 assert.match(await accepted.text(),/Request received/);
 assert.equal((await f.db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_customer_page_requests WHERE workspace_id=$1 AND reference='RECEIPT-WITHOUT-REDIRECT'",[f.ctx.workspaceId])).rows[0].n,1);
});
