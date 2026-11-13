'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 187: replies StockChief prepares for Gmail or Outlook mail.
async function fixture(t,plan='pro'){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx}=f;
 await f.subscribe('pro');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const autopilot=require('../../src/autopilot/postgres-service');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');await f.subscribe(plan);
 const scope={accountId:f.owner.accountId,workspaceId:ctx.workspaceId},entitlements=require('../../src/entitlements/postgres-service');
 if(!(await entitlements.capabilityState(db,scope,'communications.ai_drafts')).enabled)await db.query("UPDATE commercial_plan_entitlements SET enabled=1 WHERE capability='communications.ai_drafts'");
 const mailbox=async(name,account)=>{const id=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,$3,'gmail','[]','{"replyPreparationEnabled":true}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$6,now(),now())`,[id,ctx.workspaceId,name,'connection_credentials:'+id,ctx.actorId,account]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,id,'provider',{accessToken:'test-token'}));
  return (await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];};
 const sales=await mailbox('Sales mailbox','sales-mailbox');
 // A customer with an order on file, and a supplier StockChief has ordered from, are known.
 await f.parcel({quantity:1});
 await db.query("UPDATE suppliers SET email='parts@example.test' WHERE id='fixture-supplier'");
 const mail=require('../../src/connections/postgres-mail'),drafting=require('../../src/connections/postgres-reply-drafting'),runtime=require('../../src/operations/postgres-runtime-handlers').create();
 const capture=async(subject,bodyText,{sender='receiver@example.test',box=sales,thread='thread-'+randomUUID(),internetMessageId,attachments}={})=>{
  const r=await mail.capture(db,box,{externalMessageId:randomUUID(),sender,subject,bodyText,threadId:thread,internetMessageId,attachments,receivedAt:new Date().toISOString()});return {...r,thread};};
 const draft=(id,subject,body)=>drafting.savePrepared(db,ctx,id,{subject,body});
 const run=id=>runtime['mail.agent-reply.v1']({workspaceId:ctx.workspaceId,payload:{messageId:id}},db);
 const reply=['Re: Opening hours','Hello,\n\nThanks for your message. I am checking and will come back to you shortly.\n\nBest regards'];
 const ask=async(subject,body,options={},words=reply)=>{const m=await capture(subject,body,options);await draft(m.messageId,...words);return {id:m.messageId,thread:m.thread,...await run(m.messageId)};};
 const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_mail_replies WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,id])).rows[0];
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id,externalThreadId:message.externalThreadId};}};
 const deliver=async()=>{const out=[];for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.reply.send' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows){
  try{out.push(await mail.executeSendEffect(db,ctx.workspaceId,e.id,{provider}));}catch(error){out.push({error:error.message});}}return out;};
 const needs=()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const queued=async id=>(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2",[ctx.workspaceId,id])).rows.map(r=>r.kind);
 return {...f,autopilot,mailbox,sales,mail,drafting,capture,draft,run,reply,ask,row,sent,provider,deliver,needs,queued,
  replies:require('../../src/connections/agent-mail-replies'),modes:require('../../src/autopilot/job-modes')};
}
const hours=['Opening hours','Hi, could you remind me of your warehouse opening hours? Thanks, Rita'];

test('each plan by its mode: Starter cannot draft, Growth keeps replies for a person, Pro and Custom send alone in the same thread',{timeout:600000},async t=>{
 const f=await fixture(t,'starter'),{db,ctx}=f;
 // Starter: the job is not included; nothing is drafted or sent.
 let m=await f.capture(...hours);
 await assert.rejects(f.draft(m.messageId,...f.reply),/Growth plan/);assert(!(await f.queued(m.messageId)).includes('mail.agent-reply.v1'));
 // Growth: the reply is prepared and kept for a person.
 await f.subscribe('growth');
 let r=await f.ask(...hours);assert.equal(r.drafted,true,JSON.stringify(r));assert.match(r.reason,/Your plan keeps replies for you/);
 assert((await f.queued(r.id)).includes('mail.agent-reply.v1'));
 assert.equal((await f.run(r.id)).replayed,true,'One outcome per draft.');
 let items=(await f.needs()).filter(n=>n.href==='/mail/'+r.id);assert.equal(items.length,1,'The reply replaces the plain waiting item.');assert.match(items[0].title,/Reply ready for Receiver/);
 assert.equal(f.sent.length,0);
 // The person sends it themselves; it leaves Needs you.
 await f.mail.queueSend(db,ctx,r.id,{subject:f.reply[0],body:f.reply[1]});await f.deliver();assert.equal(f.sent.length,1);
 assert(!(await f.needs()).some(n=>n.href==='/mail/'+r.id));
 // Pro: sent on its own from the mailbox it came to, in the same conversation.
 await f.subscribe('pro');
 r=await f.ask(...hours);assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();
 assert.equal(f.sent.length,2);assert.equal(f.sent[1].recipient,'receiver@example.test');assert.equal(f.sent[1].externalThreadId,r.thread);assert.equal(f.sent[1].subject,'Re: Opening hours');
 const outbox=(await db.query('SELECT connector_id FROM stockchief_runtime.email_reply_outbox WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,r.id])).rows;assert.deepEqual(outbox.map(o=>o.connector_id),[f.sales.id]);
 let saved=await f.row(r.id);assert.equal(saved.status,'SENT');assert.equal(saved.automatic,true);
 const email=(await db.query('SELECT reply_state,reply_reason,reply_sent_at FROM connection_email_messages WHERE id=$1',[r.id])).rows[0];
 assert.equal(email.reply_state,'WAITING');assert.match(email.reply_reason,/StockChief sent this reply on its own/);
 assert.equal((await f.run(r.id)).replayed,true,'A replay sends nothing more.');await f.deliver();assert.equal(f.sent.length,2);
 // A known supplier is answered too, unless the owner keeps supplier replies.
 r=await f.ask('Catalogue','Hello, could you remind us who handles our account on your side?',{sender:'parts@example.test'});assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,3);
 await f.replies.saveSettings(db,ctx,{kinds:['customer']});
 r=await f.ask('Catalogue','Hello, could you remind us who handles our account on your side?',{sender:'parts@example.test'});assert.equal(r.drafted,true);assert.match(r.reason,/keep replies to suppliers/);
 // Job 72 answers stock, delivery and order questions itself; this job leaves them alone.
 r=await f.ask('Order status','Hi, where is my order? Thanks');assert.equal(r.skipped,true,JSON.stringify(r));assert.match(r.reason,/job 72/);
 assert((await f.queued(r.id)).includes('mail.customer-question.v1'));
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.email_reply_outbox WHERE message_id=$1',[r.id])).rows[0].n,0);
 // Custom sends on its own too.
 await f.subscribe('enterprise');
 r=await f.ask(...hours);assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,4);
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Mail reply sent by StockChief'",[ctx.workspaceId])).rows[0].n>=3);
});

test('unknown senders, page 13 topics, money, commitments, unclear threads and two mailboxes stop and ask; pause, Watch, shadow and Ask me first never send',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;
 // A sender who is no longer exactly one contact.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES('gone-shop',$1,'Gone Shop','gone@example.test','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 let m=await f.capture(...hours,{sender:'gone@example.test'});await f.draft(m.messageId,...f.reply);
 await db.query("UPDATE customers SET record_state='ARCHIVED' WHERE id='gone-shop'");
 let r=await f.run(m.messageId);assert.equal(r.held,true,JSON.stringify(r));assert.match(r.reason,/does not know gone@example.test/);
 assert((await f.needs()).some(n=>n.href==='/mail/'+m.messageId&&/Reply ready/.test(n.title)));
 // The first time StockChief would write to someone, a person sends it.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES('new-shop',$1,'Brand New Shop','new@example.test','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 r=await f.ask(...hours,{sender:'new@example.test'});assert.equal(r.held,true);assert.match(r.reason,/first time StockChief would write to Brand New Shop/);
 // Money, commitments and page 13 topics are a person's answer, in the email or the reply.
 r=await f.ask('Delivery','What do you charge for delivery to Albany?');assert.equal(r.held,true);assert.match(r.reason,/money/);
 // A quote request is job 73's; the reply waits for a person.
 r=await f.ask('Widget','Could you tell me the price of the blue widget?');assert.equal(r.held,true);assert.match(r.reason,/another StockChief job/);
 r=await f.ask('Pallets','Can you promise the pallets come on Monday?');assert.equal(r.held,true);assert.match(r.reason,/commitment/);
 r=await f.ask('Credit','Could you raise our credit limit?');assert.equal(r.held,true);assert.match(r.reason,/money|commitment/);
 r=await f.ask(...hours,{},['Re: Opening hours','Hello,\n\nWe accept your proposal.\n\nBest regards']);assert.equal(r.held,true);assert.match(r.reason,/commitment/);
 r=await f.ask('Photos','Could you look at the photos attached?',{attachments:[{filename:'shelf.jpg',mimeType:'image/jpeg',contentBase64:Buffer.from('jpeg-bytes').toString('base64')}]});assert.equal(r.held,true);assert.match(r.reason,/attachments/);
 // Unclear conversations: a newer email, another person in it, or the same email in two mailboxes.
 const first=await f.capture(...hours);await f.draft(first.messageId,...f.reply);
 await f.capture('Re: Opening hours','Also, are you open on Sunday?',{thread:first.thread});
 r=await f.run(first.messageId);assert.equal(r.held,true);assert.match(r.reason,/newer email/);
 await db.query("INSERT INTO customers(id,workspace_id,name,email,shipping_address,record_state,created_by_user_id,created_at,updated_at) VALUES('other-shop',$1,'Northwind Yard','north@example.test','5 Elm St, Albany, NY 12207','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 const shared=await f.capture(...hours,{sender:'north@example.test'});
 await f.capture(...hours,{thread:shared.thread});const late=(await db.query('SELECT id FROM connection_email_messages WHERE external_thread_id=$1 AND sender=$2',[shared.thread,'receiver@example.test'])).rows[0].id;
 await f.draft(late,...f.reply);r=await f.run(late);assert.equal(r.held,true);assert.match(r.reason,/More than one person wrote/);
 const second=await f.mailbox('Accounts mailbox','accounts-mailbox');
 const copy='<'+randomUUID()+'@example.test>';await f.capture(...hours,{internetMessageId:copy,box:second});
 r=await f.ask(...hours,{internetMessageId:copy});assert.equal(r.held,true);assert.match(r.reason,/more than one of your mailboxes/);
 // Two mailboxes and no choice: StockChief never picks one.
 r=await f.ask(...hours);assert.equal(r.held,true);assert.match(r.reason,/2 mailboxes connected\. Choose/);
 await f.replies.saveSettings(db,ctx,{connectorId:second.id,kinds:['customer','supplier']});
 r=await f.ask(...hours);assert.equal(r.drafted,true);assert.match(r.reason,/came to Sales mailbox.*only from Accounts mailbox/);
 r=await f.ask(...hours,{box:second});assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,1);
 assert.equal((await db.query('SELECT connector_id FROM stockchief_runtime.email_reply_outbox WHERE message_id=$1',[r.id])).rows[0].connector_id,second.id,'It replies from the mailbox the email came to.');
 // Pause, Watch only and the first 14 days only record it; Ask me first keeps it.
 await f.autopilot.pause(db,ctx,{role:'owner'},'Hold replies');r=await f.ask(...hours,{box:second});assert.equal(r.watched,true);assert.match(r.reason,/paused.*would have replied to Receiver/);await f.autopilot.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,187,{mode:'watch',revision:0});r=await f.ask(...hours,{box:second});assert.equal(r.watched,true);assert.match(r.reason,/Watch only/);
 await f.modes.save(db,ctx,187,{mode:'ask',revision:1});r=await f.ask(...hours,{box:second});assert.equal(r.drafted,true);assert.match(r.reason,/Ask me first/);
 await f.modes.save(db,ctx,187,{mode:'inherit',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);r=await f.ask(...hours,{box:second});assert.equal(r.watched,true);assert.match(r.reason,/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(f.sent.length,1);
 // Checked again at the mailbox: an edit after queueing stops the automatic send; the person can still send.
 r=await f.ask(...hours,{box:second});assert.equal(r.queued,true);
 await db.query("UPDATE connection_email_messages SET draft_body=draft_body||' Edited.' WHERE id=$1",[r.id]);
 let out=await f.deliver();assert.match(out[0].error,/changed after it was queued/);assert.equal(f.sent.length,1);
 assert.equal((await f.row(r.id)).status,'FAILED');assert((await f.needs()).some(n=>n.href==='/mail/'+r.id&&/was not sent/.test(n.title)));
 await f.mail.queueSend(db,ctx,r.id,{subject:f.reply[0],body:f.reply[1]+' Edited by the owner.'});await f.deliver();assert.equal(f.sent.length,2);assert.match(f.sent[1].body,/Edited by the owner/);
 // Every outcome is audited.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE 'Mail reply%'",[ctx.workspaceId])).rows[0].n>=12);
});

test('the reply page and its rules work at desktop and phone width, and older terms see the plan card',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f;
 await f.mailbox('Accounts mailbox','accounts-mailbox');
 const r=await f.ask(...hours);assert.equal(r.held,true);
 const page=await f.browser.get('/autopilot/reviews/mail-replies').expect(200);assert.match(page.text,/Replies sent on their own/);assert.match(page.text,/Stopped for you/);assert.match(page.text,/Choose the one StockChief answers from/);
 await f.browser.post('/autopilot/mail-replies/settings').type('form').send({_csrf:f.csrf(page.text),connectorId:f.sales.id,kinds:['customer','supplier']}).expect(303);
 assert.equal((await db.query('SELECT connector_id FROM stockchief_runtime.agent_mail_reply_settings WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].connector_id,f.sales.id);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/mail-replies');assert(await tab.locator('[data-mail-reply-rules]').isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'mail-replies-'+width+'.png'),fullPage:true});
   await tab.goto(base+'/mail/'+r.id);assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling on the email at '+width);
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
 // Older terms see the shared plan card.
 await db.query(`UPDATE account_subscriptions SET plan_version_id=(SELECT id FROM commercial_plan_versions WHERE plan_id='growth' AND (configuration->>'offerId') IS DISTINCT FROM 'agent-v3' ORDER BY version_number LIMIT 1),plan_id='growth' WHERE account_id=$1`,[f.owner.accountId]);
 assert.match((await f.browser.get('/autopilot/reviews/mail-replies').expect(200)).text,/data-agent-plan-locked/);
});
