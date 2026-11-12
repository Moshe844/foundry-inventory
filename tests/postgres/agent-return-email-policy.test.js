'use strict';process.env.NODE_ENV='test';
// Job 111 on every plan: a customer's return email becomes an authorized RMA
// with the order, lines, quantities and reason, checked against the order and
// the owner's return policy. Unclear requests stop and ask in Needs you.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:40}),{db,ctx}=f;await f.subscribe('pro');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Return mailbox','gmail','[]','{}','connected','["MAIL_READ"]','CONNECTED',$3,'return-mailbox',now(),now())`,[connector,ctx.workspaceId,ctx.actorId]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0],service=require('../../src/sales/agent-customer-return-emails'),mail=require('../../src/connections/postgres-mail'),code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 async function sale({daysAgo=0}={}){
  const order=await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:randomUUID(),lines:[{skuId:f.item.skuIds[0],quantity:3,unitPriceMinor:1200}]});
  await f.workflows.confirmSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID()});await f.workflows.fulfillSalesOrder(db,ctx,order.salesOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],locationId:f.location.id,quantity:3}]});
  // The goods left some days ago: posted entries are immutable, so the test ages them with triggers off.
  if(daysAgo)await db.transaction(async c=>{await c.query("SET LOCAL session_replication_role='replica'");await c.query(`UPDATE accounting_journal_entries SET created_at=(now()-make_interval(days=>$3))::text WHERE workspace_id=$1 AND source_type='sale_fulfillment' AND metadata::jsonb->>'salesOrderLineId'=$2`,[ctx.workspaceId,order.lineIds[0],daysAgo]);});
  if(daysAgo)await db.query("UPDATE sales_shipments SET shipped_at=(now()-make_interval(days=>$3))::text,delivered_at=NULL WHERE workspace_id=$1 AND sales_order_id=$2",[ctx.workspaceId,order.salesOrderId,daysAgo]);
  return {...order,...(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[order.salesOrderId])).rows[0]};
 }
 const incoming=(order,{quantity=1,sku=code,number=order.order_number}={})=>mail.capture(db,connection,{externalMessageId:randomUUID(),sender:'receiver@example.test',subject:'Return request',
  bodyText:'Order: '+number+'\nReason: Arrived broken\nResolution: refund\nReturn reference: '+randomUUID()+'\nSKU,Quantity\n'+sku+','+quantity});
 const policy=(extra={})=>service.configure(db,ctx,{locationId:f.location.id,maximumUnits:3,windowDays:30,reviewAbove:'100',currency:'USD',confirmed:'yes',...extra});
 const revision=async()=>(await db.query('SELECT revision FROM stockchief_runtime.agent_return_email_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0]?.revision||0;
 const approve=async(id,extra={})=>{const p=await service.preview(db,ctx,id,f.location.id);return service.create(db,ctx,id,{locationId:f.location.id,expectedFingerprint:p.facts.sourceFingerprint,confirmed:'yes',...extra});};
 const needs=async()=>(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('return-email:'));
 const returns=async()=>(await db.query('SELECT id,status,reason FROM customer_returns WHERE workspace_id=$1 ORDER BY created_at',[ctx.workspaceId])).rows;
 const audits=async()=>(await db.query("SELECT action,after_state FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Return created%' ORDER BY created_at",[ctx.workspaceId])).rows;
 return {...f,service,incoming,sale,policy,revision,approve,needs,returns,audits,code};
}

test('Starter is locked; Growth drafts until taught, then creates authorized RMAs alone; Pro and Custom create alone; replays keep one RMA',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;
 await f.subscribe('starter');const early=await f.incoming(await f.sale());
 await assert.rejects(service.preview(db,ctx,early.messageId,f.location.id),e=>e.code==='entitlement_required');await assert.rejects(f.policy({revision:0}),e=>e.code==='entitlement_required');
 // Growth: the request waits in Needs you as a draft until a reviewed example is taught.
 await f.subscribe('growth');const first=await f.incoming(await f.sale());
 const off=await service.onArrival(db,ctx.workspaceId,first.messageId);assert.equal(off.held,true);assert.match(off.reason,/off/);
 await f.policy({revision:0});const draft=await service.onArrival(db,ctx.workspaceId,first.messageId);assert.equal(draft.held,true);
 assert.ok((await f.needs()).some(n=>n.href==='/mail/'+first.messageId+'/return'));assert.equal((await f.returns()).length,0);
 const made=await f.approve(first.messageId);assert.equal(made.status,'AUTHORIZED');assert.equal(made.automatic,false);
 assert.equal((await f.needs()).some(n=>n.href==='/mail/'+first.messageId+'/return'),false,'a created return leaves Needs you');
 const row=(await f.returns())[0];assert.equal(row.status,'AUTHORIZED');assert.equal(row.reason,'Arrived broken');
 const lines=(await db.query('SELECT quantity_authorized,quantity_received FROM customer_return_lines WHERE customer_return_id=$1',[row.id])).rows;assert.deepEqual(lines.map(l=>[Number(l.quantity_authorized),Number(l.quantity_received)]),[[1,0]]);
 await service.teach(db,ctx,first.messageId,{maximumUnits:2,confirmed:'yes',revision:0});
 const taught=await f.incoming(await f.sale());const alone=await service.onArrival(db,ctx.workspaceId,taught.messageId);assert.equal(alone.automatic,true);assert.equal(alone.status,'AUTHORIZED');
 assert.equal((await service.onArrival(db,ctx.workspaceId,taught.messageId)).replayed,true,'a replayed email keeps one RMA');
 // Pro and Custom need no teaching.
 for(const plan of ['pro','enterprise']){
  await f.subscribe(plan);const email=await f.incoming(await f.sale(),{quantity:2});const result=await service.onArrival(db,ctx.workspaceId,email.messageId);
  assert.equal(result.automatic,true,plan+': '+JSON.stringify(result));assert.equal(result.status,'AUTHORIZED');
 }
 assert.equal((await f.returns()).length,4);
 const logged=await f.audits();assert.deepEqual(logged.map(a=>a.action),['Return created from a customer email after review','Return created on its own from a customer email','Return created on its own from a customer email','Return created on its own from a customer email']);
 assert.equal(logged[1].after_state.returnWindowDays,30);assert.equal(logged[1].after_state.value,'$12.00');
 // Nothing was received, restocked or refunded.
 assert.equal(Number((await db.query('SELECT coalesce(sum(quantity_received),0) n FROM customer_return_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_sale_refunds WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
});

test('unknown orders, items not on the order, late requests and high-value returns stop and ask; a person may still accept them',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.policy({revision:0});const order=await f.sale();
 const unknown=await f.incoming(order,{number:'NO-SUCH-ORDER'});let held=await service.onArrival(db,ctx.workspaceId,unknown.messageId);assert.equal(held.held,true);assert.match(held.reason,/order/);
 const stranger=await f.incoming(order,{sku:'NOT-ON-THIS-ORDER'});held=await service.onArrival(db,ctx.workspaceId,stranger.messageId);assert.equal(held.held,true);assert.match(held.reason,/exact line on the original order/);
 const tooMany=await f.incoming(order,{quantity:4});held=await service.onArrival(db,ctx.workspaceId,tooMany.messageId);assert.equal(held.held,true);
 // Late: the goods left 40 days ago and the window is 30 days.
 const old=await f.sale({daysAgo:40}),late=await f.incoming(old);held=await service.onArrival(db,ctx.workspaceId,late.messageId);
 assert.equal(held.held,true);assert.match(held.reason,/40 days after the goods left\. Your return window is 30 days/);
 const page=await service.page(db,ctx,late.messageId,f.location.id);assert.equal(page.policy.days,40);assert.equal(page.policy.daysLeft,-10);
 await assert.rejects(f.approve(late.messageId),/Confirm you accept this return anyway/);
 const accepted=await f.approve(late.messageId,{policyConfirmed:'yes'});assert.equal(accepted.status,'AUTHORIZED');
 // High value: three units at $12 against a $30 limit.
 await f.policy({reviewAbove:'30',revision:await f.revision()});const big=await f.incoming(await f.sale(),{quantity:3});held=await service.onArrival(db,ctx.workspaceId,big.messageId);
 assert.equal(held.held,true);assert.match(held.reason,/worth \$36\.00, over your limit of \$30\.00/);
 const asks=await f.needs();for(const id of [unknown,stranger,tooMany,big].map(m=>m.messageId))assert.ok(asks.some(n=>n.href==='/mail/'+id+'/return'),'Needs you lists '+id);
 assert.equal((await f.returns()).length,1,'only the person-accepted late return became an RMA');
 const log=(await f.audits()).at(-1);assert.equal(log.after_state.automatic,false);assert.match(log.after_state.outsidePolicy.join(' '),/return window/);
});

test('pause, watch only, Ask me first and the first 14 days create no RMA on their own',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx,service}=f;await f.policy({revision:0});const order=await f.sale(),auto=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 const email=await f.incoming(order);
 await auto.pause(db,ctx,{role:'owner'},'Owner pause');let held=await service.onArrival(db,ctx.workspaceId,email.messageId);assert.equal(held.held,true);assert.match(held.reason,/paused/i);await auto.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,111,{mode:'ask',revision:0});held=await service.onArrival(db,ctx.workspaceId,email.messageId);assert.equal(held.held,true);assert.match(held.reason,/Ask me first/);
 await modes.save(db,ctx,111,{mode:'watch',revision:1});held=await service.onArrival(db,ctx.workspaceId,email.messageId);assert.equal(held.held,true);assert.match(held.reason,/Watch only/);
 await modes.save(db,ctx,111,{mode:'inherit',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);held=await service.onArrival(db,ctx.workspaceId,email.messageId);assert.equal(held.held,true);assert.match(held.reason,/14 days/);
 assert.equal((await f.returns()).length,0);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const made=await service.onArrival(db,ctx.workspaceId,email.messageId);assert.equal(made.automatic,true);assert.equal((await f.returns()).length,1);
});

test('the return review page shows the policy facts and settings at desktop width and on a phone',{timeout:300000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.policy({revision:0});const email=await f.incoming(await f.sale({daysAgo:40}));
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1366,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.setDefaultTimeout(12000);
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/mail/'+email.messageId+'/return?locationId='+f.location.id);const text=await page.locator('main').innerText();
  assert.match(text,/Goods left 40 days ago · return window 30 days/);assert.match(text,/Your return window is 30 days/);assert.match(text,/Return value: \$12\.00 · ask above \$100\.00/);
  assert.equal(await page.getByLabel('Return window in days',{exact:true}).inputValue(),'30');assert.equal(await page.getByLabel(/Ask me about returns worth more than/).inputValue(),'100.00');
  assert(await page.getByLabel('I accept this return even though it is outside my return policy.').isVisible());
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no sideways scroll at '+viewport.width);
  if(viewport.width===390){await page.getByLabel('I approve this original customer request, order, products, quantities and requested resolution.').check();await page.getByLabel('I accept this return even though it is outside my return policy.').check();
   await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Create this RMA',exact:true}).click()]);assert.match(await page.locator('main').innerText(),/Recorded RMA[\s\S]*AUTHORIZED/);}
  await page.close();
 }
});
