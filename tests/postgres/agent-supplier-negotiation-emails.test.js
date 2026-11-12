'use strict';process.env.NODE_ENV='test';
// Job 94: a negotiation email built from recorded facts, each linked to its
// evidence. Pro drafts for the owner to edit and send; Custom drafts until a
// supplier rule is taught, then sends the routine lead-time note on its own.
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto'),{fixture}=require('../helpers/agent-rfq-fixture');
const service=require('../../src/purchasing/negotiation-drafts'),{addDays}=require('../../src/accounting/customer-money');

async function setup(t,plan){
 const f=await fixture(t,plan),{db,ctx,workflows}=f,vendor='fixture-supplier',sku=f.item.skuIds[0],today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),day=n=>addDays(today,-n);
 const handlers=require('../../src/operations/postgres-runtime-handlers').create({get:()=>f.provider}),jobs=require('../../src/operations/postgres-job-queue');
 const deliver=async()=>{const kind='agent.mail.supplier_negotiation.v1',out=[];for(let i=0;i<10;i++){const r=await jobs.processOne(db,{[kind]:handlers[kind]},{owner:'negotiation-test'});if(!r)break;out.push(r);}return out;};
 // One completed order: placed, due and fully (or partly) received on the given days ago.
 async function delivery(placed,expected,received,{ordered=1,got=ordered,cost=2}={}){
  const order=await workflows.createPurchaseOrder(db,ctx,{supplierId:vendor,destinationLocationId:f.location.id,expectedDate:day(expected),idempotencyKey:randomUUID(),lines:[{skuId:sku,quantityUnits:ordered,unitCost:cost}]});
  await workflows.approvePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,order.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:order.lineIds[0],quantity:got,locationId:f.location.id}]});
  await db.query('UPDATE purchase_orders SET ordered_at=$2,expected_date=$3 WHERE id=$1',[order.purchaseOrderId,day(placed)+'T12:00:00Z',day(expected)]);
  await db.query('UPDATE purchase_order_receipts SET received_at=$2 WHERE purchase_order_id=$1',[order.purchaseOrderId,day(received)+'T12:00:00Z']);
  return order;
 }
 const routine=async()=>{
  await db.transaction(c=>service.queue(c,ctx.workspaceId,today));
  const job=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.supplier-negotiation' ORDER BY created_at DESC LIMIT 1",[ctx.workspaceId])).rows[0];
  return db.transaction(c=>handlers['agent.supplier-negotiation']({workspaceId:ctx.workspaceId,payload:job.payload},c));
 };
 const review=()=>require('../../src/autopilot/job-reviews').run(db,ctx,'supplier-negotiation',{filter:vendor});
 return {...f,vendor,sku,today,day,deliver,delivery,routine,review};
}

test('Pro drafts a negotiation email from late and short deliveries, price increases, cheaper quotes and volume, then the owner edits and sends it', {timeout:600000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,workflows}=f;
 await f.delivery(60,50,45);await f.delivery(40,35,32);await f.delivery(24,18,18);
 const shortOrder=await f.delivery(12,6,4,{ordered:5,got:3});
 // Job 91: an invoice above the agreed price.
 await workflows.recordSupplierInvoice(db,ctx,{supplierId:f.vendor,purchaseOrderId:shortOrder.purchaseOrderId,supplierInvoiceNumber:'INV-UP-1',issueDate:f.day(3),currency:'USD',idempotencyKey:randomUUID(),
  lines:[{purchaseOrderLineId:shortOrder.lineIds[0],skuId:f.sku,quantity:3,unitCostMinor:260}]});
 // Job 92: a current quote from another supplier below this supplier's last price.
 const rival=(await db.query('SELECT id,name,email FROM suppliers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.supplierIds[1]])).rows[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.sku])).rows[0].code;
 const draftPo=await workflows.createPurchaseOrder(db,ctx,{supplierId:rival.id,currency:'USD',destinationLocationId:f.location.id,lines:[{skuId:f.sku,quantityUnits:10,unitCost:0.8}],idempotencyKey:randomUUID()});
 const order=(await db.query('SELECT * FROM purchase_orders WHERE id=$1',[draftPo.purchaseOrderId])).rows[0],connector=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[f.connectorId])).rows[0];
 const quoteText='Quotation: 10 units of '+code+' at USD 0.80 per unit.',original=await require('../../src/connections/postgres-mail').capture(db,connector,{messageId:randomUUID(),sender:rival.email,subject:'Quotation '+order.po_number,bodyText:quoteText+'\nValid through '+addDays(f.today,20)});
 const evidence=require('../../src/purchasing/postgres-supplier-evidence'),assessed=await evidence.assess(db,ctx,order,{documentType:'quotation',sourceMessageId:original.messageId,evidenceQuote:quoteText,currency:'USD',lines:[{sku:code,quantity:10,quantityBasis:'stock',unitCostMinor:80}],quotationTerms:{validThrough:addDays(f.today,20),evidence:'Valid through '+addDays(f.today,20)}});
 await db.transaction(c=>evidence.execute(c,ctx,assessed.payload));
 const orders=(await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 for(const plan of ['starter','growth']){await f.subscribe(plan);await f.browser.get('/autopilot/supplier-negotiations?supplier='+f.vendor).expect(402);await assert.rejects(service.prepare(db,ctx,{supplier:f.vendor}),/Pro/);}
 await f.subscribe('pro');
 const result=await f.review(),row=result.rows[0];
 assert.equal(row['Late deliveries'],2);assert.equal(row['Completed dated orders'],3);assert.equal(row['Short order lines'],1);assert.equal(row['Price increases'],1);assert.equal(row['Cheaper quotes'],1);assert.ok(row['Orders placed']>=4);
 const page=await f.browser.get('/autopilot/supplier-negotiations?supplier='+f.vendor).expect(200);
 for(const words of ['2 of 3 completed orders with an agreed delivery date arrived late','came in short','price went up','below your last price','We placed'])assert.ok(page.text.includes(words),words);
 for(const link of ['/purchasing/orders/'+shortOrder.purchaseOrderId,'/mail/'+original.messageId,'/suppliers/'+f.vendor])assert.ok(page.text.includes('href="'+link+'"'),link);
 await assert.rejects(service.configure(db,ctx,{supplier:f.vendor,evidence:result.negotiationForm.evidence,revision:''}),/Custom/);
 // Draft, edit and send through the outbound mail queue.
 const saved=await f.browser.post('/autopilot/negotiation-draft').type('form').send({supplier:f.vendor,evidence:result.negotiationForm.evidence,_csrf:f.csrf(page.text)}).expect(303);
 const id=saved.headers.location.split('/').pop();assert.equal(await service.prepare(db,ctx,result.negotiationForm),id,'The same facts give the same draft');
 let d=await service.draft(db,ctx,id);
 for(const words of ['2 of 3 completed orders','came in short','went from','below your last price','We placed'])assert.ok(d.body.includes(words),words);
 assert.ok(!d.body.includes(rival.name),'The other supplier is not named');assert.equal(d.facts.length,5);assert.ok(d.facts.every(x=>x.evidence.length>0));
 await service.edit(db,ctx,id,{subject:'Delivery and prices',body:d.body+'\n\nYou were late 2 times this year.'});d=await service.draft(db,ctx,id);
 await assert.rejects(service.send(db,ctx,id,{confirmed:'yes',connectorId:f.connectorId,bodyHash:'stale'}),/changed/);
 await assert.rejects(service.send(db,ctx,id,{confirmed:'yes',connectorId:'missing',bodyHash:service.bodyHash(d)}),/mailbox/);
 const sent=await service.send(db,ctx,id,{confirmed:'yes',connectorId:f.connectorId,bodyHash:service.bodyHash(d)});assert.equal(sent.replayed,false);
 assert.equal((await service.send(db,ctx,id,{confirmed:'yes',connectorId:f.connectorId,bodyHash:service.bodyHash(d)})).replayed,true);
 await assert.rejects(service.edit(db,ctx,id,{subject:'Later',body:'Changed'}),/already sent or queued/);
 assert.equal(f.sent.length,0);await f.deliver();assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].subject,'Delivery and prices');assert.match(f.sent[0].body,/You were late 2 times this year/);assert.equal(f.sent[0].recipient,'rfq-one@example.test');
 await f.deliver();assert.equal(f.sent.length,1,'Sent once');
 assert.equal((await service.draft(db,ctx,id)).status,'SENT');
 assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,orders,'Nothing was ordered');
 const audit=(await db.query("SELECT action FROM security_event_history WHERE workspace_id=$1 AND action LIKE '%negotiation%'",[ctx.workspaceId])).rows.map(r=>r.action);
 for(const action of ['Prepared supplier negotiation draft','Edited supplier negotiation draft','Supplier negotiation email approved and queued'])assert.ok(audit.includes(action),action);
 // The pages work on a desktop and a phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(res=>{const s=app.listen(0,'127.0.0.1',()=>res(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(res=>server.close(res));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port,next=await service.prepare(db,ctx,(await f.review()).negotiationForm).catch(()=>id);require('node:fs').mkdirSync('output',{recursive:true});
 for(const [width,height,name] of [[1440,900,'desktop'],[390,844,'phone']]){
  const tab=await browser.newPage({viewport:{width,height},isMobile:width<500,hasTouch:width<500});tab.setDefaultTimeout(15000);
  await tab.goto(origin+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const path of ['/autopilot/supplier-negotiations?supplier='+f.vendor,'/autopilot/supplier-negotiations/drafts/'+id,'/autopilot/supplier-negotiations/drafts/'+next]){
   assert.equal((await tab.goto(origin+path)).status(),200,path);assert.ok(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+path);
  }
  assert.match(await tab.locator('main').innerText(),/Late deliveries|Unsent draft|Sent/);
  await tab.goto(origin+'/autopilot/supplier-negotiations?supplier='+f.vendor);await tab.screenshot({path:'output/supplier-negotiation-'+name+'.png',fullPage:true});await tab.close();
 }
});

test('Custom drafts until taught, then sends the routine lead-time note on its own within the rule; holds and downgrades stop it', {timeout:600000},async t=>{
 const f=await setup(t,'enterprise'),{db,ctx}=f,modes=require('../../src/autopilot/job-modes');
 await f.delivery(40,35,32);await f.delivery(24,18,16);await f.delivery(12,5,5);
 // Untaught Custom only drafts: there is no routine.
 const form=(await f.review()).negotiationForm;assert.ok(form.evidence);
 await db.transaction(c=>service.queue(c,ctx.workspaceId,f.today));
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.supplier-negotiation'",[ctx.workspaceId])).rows[0].n,0);
 const manual=await service.prepare(db,ctx,form);assert.equal((await service.draft(db,ctx,manual)).status,'PREPARED');
 await assert.rejects(service.configure(db,ctx,{...form,everyDays:'10',connectorId:f.connectorId}),/30 to 365/);
 await service.configure(db,ctx,{...form,everyDays:'90',connectorId:f.connectorId});
 const first=await f.routine();assert.equal(first.sent,true,JSON.stringify(first));
 await f.deliver();assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].subject,'Delivery times for Fixture parts');assert.match(f.sent[0].body,/2 of 3 completed orders/);assert.match(f.sent[0].body,/confirm the lead time/);
 assert.match(f.sent[0].body,/does not place, change or cancel any order/);assert.doesNotMatch(f.sent[0].body,/\$|price list|discount/i);
 assert.match((await f.routine()).skipped,/not due/);await f.deliver();assert.equal(f.sent.length,1,'One note per period');
 const rule=async()=>(await db.query('SELECT * FROM stockchief_runtime.supplier_negotiation_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];
 let back=90;const due=()=>db.query('UPDATE stockchief_runtime.supplier_negotiation_rules SET last_sent_on=$2::date WHERE workspace_id=$1',[ctx.workspaceId,f.day(++back)]);
 // Ask me first and pause hold the note for the owner in Needs you.
 await due();await modes.save(db,ctx,94,{mode:'ask',revision:0});
 const asked=await f.routine();assert.equal(asked.sent,false);assert.match(asked.needsPerson,/Ask me first/);
 const notices=await service.inbox(db,ctx.workspaceId,ctx.actorId);assert.ok(notices.some(n=>/Send lead-time note/.test(n.title)&&n.href==='/autopilot/supplier-negotiations/drafts/'+asked.draft));
 await modes.save(db,ctx,94,{mode:'inherit',revision:1});
 await db.query('UPDATE workspace_autopilot SET paused=1 WHERE workspace_id=$1',[ctx.workspaceId]);
 const paused=await f.routine();assert.equal(paused.draft,asked.draft,'The held note is reused, not duplicated');assert.equal(paused.sent,false);
 await db.query('UPDATE workspace_autopilot SET paused=0 WHERE workspace_id=$1',[ctx.workspaceId]);
 // Once allowed again, the same held note goes out once.
 const resumed=await f.routine();assert.equal(resumed.sent,true);assert.equal(resumed.draft,asked.draft);await f.deliver();assert.equal(f.sent.length,2);
 // Shadow and Watch only change nothing.
 await due();await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
 assert.ok((await f.routine()).skipped);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await modes.save(db,ctx,94,{mode:'watch',revision:2});assert.match((await f.routine()).skipped,/Watch only/);await modes.save(db,ctx,94,{mode:'inherit',revision:3});
 // A downgrade stops a queued note before the mailbox is called.
 const queued=await f.routine();assert.equal(queued.sent,true);
 const effect=(await db.query("SELECT e.id FROM stockchief_runtime.agent_negotiation_drafts d JOIN stockchief_runtime.provider_effects e ON e.workspace_id=d.workspace_id AND e.aggregate_id=d.communication_id WHERE d.workspace_id=$1 AND d.id=$2",[ctx.workspaceId,queued.draft])).rows[0];
 await f.subscribe('pro');let calls=0;
 await assert.rejects(require('../../src/connections/postgres-outbound-mail').executeSendEffect(db,ctx.workspaceId,effect.id,{provider:{send:async()=>{calls++;return {externalMessageId:'unexpected'};}}}),/Custom|plan/i);assert.equal(calls,0);
 assert.equal((await f.routine()).skipped,'Plan changed');
 await f.subscribe('enterprise');
 // Missing facts: no late deliveries in the period means no note.
 await due();await db.query("UPDATE stockchief_runtime.supplier_negotiation_rules SET every_days=30 WHERE workspace_id=$1",[ctx.workspaceId]);
 await db.query('UPDATE purchase_orders SET expected_date=$3 WHERE workspace_id=$1 AND supplier_id=$2 AND expected_date IS NOT NULL',[ctx.workspaceId,f.vendor,f.today]);
 assert.match((await f.routine()).skipped,/on time/);
 // A supplier without an email address is held for the owner.
 await f.delivery(10,8,2);await db.query("UPDATE suppliers SET email='' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.vendor]);
 const noEmail=await f.routine();assert.equal(noEmail.sent,false);assert.match(noEmail.needsPerson,/email address/);
 assert.ok((await rule()).last_note);
 // Stopping the rule stops the routine.
 await service.configure(db,ctx,{supplier:f.vendor,revision:(await rule()).revision,remove:'1'});
 await db.transaction(c=>service.queue(c,ctx.workspaceId,f.today));
 assert.equal(f.sent.length,2);
});
