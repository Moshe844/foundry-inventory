'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:12}),{db,ctx}=f;await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Return mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'return-mailbox',now(),now())`,[connector,ctx.workspaceId,ctx.actorId]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0],service=require('../../src/sales/agent-customer-return-emails'),mail=require('../../src/connections/postgres-mail'),code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 async function sale(){
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:1200}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:3}]});return {...order,...(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[order.salesOrderId])).rows[0]};
 }
 const incoming=(order,{reference=randomUUID(),quantity=1,extra='',sender='receiver@example.test'}={})=>mail.capture(db,connection,{externalMessageId:randomUUID(),sender,subject:'Return request',bodyText:'Order: '+order.order_number+'\nReason: Damaged item\nResolution: refund\nReturn reference: '+reference+'\nSKU,Quantity\n'+code+','+quantity+extra});
 const review=id=>service.preview(db,ctx,id,f.location.id),create=async id=>{const p=await review(id);return service.create(db,ctx,id,{locationId:f.location.id,expectedFingerprint:p.facts.sourceFingerprint,confirmed:'yes'});},enable=()=>service.configure(db,ctx,{locationId:f.location.id,maximumUnits:3,windowDays:30,reviewAbove:'1000',currency:'USD',confirmed:'yes',revision:0});
 return {...f,connector,service,incoming,sale,review,create,enable};
}
test('Starter cannot use return-email automation; Growth reviews an exact email then teaches only its reviewed scope',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,order=await f.sale(),otherOrder=await f.sale(),proOrder=await f.sale(),customOrder=await f.sale(),first=await f.incoming(order),before=await f.balance(),journals=Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 await f.subscribe('starter');await assert.rejects(f.review(first.messageId),e=>e.code==='entitlement_required');await assert.rejects(f.enable(),e=>e.code==='entitlement_required');
 await f.subscribe('growth');await f.enable();assert.equal((await f.service.onArrival(db,ctx.workspaceId,first.messageId)).held,true);
 const reviewed=await f.review(first.messageId);await assert.rejects(f.service.create(db,ctx,first.messageId,{locationId:f.location.id,expectedFingerprint:reviewed.facts.sourceFingerprint}),/Review and approve/);
 const made=await f.create(first.messageId);assert.equal(made.status,'AUTHORIZED');assert.equal((await f.create(first.messageId)).replayed,true);
 await f.service.teach(db,ctx,first.messageId,{maximumUnits:1,confirmed:'yes',revision:0});
 const second=await f.incoming(order);const result=await f.service.onArrival(db,ctx.workspaceId,second.messageId);assert.equal(result.automatic,true);assert.notEqual(result.customerReturnId,made.customerReturnId);
 const third=await f.incoming(otherOrder,{quantity:2});const held=await f.service.onArrival(db,ctx.workspaceId,third.messageId);assert.equal(held.held,true);assert.match(held.reason,/saved customer\/product rule/);
 for(const [tier,sale]of [['pro',proOrder],['enterprise',customOrder]]){await f.subscribe(tier);const next=await f.incoming(sale,{quantity:2}),held=await f.service.onArrival(db,ctx.workspaceId,next.messageId);assert.equal(held.held,true);assert.match(held.reason,/saved customer\/product rule/);}
 await db.query("UPDATE workspace_connectors SET provider_account_id='changed-account' WHERE id=$1",[f.connector]);const changed=await f.incoming(otherOrder);const sourceHeld=await f.service.onArrival(db,ctx.workspaceId,changed.messageId);assert.equal(sourceHeld.held,true);assert.match(sourceHeld.reason,/source or product scope changed/);await db.query("UPDATE workspace_connectors SET provider_account_id='return-mailbox' WHERE id=$1",[f.connector]);
 await f.subscribe('starter');await f.service.teach(db,ctx,first.messageId,{remove:'yes',confirmed:'yes',revision:1});assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_return_email_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 assert.equal(await f.balance(),before);assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),journals);assert.equal((await db.query('SELECT count(*)::int n FROM customer_returns WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
});
test('native arrival worker creates one Pro or Custom RMA per customer reference without receiving or refunding',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.enable();const jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create(),kind='mail.customer-return.v1';
 for(const plan of ['pro','enterprise']){
  await f.subscribe(plan);const order=await f.sale(),reference=randomUUID(),first=await f.incoming(order,{reference}),second=await f.incoming(order,{reference});
  assert.equal(await jobs.claim(db,{owner:'previous-mail-worker',kinds:['mail.customer-order']}),null);
  const one=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'return-current-worker'});assert.equal(one.status,'COMPLETED',JSON.stringify(one.lastError));
  const two=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'return-current-worker'});assert.equal(two.status,'COMPLETED',JSON.stringify(two.lastError));
  const rows=(await db.query('SELECT id,status FROM customer_returns WHERE workspace_id=$1 AND sales_order_id=$2',[ctx.workspaceId,order.salesOrderId])).rows;assert.equal(rows.length,1);assert.equal(rows[0].status,'AUTHORIZED');
  assert.equal((await f.service.saved(db,ctx.workspaceId,first.messageId)).customer_return_id,rows[0].id);
  assert.equal((await f.service.onArrival(db,ctx.workspaceId,second.messageId)).replayed,true);
 }
 assert.equal(Number((await db.query('SELECT coalesce(sum(quantity_received),0) n FROM customer_return_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
});
test('queued return email honors a downgrade, pause and per-job watch before any RMA is created',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,order=await f.sale();await f.enable();
 const first=await f.incoming(order);await f.subscribe('starter');assert.equal((await f.service.onArrival(db,ctx.workspaceId,first.messageId)).held,true);
 await f.subscribe('pro');await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Synthetic pause');assert.equal((await f.service.onArrival(db,ctx.workspaceId,first.messageId)).held,true);await require('../../src/autopilot/postgres-service').resume(db,ctx,{role:'owner'});
 await require('../../src/autopilot/job-modes').save(db,ctx,111,{mode:'watch',revision:0});assert.equal((await f.service.onArrival(db,ctx.workspaceId,first.messageId)).held,true);
 assert.equal((await db.query('SELECT count(*)::int n FROM customer_returns WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
test('phone return-email journey shows Starter lock, reviewed Growth RMA, taught scope and downgrade-safe stopping',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,order=await f.sale(),incoming=await f.incoming(order);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;page.setDefaultTimeout(12000);
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await f.subscribe('starter');await page.goto(origin+'/mail/'+incoming.messageId);assert.equal(await page.getByRole('link',{name:'Review as a customer return'}).count(),0);assert.match(await page.locator('main').innerText(),/Growth/);
 await f.subscribe('growth');await page.reload();await page.getByRole('link',{name:'Review as a customer return',exact:true}).click();assert.equal(await page.getByRole('link',{name:'Review as a customer order'}).count(),0);
 await page.getByLabel('Location for the later physical inspection').selectOption(f.location.id);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Preview return request',exact:true}).click()]);
 assert.match(await page.locator('main').innerText(),/Exact proposed RMA/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.getByLabel('I approve this original customer request, order, products, quantities and requested resolution.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create this RMA',exact:true}).click()]);
 assert.match(await page.locator('main').innerText(),/Recorded RMA/);assert(await page.getByRole('link',{name:'Open this RMA',exact:true}).isVisible());
 await page.getByLabel('Maximum whole units in each matching request').fill('1');await page.getByLabel('I approve this exact customer and product rule, within the maximum above.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Save return request rule',exact:true}).click()]);
 await page.getByLabel('Inspection location',{exact:true}).selectOption(f.location.id);await page.getByLabel('Maximum whole units per request',{exact:true}).fill('3');await page.getByLabel('Return window in days',{exact:true}).fill('30');await page.getByLabel(/Ask me about returns worth more than/).fill('1000');await page.getByLabel('I authorize clear return requests from known customers within these limits.').check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Enable routine RMA requests',exact:true}).click()]);
 const next=await f.incoming(order);assert.equal((await f.service.onArrival(db,ctx.workspaceId,next.messageId)).automatic,true);
 await page.goto(origin+'/autopilot/reviews/customer-return-emails');assert.equal(await page.locator('tbody tr').count(),2);await page.locator('a[href="/mail/'+incoming.messageId+'/return"]').click();
 await f.subscribe('starter');await page.reload();assert.equal(await page.getByRole('button',{name:'Enable routine RMA requests'}).count(),0);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Stop routine RMA requests',exact:true}).click()]);
 assert.equal((await db.query('SELECT enabled FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].enabled,false);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.getByLabel("I confirm removing this learned limit. The plan's routine settings still apply.").check();await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Remove this learned return rule',exact:true}).click()]);assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_return_email_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});
test('concurrent return emails and case-only reference changes create one RMA and keep different instructions for review',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,order=await f.sale();await f.enable();
 const first=await f.incoming(order,{reference:'CUSTOMER-RETURN-1'}),second=await f.incoming(order,{reference:'customer-return-1'});
 const results=await Promise.allSettled([first,second].map(row=>f.service.onArrival(db,ctx.workspaceId,row.messageId)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,2,JSON.stringify(results.map(r=>r.reason?.message||r.value)));
 assert.equal(new Set(results.map(r=>r.value.customerReturnId)).size,1);
 const changed=await f.incoming(order,{reference:'Customer-Return-1',quantity:2});const held=await f.service.onArrival(db,ctx.workspaceId,changed.messageId);assert.equal(held.held,true);assert.match(held.reason,/different products or instructions/);
 assert.equal((await db.query('SELECT count(*)::int n FROM customer_returns WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
 const roi=await require('../../src/autopilot/time-saved').report(db,ctx);assert.equal(roi.rows.find(row=>row.key==='return-email').count,1);assert.equal(roi.rows.find(row=>row.key==='return-email').minutes,null);
});

test('different concurrent requests cannot over-return an order and stale approvals or shadow mode cannot create RMAs',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,order=await f.sale();await f.enable();
 const first=await f.incoming(order,{quantity:2}),second=await f.incoming(order,{quantity:2});
 const results=await Promise.all([first,second].map(row=>f.service.onArrival(db,ctx.workspaceId,row.messageId)));
 assert.equal(results.filter(row=>row.customerReturnId).length,1);assert.equal(results.filter(row=>row.held).length,1);
 assert.equal(Number((await db.query('SELECT coalesce(sum(quantity_authorized),0) n FROM customer_return_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),2);
 const nextOrder=await f.sale(),next=await f.incoming(nextOrder),preview=await f.review(next.messageId);
 await db.query("UPDATE connection_email_messages SET body_text=replace(body_text,'Reason: Damaged item','Reason: Wrong item') WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,next.messageId]);
 await assert.rejects(f.service.create(db,ctx,next.messageId,{locationId:f.location.id,expectedFingerprint:preview.facts.sourceFingerprint,confirmed:'yes'}),/exact original return email/);
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
 assert.equal((await f.service.onArrival(db,ctx.workspaceId,next.messageId)).held,true);
 await assert.rejects(f.create(next.messageId));
 assert.equal((await db.query('SELECT count(*)::int n FROM customer_returns WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});
