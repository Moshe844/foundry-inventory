'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 72: customer emails about stock, delivery dates and order status.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const autopilot=require('../../src/autopilot/postgres-service');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const mailbox=async(name,account)=>{const id=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,$3,'gmail','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ctx.workspaceId,name,'connection_credentials:'+id,ctx.actorId,account]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',{accessToken:'test-token'}));
  return (await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];};
 const connection=await mailbox('Sales mailbox','sales-mailbox');
 const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create(),outbound=require('../../src/connections/postgres-outbound-mail');
 const capture=(subject,bodyText,sender='receiver@example.test',box=connection)=>mail.capture(db,box,{externalMessageId:randomUUID(),sender,subject,bodyText,threadId:'thread-'+randomUUID()});
 const run=id=>runtime['mail.customer-question.v1']({workspaceId:ctx.workspaceId,payload:{messageId:id}},db);
 const ask=async(subject,body,sender)=>{const m=await capture(subject,body,sender);return {id:m.messageId,...await run(m.messageId)};};
 const queued=async id=>(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2",[ctx.workspaceId,id])).rows.map(r=>r.kind);
 const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_customer_questions WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,id])).rows[0];
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 const deliver=async()=>{for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows)await outbound.executeSendEffect(db,ctx.workspaceId,e.id,{provider});};
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const code=(await db.query('SELECT code FROM skus WHERE id=$1',[f.item.skuIds[0]])).rows[0].code;
 const number=async orderId=>(await db.query('SELECT order_number FROM sales_orders WHERE id=$1',[orderId])).rows[0].order_number;
 return {...f,autopilot,mailbox,connection,capture,run,ask,queued,row,sent,provider,deliver,needs,code,number,outbound,
  questions:require('../../src/sales/agent-customer-questions'),modes:require('../../src/autopilot/job-modes')};
}

test('each plan answers by its mode: Growth drafts until taught, Pro and Custom answer alone, all from records',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,parcel=await f.parcel({quantity:2}),order=await f.number(parcel.order.salesOrderId);
 const status=['Order status','Hi, where is my order '+order+'? Thanks, Rita'];
 // Starter: the job is not included. Nothing is queued, read or sent.
 await f.subscribe('starter');
 let m=await f.capture(...status);assert.deepEqual(await f.queued(m.messageId),[]);assert.equal((await f.run(m.messageId)).skipped,true);
 // Growth: the answer is written from the records and waits until taught.
 await f.subscribe('growth');
 m=await f.capture(...status);assert((await f.queued(m.messageId)).includes('mail.customer-question.v1'));
 let r=await f.run(m.messageId);assert.equal(r.drafted,true,JSON.stringify(r));assert.match(r.reason,/not taught/);
 assert.equal((await f.run(m.messageId)).replayed,true,'One outcome per email.');
 let saved=await f.row(m.messageId);assert.deepEqual(saved.topics,['status']);
 assert.match(saved.answer_body,new RegExp('Order '+order+': confirmed, not shipped yet\\.'));assert.match(saved.answer_body,/2 ordered, 0 shipped/);assert.match(saved.answer_body,/being prepared and has not left yet/);
 assert.doesNotMatch(saved.answer_body,/\$|price|invoice/i,'No prices or money in a status answer.');
 assert((await f.needs()).some(n=>n.sourceId==='customer-question:'+m.messageId&&/Answer ready/.test(n.title)));
 assert.equal(f.sent.length,0);
 // The owner sends it; the mailbox confirms it; the email is answered.
 await assert.rejects(f.questions.approve(db,ctx,m.messageId,{expectedFingerprint:saved.fingerprint}),/Confirm/);
 await f.questions.approve(db,ctx,m.messageId,{confirmed:'yes',expectedFingerprint:saved.fingerprint});await f.deliver();
 assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'receiver@example.test');assert.equal(f.sent[0].subject,'Re: Order status');assert.match(f.sent[0].externalThreadId,/^thread-/,'It stays in the customer’s thread.');
 const email=(await db.query('SELECT reply_state,reply_sent_at FROM connection_email_messages WHERE id=$1',[m.messageId])).rows[0];assert.equal(email.reply_state,'WAITING');assert(email.reply_sent_at);
 assert.equal((await f.row(m.messageId)).status,'SENT');assert(!(await f.needs()).some(n=>n.sourceId==='customer-question:'+m.messageId));
 await assert.rejects(f.questions.approve(db,ctx,m.messageId,{confirmed:'yes',expectedFingerprint:saved.fingerprint}),/no longer waiting/);
 // That delivered answer taught Growth this customer's status questions.
 r=await f.ask('Update?','Any update on '+order+'?');assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,2);
 assert.equal((await f.row(r.id)).automatic,true);
 // A stock question is a different topic: it waits until a rule covers it.
 const stock=['Stock question','Do you have '+f.code+' in stock?'];
 r=await f.ask(...stock);assert.equal(r.drafted,true);assert.match(r.reason,/stock/);
 saved=await f.row(r.id);assert.match(saved.answer_body,new RegExp(f.code+'\\): 2 available\\.'));assert.match(saved.answer_body,/not a promise to hold it/);
 await f.questions.saveRule(db,ctx,{customer:'',topics:['stock']});
 r=await f.ask(...stock);assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,3);assert.match(f.sent[2].body,/2 available/);
 // A delivery date nobody recorded is never guessed, even on Pro.
 await f.subscribe('pro');
 const when=['Delivery','When will order '+order+' arrive?'];
 r=await f.ask(...when);assert.equal(r.held,true);assert.match(r.reason,/no delivery date is recorded/);
 assert.equal((await f.row(r.id)).answer_body,null);
 // Once the carrier has it with a date, Pro answers on its own without teaching.
 await f.shipping.markPacked(db,ctx,parcel.shipmentId,{});
 await f.shipping.handoff(db,ctx,parcel.shipmentId,{idempotencyKey:'handoff-'+order,carrier:'ups',trackingNumber:'1Z999AA10123456784',expectedDeliveryDate:'2031-01-15'});
 r=await f.ask(...when);assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,4);
 assert.match(f.sent[3].body,/tracking number 1Z999AA10123456784/);assert.match(f.sent[3].body,/expects to deliver it on 2031-01-15/);assert.match(f.sent[3].body,/shipped in full/);
 // Custom answers on its own too.
 await f.subscribe('enterprise');
 r=await f.ask('Where is it?','Has my order '+order+' shipped yet?');assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,5);
 // Every outcome is audited; nothing but email changed.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Customer %'",[ctx.workspaceId])).rows[0].n>=6);
 assert.equal((await db.query('SELECT count(*)::int n FROM sales_orders WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
});

test('unclear questions stop and ask; first contact, mailbox choice, pause, Watch, shadow and Ask me first never send alone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,parcel=await f.parcel({quantity:1}),order=await f.number(parcel.order.salesOrderId);
 await f.subscribe('pro');
 // A sender who is not a customer is set aside before anything is read.
 const stranger=await f.capture('Order status','Where is order '+order+'?','stranger@example.test');assert.equal(stranger.setAside,true);
 // Another customer's order: nothing about it is shared.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('other-shop',$1,'Northwind Yard','north@example.test','5 Elm St, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 const theirs=await f.workflows.createSalesOrder(db,ctx,{customerId:'other-shop',deliveryMethod:'PICKUP',idempotencyKey:'theirs',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]});
 let r=await f.ask('Order status','Where is order '+await f.number(theirs.salesOrderId)+'?');assert.equal(r.held,true);assert.match(r.reason,/cannot match/);assert.equal((await f.row(r.id)).answer_body,null);
 assert((await f.needs()).some(n=>n.sourceId==='customer-question:'+r.id&&/needs you/.test(n.title)));
 // Anything else the email asks for is a person's answer.
 r=await f.ask('Order '+order,'Where is my order '+order+'? Also please cancel one of them.');assert.equal(r.held,true);assert.match(r.reason,/cancellation/);
 r=await f.ask('Stock','Do you have ZZ-404 in stock?');assert.equal(r.held,true);assert.match(r.reason,/could not tell which product/);
 // The first time StockChief would write to a customer, a person approves it.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES('new-shop',$1,'Brand New Shop','new@example.test','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 r=await f.ask('Stock','Do you have '+f.code+' in stock?','new@example.test');assert.equal(r.drafted,true);assert.match(r.reason,/first time/);
 // Two mailboxes and no choice: StockChief does not pick one.
 const second=await f.mailbox('Accounts mailbox','accounts-mailbox');
 r=await f.ask('Order status','Where is my order '+order+'?');assert.equal(r.drafted,true);assert.match(r.reason,/more than one mailbox/);
 await db.query("INSERT INTO customer_communication_policy(workspace_id,shipping_notice,connector_id,created_at,updated_at) VALUES($1,'prepare',$2,now()::text,now()::text)",[ctx.workspaceId,second.id]);
 r=await f.ask('Stock','Do you have '+f.code+' in stock?');assert.equal(r.queued,true,JSON.stringify(r));
 const effect=(await db.query("SELECT payload FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2",[ctx.workspaceId,r.communicationId])).rows[0];
 assert.equal(effect.payload.connectorId,second.id,'The chosen mailbox sends it.');assert.equal(effect.payload.standingAuthority.threadId,undefined,'A thread from another mailbox is not reused.');
 // The records changed between queueing and the mailbox: nothing is sent.
 await f.workflows.confirmSalesOrder(db,ctx,(await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:'later',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]})).salesOrderId,{idempotencyKey:'later-confirm'});
 await assert.rejects(f.deliver(),/records changed/);assert.equal(f.sent.length,0);
 assert((await f.needs()).some(n=>n.sourceId==='customer-question:'+r.id&&/was not sent/.test(n.title)));
 // Pause, Watch only and the first 14 days only watch; Ask me first drafts.
 const status=['Status','Where is my order '+order+'?'];
 await f.autopilot.pause(db,ctx,{role:'owner'},'Hold answers');r=await f.ask(...status);assert.equal(r.watched,true);assert.match(r.reason,/paused.*would have answered Receiver/);
 assert.match((await f.row(r.id)).answer_body,new RegExp(order),'What it would have said is kept for the owner.');await f.autopilot.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,72,{mode:'watch',revision:0});r=await f.ask(...status);assert.equal(r.watched,true);assert.match(r.reason,/Watch only/);
 await f.modes.save(db,ctx,72,{mode:'ask',revision:1});r=await f.ask('Stock','Do you have '+f.code+' in stock?');assert.equal(r.drafted,true);assert.match(r.reason,/Ask me first/);
 const asked=r.id;
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);r=await f.ask(...status);assert.equal(r.watched,true);assert.match(r.reason,/first 14 days/);
 // The owner can still approve under Ask me first, but not during the first 14 days.
 let draft=await f.row(asked);await assert.rejects(f.questions.approve(db,ctx,asked,{confirmed:'yes',expectedFingerprint:draft.fingerprint}),/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // If the records changed since it was written, the answer is rewritten and shown again.
 await f.workflows.confirmSalesOrder(db,ctx,(await f.workflows.createSalesOrder(db,ctx,{customerId:'fixture-customer',deliveryMethod:'PICKUP',idempotencyKey:'later-2',lines:[{skuId:f.item.skuIds[0],quantity:1,unitPriceMinor:1200}]})).salesOrderId,{idempotencyKey:'later-2-confirm'});
 await assert.rejects(f.questions.approve(db,ctx,asked,{confirmed:'yes',expectedFingerprint:draft.fingerprint}),/records changed/);
 const rewritten=await f.row(asked);assert.notEqual(rewritten.fingerprint,draft.fingerprint);
 await f.questions.approve(db,ctx,asked,{confirmed:'yes',expectedFingerprint:rewritten.fingerprint});await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'receiver@example.test');
 await f.modes.save(db,ctx,72,{mode:'inherit',revision:2});
 // The owner can dismiss what waits for them.
 const held=(await db.query("SELECT message_id FROM stockchief_runtime.agent_customer_questions WHERE workspace_id=$1 AND status='HELD' ORDER BY created_at LIMIT 1",[ctx.workspaceId])).rows[0].message_id;
 await f.questions.dismiss(db,ctx,held);assert(!(await f.needs()).some(n=>n.sourceId==='customer-question:'+held));await assert.rejects(f.questions.dismiss(db,ctx,held),/no longer waiting/);
});

test('the review and answer pages work at desktop and phone width, and older terms see the plan card',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,parcel=await f.parcel({quantity:1}),order=await f.number(parcel.order.salesOrderId);
 const r=await f.ask('Order status','Where is my order '+order+'?');assert.equal(r.drafted,true);
 const page=await f.browser.get('/autopilot/reviews/customer-questions').expect(200);assert.match(page.text,/Waiting for your approval/);assert.match(page.text,/What StockChief answers on its own/);
 const detail=await f.browser.get('/autopilot/customer-questions/'+r.id).expect(200);assert.match(detail.text,/Send this answer/);assert.match(detail.text,new RegExp(order));
 // Rules through the page form.
 const csrf=f.csrf(page.text);await f.browser.post('/autopilot/customer-questions/rules').type('form').send({_csrf:csrf,customer:'Receiver',topics:['status','delivery']}).expect(303);
 assert.deepEqual((await db.query('SELECT topics FROM stockchief_runtime.agent_customer_answer_rules WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].topics,['delivery','status']);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/customer-questions');assert(await tab.locator('[data-customer-answer-rules]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   await tab.goto(base+'/autopilot/customer-questions/'+r.id);assert(await tab.locator('[data-customer-answer]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling on the answer at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'customer-answer-'+width+'.png'),fullPage:true});
   if(phone){await tab.getByLabel('I checked this answer and the recipient.').check();await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Send this answer'}).click()]);assert.match(await tab.locator('body').innerText(),/Answer queued/);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 await f.deliver();assert.equal(f.sent.length,1);
 // Agent terms below the plan keep the lock; older terms see the shared plan card.
 await f.subscribe('starter');await f.browser.get('/autopilot/customer-questions/'+r.id).expect(402);
 await f.subscribe('growth');
 await db.query(`UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='growth' AND (configuration->>'offerId') IS DISTINCT FROM 'agent-v3' ORDER BY version_number LIMIT 1) WHERE account_id=$1`,[f.owner.accountId]);
 assert.match((await f.browser.get('/autopilot/customer-questions/'+r.id).expect(200)).text,/data-agent-plan-locked/);
});
