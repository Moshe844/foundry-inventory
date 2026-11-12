'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 102: payment reminders on the owner's schedule, each step in its own words.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const auto=require('../../src/autopilot/postgres-service');await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),day=n=>require('../../src/accounting/customer-money').addDays(today,n),connector=randomUUID();
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2 WHERE workspace_id=$1',[ctx.workspaceId,day(-120)]);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Accounts mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'accounts-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 // A customer who has bought before is not a first B2B customer.
 const parcel=await f.parcel();await f.shipping.markPacked(db,ctx,parcel.shipmentId);await f.shipping.handoff(db,ctx,parcel.shipmentId,{handover:'CARRIER',trackingNumber:randomUUID(),carrier:'UPS'});
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id,externalThreadId:'thread-'+message.id};}};
 const outbound=require('../../src/connections/postgres-outbound-mail'),assistant=require('../../src/assistant/postgres-service'),reminders=require('../../src/accounting/agent-invoice-reminders');
 const deliver=async()=>{for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows)await outbound.executeSendEffect(db,ctx.workspaceId,e.id,{provider}).catch(()=>{});};
 const invoice=async(due,amount='20.00',customerId='fixture-customer')=>{const row=await require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId,description:'Recorded services',quantity:1,unitAmount:amount,issueDate:day(-60),dueDate:day(due),idempotencyKey:randomUUID()});
  return (await db.query('SELECT * FROM accounting_customer_invoices WHERE id=$1',[row.id])).rows[0];};
 const drafts=async(status='PENDING')=>(await db.query("SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND action_type='customer_invoice.remind' AND status=$2 AND payload ? 'windowKey' ORDER BY created_at,id",[ctx.workspaceId,status])).rows;
 const rule=async()=>(await db.query("SELECT * FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id='fixture-customer'",[ctx.workspaceId])).rows[0];
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0],mail=require('../../src/connections/postgres-mail');
 const capture=(subject,bodyText,extra={})=>mail.capture(db,connection,{externalMessageId:randomUUID(),sender:'receiver@example.test',subject,bodyText,...extra});
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const pay=(i,amountMinor)=>f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:i.id,amountMinor,currency:'USD',paymentDate:today,method:'BANK_TRANSFER',sourceKey:randomUUID(),idempotencyKey:randomUUID()});
 return {...f,auto,today,day,connector,sent,provider,deliver,invoice,drafts,rule,capture,needs,pay,outbound,assistant,reminders,modes:require('../../src/autopilot/job-modes')};
}

test('a schedule reminds before, on and after the due date in each step’s own words; Growth drafts until taught, then sends alone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,run=()=>f.reminders.run(db,ctx.workspaceId);
 const before=await f.invoice(3),due=await f.invoice(0),first=await f.invoice(-7),late=await f.invoice(-40);
 // Growth may save a schedule before it is taught; its reminders then wait for approval.
 assert.deepEqual(await f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'100.00',before:'3',onDue:'1',days:'7, 30',revision:0}),{trained:false});
 assert.deepEqual((await f.rule()).days_after_due,[-3,0,7,30]);
 let r=await run();assert.deepEqual([r.drafted,r.queued],[4,0],JSON.stringify(r));assert.equal(f.sent.length,0);
 const stages=Object.fromEntries((await f.drafts()).map(p=>[p.payload.recordId,p.payload.template.stage]));
 assert.deepEqual([stages[before.id],stages[due.id],stages[first.id],stages[late.id]],['before','due','first','later']);
 assert.match((await f.rule()).problem,/Waiting for your approval: You have not taught/);
 assert.equal((await run()).drafted,0,'A waiting draft is not drafted again.');
 const firstDraft=(await f.drafts()).find(p=>p.payload.recordId===first.id);
 const preview=await f.browser.get('/actions/'+firstDraft.id).expect(200);assert.match(preview.text,/gentle reminder/);
 await f.assistant.executeProposal(db,ctx,firstDraft.id);await f.deliver();assert.equal(f.sent.length,1);
 assert.equal(f.sent[0].subject,'Payment reminder: invoice '+first.invoice_number);assert.match(f.sent[0].body,/gentle reminder that invoice .* for \$20\.00 was due on/);
 // That approved, delivered reminder teaches this customer and mailbox: the other steps now go out alone.
 r=await run();assert.equal(r.queued,3,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,4);
 const by=n=>f.sent.find(m=>m.subject.includes(n));
 assert.equal(by(before.invoice_number).subject,'Coming up: invoice '+before.invoice_number+' is due '+f.day(3));assert.match(by(before.invoice_number).body,/in 3 days/);
 assert.equal(by(due.invoice_number).subject,'Invoice '+due.invoice_number+' is due today');
 assert.equal(by(late.invoice_number).subject,'Overdue invoice '+late.invoice_number);assert.match(by(late.invoice_number).body,/now 40 days past its due date/);
 await run();assert.equal((await f.drafts()).length,0,'Drafts overtaken by sent reminders are withdrawn.');assert.equal((await f.drafts('CANCELLED')).length,3);
 assert.equal((await run()).queued,0,'Each window sends once.');
 // The owner's own wording for a step; it must keep the invoice and amount.
 await assert.rejects(f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'100.00',before:'3',onDue:'1',days:'7, 30',revision:1,subject7:'Hi',body7:'Please pay.'}),/Keep \{invoice\} and \{amount\}/);
 await assert.rejects(f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'100.00',days:'7',revision:1,subject7:'Hi {name}',body7:'{invoice} {amount}'}),/Use only/);
 await f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'100.00',before:'3',onDue:'1',days:'7, 30',revision:1,subject7:'A note about {invoice}',body7:'Dear {customer}, {invoice} ({amount}) was due {due}, {days} days ago.'});
 const own=await f.invoice(-7);assert.equal((await run()).queued,1);await f.deliver();
 assert.equal(f.sent.at(-1).subject,'A note about '+own.invoice_number);assert.equal(f.sent.at(-1).body,'Dear Receiver, '+own.invoice_number+' ($20.00) was due '+f.day(-7)+', 7 days ago.');
 // A wording change after queueing stops the stale message at the provider boundary.
 const stale=await f.invoice(-7);assert.equal((await run()).queued,1);
 await f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'100.00',before:'3',onDue:'1',days:'7, 30',revision:2,subject7:'Changed {invoice}',body7:'{invoice} {amount}'});
 const before6=f.sent.length;await f.deliver();assert.equal(f.sent.length,before6,'The queued reminder used wording the owner has since changed.');
 assert((await db.query("SELECT 1 FROM security_event_history WHERE workspace_id=$1 AND action='Payment reminder sent by StockChief on the owner’s schedule'",[ctx.workspaceId])).rowCount>0);
 assert.ok(stale);
});

test('payment or a dispute stops reminders; limits, pause, Watch, shadow and Ask me first hold them; Pro and Custom send alone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,run=()=>f.reminders.run(db,ctx.workspaceId);
 // Starter: excluded.
 await f.subscribe('starter');await f.browser.get('/autopilot/reviews/invoice-reminders').expect(402);
 await f.subscribe('pro');
 await f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'50.00',days:'7',revision:0});
 const disputed=await f.invoice(-7),over=await f.invoice(-7,'60.00');
 // The customer disputes an invoice by email: its reminders stop and the owner is told.
 await f.capture('About '+disputed.invoice_number,'Hello, we dispute invoice '+disputed.invoice_number+' - the price is wrong.');
 assert((await f.needs()).some(n=>n.title==='Receiver disputes '+disputed.invoice_number));
 assert.equal((await run()).queued,0,'Disputed and over-limit invoices are not reminded.');
 await assert.rejects(f.assistant.prepareAction(db,ctx,'Remind',{action:'customer_invoice.remind',recordReference:disputed.invoice_number,mailbox:f.connector}),/disputes invoice/);
 const page=await f.browser.get('/autopilot/reviews/invoice-reminders').expect(200);assert.match(page.text,/price is wrong/);
 await f.browser.post('/autopilot/invoice-reminders/disputes').type('form').send({_csrf:f.csrf(page.text),invoiceNumber:disputed.invoice_number,resolve:'1'}).expect(303);
 assert.equal((await run()).queued,1,'Settled, its reminders resume.');await f.deliver();assert.equal(f.sent.length,1);
 assert.equal((await db.query('SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND customer_invoice_id=$2',[ctx.workspaceId,over.id])).rowCount,0,'The owner’s balance limit holds on Pro.');
 // A reply to the reminder saying it was paid stops the next one too.
 const thread=(await db.query("SELECT external_thread_id FROM customer_communications WHERE workspace_id=$1 AND customer_invoice_id=$2",[ctx.workspaceId,disputed.id])).rows[0].external_thread_id;
 await f.capture('Re: Payment reminder','We already paid this last week.',{externalThreadId:thread});
 assert.equal((await db.query("SELECT count(*)::int n FROM stockchief_runtime.agent_customer_invoice_disputes WHERE workspace_id=$1 AND invoice_id=$2 AND status='OPEN'",[ctx.workspaceId,disputed.id])).rows[0].n,1);
 // Payment before the provider is called stops a queued reminder.
 const paid=await f.invoice(-7);assert.equal((await run()).queued,1);await f.pay(paid,2000);const count=f.sent.length;await f.deliver();assert.equal(f.sent.length,count);
 assert.equal((await run()).queued,0,'A paid invoice gets no further reminders.');
 // The owner can mark a dispute by hand.
 const marked=await f.invoice(-8);
 await f.reminders.dispute(db,ctx,{invoiceNumber:marked.invoice_number,reason:'Customer says the goods were short'});
 await assert.rejects(f.reminders.dispute(db,ctx,{invoiceNumber:marked.invoice_number,reason:'Again'}),/already marked/);
 assert.equal((await run()).queued,0);
 await f.reminders.dispute(db,ctx,{invoiceNumber:marked.invoice_number,resolve:'1'});
 // Pause, Watch only, the first 14 days and Ask me first.
 await f.auto.pause(db,ctx,{role:'owner'},'Hold');let r=await run();assert.deepEqual([r.queued,r.watched],[0,1]);assert.match((await f.rule()).problem,/paused.*would have sent 1 reminder/);await f.auto.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,102,{mode:'watch',revision:0});r=await run();assert.deepEqual([r.queued,r.watched],[0,1]);
 await f.modes.save(db,ctx,102,{mode:'ask',revision:1});r=await run();assert.deepEqual([r.queued,r.drafted],[0,1]);assert.match((await f.rule()).problem,/Ask me first/);
 await f.modes.save(db,ctx,102,{mode:'inherit',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);r=await run();assert.deepEqual([r.queued,r.watched],[0,1]);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await f.auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 // Custom sends on its own; the Ask-me-first draft is withdrawn once it is sent.
 await f.subscribe('enterprise');r=await run();assert.equal(r.queued,1);await f.deliver();assert.equal(f.sent.at(-1).subject,'Payment reminder: invoice '+marked.invoice_number);
 await run();assert.equal((await f.drafts()).length,0);
 // A first B2B customer waits for approval on every plan.
 const customer=randomUUID();await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES($1,$2,'New customer','new-reminder@example.test','ACTIVE',$3,now()::text,now()::text)",[customer,ctx.workspaceId,ctx.actorId]);
 await f.invoice(-7,'20.00',customer);await f.reminders.configure(db,ctx,{customerId:customer,connectorId:f.connector,currency:'USD',maximum:'50.00',days:'7',revision:0});
 r=await run();assert.deepEqual([r.queued,r.drafted],[0,1]);assert.match((await db.query('SELECT problem FROM stockchief_runtime.agent_invoice_reminder_rules WHERE workspace_id=$1 AND customer_id=$2',[ctx.workspaceId,customer])).rows[0].problem,/first B2B customer/);
});

test('the schedule page shows each step’s wording and disputes at desktop and phone width',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.subscribe('pro');
 await f.reminders.configure(db,ctx,{customerId:'fixture-customer',connectorId:f.connector,currency:'USD',maximum:'50.00',before:'2',onDue:'1',days:'10',revision:0});
 const i=await f.invoice(-12);await f.reminders.dispute(db,ctx,{invoiceNumber:i.invoice_number,reason:'Short delivery'});
 const page=await f.browser.get('/autopilot/reviews/invoice-reminders').expect(200);assert.match(page.text,/2 days before due · On the due date · 10 days after due/);assert.match(page.text,/Short delivery/);
 // Saving through the form keeps standard wording standard and stores the owner's own words.
 await f.browser.post('/autopilot/invoice-reminders/schedule').type('form').send({_csrf:f.csrf(page.text),customerId:'fixture-customer',revision:1,currency:'USD',connectorId:f.connector,maximum:'50.00',before:'2',onDue:'1',days:'10',
  'subject-2':f.reminders.STAGES.before.subject,'body-2':f.reminders.STAGES.before.body.replace(/\n/g,'\r\n'),subject0:f.reminders.STAGES.due.subject,body0:f.reminders.STAGES.due.body,subject10:'Still open: {invoice}',body10:'{customer}, {invoice} for {amount} is open.'}).expect(303);
 assert.deepEqual(Object.keys((await f.rule()).templates),['10']);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/invoice-reminders');assert(await tab.locator('[data-reminder-disputes]').isVisible());assert(await tab.locator('[data-reminder-step="10"]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'payment-reminder-schedule-'+width+'.png'),fullPage:true});
   if(phone){await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Settled, resume reminders'}).click()]);assert.match(await tab.locator('[data-reminder-disputes]').innerText(),/No invoice is disputed/);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
});
