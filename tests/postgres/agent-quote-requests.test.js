'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 73: quotes written from a customer's emailed request. Job 74: open quotes
// followed up after the number of days the owner chose.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const autopilot=require('../../src/autopilot/postgres-service');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const sku=f.item.skuIds[0],code=(await db.query('SELECT code FROM skus WHERE id=$1',[sku])).rows[0].code;
 await db.transaction(c=>require('../../src/pricing/postgres-service').setPricesInTransaction(c,ctx,[{skuId:sku,amountMinor:1200,currency:'USD'}]));
 const mailbox=async(name,account)=>{const id=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,$3,'gmail','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ctx.workspaceId,name,'connection_credentials:'+id,ctx.actorId,account]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',{accessToken:'test-token'}));
  return (await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];};
 const connection=await mailbox('Sales mailbox','sales-mailbox');
 const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create(),outbound=require('../../src/connections/postgres-outbound-mail');
 const capture=(subject,bodyText,sender='receiver@example.test')=>mail.capture(db,connection,{externalMessageId:randomUUID(),sender,subject,bodyText});
 const run=id=>runtime['mail.customer-quote.v1']({workspaceId:ctx.workspaceId,payload:{messageId:id}},db);
 const request=async(body,{subject='Quote request',sender}={})=>{const m=await capture(subject,body,sender);return {id:m.messageId,...await run(m.messageId)};};
 const lines=(quantity=3,extra='')=>'Hello,\nCould you please quote the following:\n'+code+' x '+quantity+extra+'\nThanks,\nRita';
 const queued=async id=>(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2",[ctx.workspaceId,id])).rows.map(r=>r.kind);
 const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_quote_requests WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,id])).rows[0];
 const count=async()=>(await db.query('SELECT count(*)::int n FROM sales_quotations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 const deliver=async()=>{for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows)await outbound.executeSendEffect(db,ctx.workspaceId,e.id,{provider});};
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const known=async()=>{const p=await f.parcel({quantity:1});return p;};
 return {...f,autopilot,sku,code,mailbox,connection,capture,run,request,lines,queued,row,count,sent,provider,deliver,needs,known,outbound,
  assistant:require('../../src/assistant/postgres-service'),requests:require('../../src/sales/agent-quote-requests'),followups:require('../../src/sales/agent-quote-followups'),
  training:require('../../src/autopilot/draft-authority'),modes:require('../../src/autopilot/job-modes'),quotes:require('../../src/sales/postgres-quotes')};
}

test('quote requests follow each plan: Pro drafts until taught, Custom writes and emails alone within limits',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.known();
 // Starter and Growth do not include the job: nothing is queued or written.
 for(const plan of ['starter','growth']){await f.subscribe(plan);const m=await f.capture('Quote request',f.lines());assert.deepEqual(await f.queued(m.messageId),[]);assert.equal((await f.run(m.messageId)).skipped,true);}
 await assert.rejects(f.requests.saveSettings(db,ctx,{days:'14',revision:0},'valid_days'),e=>e.code==='entitlement_required');
 await f.subscribe('pro');
 // Without a validity period StockChief stops and asks.
 let m=await f.capture('Quote request',f.lines());assert((await f.queued(m.messageId)).includes('mail.customer-quote.v1'),'A quote request is not read as an order or a question.');
 assert(!(await f.queued(m.messageId)).includes('mail.customer-question.v1'));
 let r=await f.run(m.messageId);assert.equal(r.held,true);assert.match(r.reason,/how many days your quotes stay valid/);
 await f.requests.saveSettings(db,ctx,{days:'14',revision:0},'valid_days');
 // Pro: the quote is prepared for approval until the owner teaches the scope.
 r=await f.request(f.lines());assert.equal(r.drafted,true,JSON.stringify(r));assert.match(r.reason,/not taught/);
 assert.equal((await f.run(r.id)).replayed,true,'One outcome per email.');
 const proposal=await f.assistant.getProposal(db,ctx.workspaceId,r.proposalId);assert.equal(proposal.status,'PENDING');assert.match(proposal.summary,/\$36\.00/);
 assert((await f.needs()).some(n=>n.href==='/actions/'+r.proposalId),'The prepared quote waits in Needs you.');
 assert.equal(await f.count(),0);
 await f.assistant.executeProposal(db,ctx,r.proposalId);assert.equal(await f.count(),1);
 await f.training.save(db,ctx,r.proposalId,{mode:'save',maximum:'100',revision:0});
 // Taught: the same customer, products and delivery up to $100 are written and emailed alone.
 r=await f.request(f.lines(5));assert.equal(r.emailed,true,JSON.stringify(r));assert.equal(await f.count(),2);
 assert.equal((await f.request(f.lines(5))).emailed,true);assert.equal(await f.count(),3);
 await f.deliver();assert.equal(f.sent.length,2);assert.equal(f.sent[0].recipient,'receiver@example.test');assert.match(f.sent[0].subject,/^Quotation QT-/);assert.match(f.sent[0].body,/Total: \$60\.00 USD/);
 let saved=await f.row(r.id);assert.equal(saved.status,'EMAILED');assert.equal(saved.automatic,true);
 const quote=await f.quotes.get(db,ctx.workspaceId,saved.quote_id);assert.equal(quote.status,'OPEN');assert.equal(quote.valid_until,require('../../src/accounting/customer-money').addDays(await require('../../src/lib/business-time').today(db,ctx.workspaceId),14));
 const evidence=(await db.query('SELECT presentation_basis FROM stockchief_runtime.agent_quote_followups WHERE workspace_id=$1 AND quote_id=$2',[ctx.workspaceId,saved.quote_id])).rows[0];
 assert.equal(evidence.presentation_basis,'mailbox_accepted','The mailbox-confirmed quote email can be followed up (job 74).');
 // Over the taught value it waits again.
 r=await f.request(f.lines(10));assert.equal(r.drafted,true);assert.match(r.reason,/not taught/);
 // Custom writes and sends alone, but keeps the owner's lower saved limit.
 await f.subscribe('enterprise');
 r=await f.request(f.lines(10));assert.equal(r.drafted,true);assert.match(r.reason,/over your saved limit/);
 r=await f.request(f.lines(2));assert.equal(r.emailed,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,3);assert.match(f.sent[2].body,/Total: \$24\.00 USD/);
 // Every outcome is audited; no order, stock or money moved.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action ILIKE '%quote%'",[ctx.workspaceId])).rows[0].n>=5);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});

test('unclear requests stop and ask; first quotes, mailbox choice, pause, Watch, shadow and Ask me first never write alone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.known();await f.subscribe('enterprise');await f.requests.saveSettings(db,ctx,{days:'10',revision:0},'valid_days');
 const stranger=await f.capture('Quote request',f.lines(),'stranger@example.test');assert.equal(stranger.setAside,true);
 let r=await f.request('Please quote:\nNOPE-1 x 3');assert.equal(r.held,true);assert.match(r.reason,/does not know the product code/);
 r=await f.request('Could you quote the following:\n'+f.code+' x 3\nsee the attached drawing');assert.equal(r.held,true);assert.match(r.reason,/could not read/);
 r=await f.request(f.lines(3,' @ 9.00'));assert.equal(r.held,true);assert.match(r.reason,/your price is \$12\.00\. A person decides prices/);
 r=await f.request('Could you quote the following:\n'+f.code+' x 3\nShip to: 99 Unknown Road, Far Town');assert.equal(r.held,true);assert.match(r.reason,/new delivery address/);
 assert((await f.needs()).some(n=>n.sourceId==='quote-request:'+r.id));
 // A first quote for a customer is approved by a person.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('new-shop',$1,'Brand New Shop','new@example.test','7 Oak St, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 r=await f.request(f.lines(),{sender:'new@example.test'});assert.equal(r.drafted,true);assert.match(r.reason,/first quote/);
 // Ask me first prepares it for approval; pause, Watch only and shadow only watch.
 await f.modes.save(db,ctx,73,{mode:'ask',revision:0});r=await f.request(f.lines());assert.equal(r.drafted,true);assert.match(r.reason,/Ask me first/);
 await f.modes.save(db,ctx,73,{mode:'watch',revision:1});r=await f.request(f.lines());assert.equal(r.watched,true);assert.match(r.reason,/Watch only/);
 await f.modes.save(db,ctx,73,{mode:'inherit',revision:2});
 await f.autopilot.pause(db,ctx,{role:'owner'},'Hold quotes');r=await f.request(f.lines());assert.equal(r.watched,true);assert.match(r.reason,/paused.*would have written Receiver a quote/);await f.autopilot.resume(db,ctx,{role:'owner'});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);r=await f.request(f.lines());assert.equal(r.watched,true);assert.match(r.reason,/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(await f.count(),0,'Nothing was written while unclear, watched, paused or in shadow.');
 // Two mailboxes and no choice: the quote is written but StockChief does not pick a mailbox.
 const second=await f.mailbox('Accounts mailbox','accounts-mailbox');
 r=await f.request(f.lines());assert.equal(r.quoted,true);assert.equal(r.emailed,false);assert.match(r.reason,/more than one mailbox/);
 const ready=(await f.needs()).find(n=>n.sourceId==='quote-request:'+r.id);assert.match(ready.title,/ready to email/);assert.match(ready.href,/\/quotes\/.+\/email$/);
 await db.query("INSERT INTO customer_communication_policy(workspace_id,shipping_notice,connector_id,created_at,updated_at) VALUES($1,'prepare',$2,now()::text,now()::text)",[ctx.workspaceId,second.id]);
 r=await f.request(f.lines());assert.equal(r.emailed,true,JSON.stringify(r));
 // A changed price before the mailbox sends it stops the email.
 await db.transaction(c=>require('../../src/pricing/postgres-service').setPricesInTransaction(c,ctx,[{skuId:f.sku,amountMinor:1300,currency:'USD'}]));
 await assert.rejects(f.deliver(),/prices|changed/);assert.equal(f.sent.length,0);
 // The owner can dismiss what waits for them.
 const held=(await db.query("SELECT message_id FROM stockchief_runtime.agent_quote_requests WHERE workspace_id=$1 AND status='HELD' ORDER BY created_at LIMIT 1",[ctx.workspaceId])).rows[0].message_id;
 await f.requests.dismiss(db,ctx,held);await assert.rejects(f.requests.dismiss(db,ctx,held),/no longer waiting/);
});

async function share(f,q){
 const mail=require('../../src/sales/quotation-mail'),p=await mail.facts(f.db,f.ctx,q.id,f.connection.id);
 return mail.send(f.db,f.ctx,q.id,{connectorId:f.connection.id,expectedFingerprint:p.sourceFingerprint,confirmed:'yes'});
}

test('open quotes are followed up after the days the owner chose: Growth only for taught scopes, Pro and Custom alone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.subscribe('growth');
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 const quote=(quantity=1)=>f.quotes.create(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',currency:'USD',orderDate:today,neededBy:null,discountMinor:0,taxMinor:0,codes:[],lines:[{skuId:f.sku,quantity}],validUntil:require('../../src/accounting/customer-money').addDays(today,14),requestKey:randomUUID()});
 const emailed=async(quantity)=>{const q=await quote(quantity);await share(f,q);await f.deliver();return q;};
 await f.subscribe('starter');await assert.rejects(f.requests.saveSettings(db,ctx,{days:'2',revision:0},'followup_days'),e=>e.code==='entitlement_required');
 await f.subscribe('growth');await assert.rejects(f.requests.saveSettings(db,ctx,{days:'0',revision:0},'followup_days'),/1 to 365/);
 await f.requests.saveSettings(db,ctx,{days:'2',revision:0},'followup_days');
 // Growth, untaught: the due follow-up waits in Needs you with the reason.
 const first=await emailed(1);assert.equal(f.sent.length,1);
 assert.deepEqual(await f.followups.run(db,ctx.workspaceId),{queued:0,held:0},'Not due yet.');
 t.mock.timers.enable({apis:['Date'],now:Date.now()+3*86400000});
 let result=await f.followups.run(db,ctx.workspaceId);assert.equal(result.waiting,1);assert.equal(result.queued,0);assert.equal(f.sent.length,1);
 const waiting=(await f.needs()).find(n=>n.sourceId==='quote-followup:'+first.id);assert(waiting);assert.match(waiting.why,/teach|taught/i);
 // The owner sends that one individually and teaches the scope.
 const p=(await f.assistant.prepareAction(db,ctx,'Follow up',{action:'sales_quote.followup',recordReference:first.quote_number,mailbox:f.connection.id})).proposal;
 await f.assistant.executeProposal(db,ctx,p.id);await f.deliver();assert.equal(f.sent.length,2);await f.training.save(db,ctx,p.id,{mode:'save',revision:0,maximum:'25.00'});
 assert(!(await f.needs()).some(n=>n.sourceId==='quote-followup:'+first.id));
 t.mock.timers.reset();
 // A taught customer, products and amount: scheduled and sent on its own after the delay, once.
 const second=await emailed(2);
 t.mock.timers.enable({apis:['Date'],now:Date.now()+3*86400000});
 result=await f.followups.run(db,ctx.workspaceId);assert.equal(result.scheduled,1,JSON.stringify(result));assert.equal(result.queued,1);
 assert.deepEqual(await f.followups.run(db,ctx.workspaceId),{queued:0,held:0},'Replays send nothing more.');
 await f.deliver();assert.equal(f.sent.length,4);assert.match(f.sent[3].body,new RegExp('quotation '+second.quote_number+', which we emailed on'));
 t.mock.timers.reset();
 // Pro follows up any emailed quote alone, including one StockChief wrote from a request.
 // Pro needs no teaching; the owner removes the Growth limit so every emailed quote qualifies.
 await f.subscribe('pro');await f.training.save(db,ctx,p.id,{mode:'remove',revision:1});await f.known();await f.requests.saveSettings(db,ctx,{days:'14',revision:1},'valid_days');
 const fromRequest=await f.request(f.lines(4));assert.equal(fromRequest.drafted,true);await f.assistant.executeProposal(db,ctx,fromRequest.proposalId);
 await f.training.save(db,ctx,fromRequest.proposalId,{mode:'save',maximum:'500',revision:0});
 const alone=await f.request(f.lines(6));assert.equal(alone.emailed,true,JSON.stringify(alone));await f.deliver();
 const third=await emailed(3),stopped=await emailed(5);
 // The owner stops one: the default never schedules it again.
 await f.followups.configure(db,ctx,stopped.id,{revision:1,days:1,connectorId:f.connection.id});await f.followups.configure(db,ctx,stopped.id,{revision:2,remove:'1'});
 t.mock.timers.enable({apis:['Date'],now:Date.now()+3*86400000});
 result=await f.followups.run(db,ctx.workspaceId);assert.equal(result.scheduled,2,JSON.stringify(result));assert.equal(result.queued,2);
 const before=f.sent.length;await f.deliver();assert.equal(f.sent.length,before+2);
 const quoted=(await db.query('SELECT quote_id FROM stockchief_runtime.agent_quote_requests WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,alone.id])).rows[0].quote_id;
 for(const id of [quoted,third.id])assert((await db.query("SELECT 1 FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2 AND status='SENT'",[ctx.workspaceId,'quote-followup:'+id])).rowCount,'Followed up '+id);
 assert.equal((await db.query("SELECT count(*)::int n FROM customer_communications WHERE workspace_id=$1 AND idempotency_key=$2",[ctx.workspaceId,'quote-followup:'+stopped.id])).rows[0].n,0,'A stopped follow-up stays stopped.');
 // Ask me first: due follow-ups wait for the owner.
 const later=await emailed(4);t.mock.timers.reset();t.mock.timers.enable({apis:['Date'],now:Date.now()+6*86400000});
 await f.modes.save(db,ctx,74,{mode:'ask',revision:0});result=await f.followups.run(db,ctx.workspaceId);assert.equal(result.waiting,1,JSON.stringify(result));
 assert.match((await f.needs()).find(n=>n.sourceId==='quote-followup:'+later.id).why,/Ask me first/);
 // The settings page renders at desktop and phone width.
 t.mock.timers.reset();
 const page=await f.browser.get('/autopilot/reviews/quote-followups').expect(200);assert.match(page.text,/Follow up on every emailed quote/);assert.match(page.text,/value="2"/);
 const requests=await f.browser.get('/autopilot/reviews/quote-requests').expect(200);assert.match(requests.text,/How long your quotes stay valid/);assert.match(requests.text,/Quote emailed/);
 const csrf=f.csrf(requests.text);await f.browser.post('/autopilot/quote-requests/settings').type('form').send({_csrf:csrf,days:'21',revision:'2'}).expect(303);
 assert.equal((await f.requests.settings(db,ctx.workspaceId)).valid_days,21);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/quote-requests');assert(await tab.locator('[data-quote-request-settings]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'quote-requests-'+width+'.png'),fullPage:true});
   await tab.goto(base+'/autopilot/reviews/quote-followups');assert(await tab.locator('[data-quote-followup-defaults]').isVisible());
   if(phone){await tab.getByLabel('Days after the quote was emailed').fill('3');await Promise.all([tab.waitForNavigation(),tab.locator('[data-quote-followup-defaults] button').click()]);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 assert.equal((await f.requests.settings(db,ctx.workspaceId)).followup_days,3);
});
