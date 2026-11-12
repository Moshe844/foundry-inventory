'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 81: a customer's request for their account statement, by email or in Ask.
async function fixture(t){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 const autopilot=require('../../src/autopilot/postgres-service');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const days=require('../../src/accounting/customer-money'),today=await require('../../src/lib/business-time').today(db,ctx.workspaceId);
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2,base_currency=$3 WHERE workspace_id=$1',[ctx.workspaceId,days.addDays(today.slice(0,7)+'-01',-60),'USD']);
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Accounts mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'accounts-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[connector])).rows[0];
 const mail=require('../../src/connections/postgres-mail'),runtime=require('../../src/operations/postgres-runtime-handlers').create();
 const outbound=require('../../src/connections/postgres-outbound-mail'),assistant=require('../../src/assistant/postgres-service');
 const capture=(subject,bodyText,sender='receiver@example.test')=>mail.capture(db,connection,{externalMessageId:randomUUID(),sender,subject,bodyText});
 const run=id=>runtime['mail.customer-statement.v1']({workspaceId:ctx.workspaceId,payload:{messageId:id}},db);
 const request=async(subject,body,sender)=>{const m=await capture(subject,body,sender);return {id:m.messageId,...await run(m.messageId)};};
 const queued=async id=>(await db.query("SELECT kind FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND payload->>'messageId'=$2",[ctx.workspaceId,id])).rows.map(r=>r.kind);
 const row=async id=>(await db.query('SELECT * FROM stockchief_runtime.agent_statement_requests WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,id])).rows[0];
 const invoice=(amount='20.00')=>require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId:'fixture-customer',description:'Recorded service',quantity:1,unitAmount:amount,issueDate:today,dueDate:today,idempotencyKey:randomUUID()});
 const pay=(invoiceId,amountMinor)=>f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:invoiceId,amountMinor,currency:'USD',paymentDate:today,method:'BANK_TRANSFER',sourceKey:randomUUID(),idempotencyKey:randomUUID()});
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 const deliver=async()=>{for(const e of (await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='PENDING' ORDER BY created_at,id",[ctx.workspaceId])).rows)await outbound.executeSendEffect(db,ctx.workspaceId,e.id,{provider});};
 const ask=text=>assistant.ask(db,ctx,text,{usageKey:randomUUID()});
 const needs=async()=>require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId);
 const pdfText=async content=>{const lib=await import('pdfjs-dist/legacy/build/pdf.mjs'),doc=await lib.getDocument({data:new Uint8Array(content)}).promise;let text='';
  for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i);text+=(await page.getTextContent()).items.map(x=>x.str).join(' ')+'\n';}return text;};
 return {...f,today,connector,connection,capture,run,request,queued,row,invoice,pay,sent,provider,deliver,ask,needs,pdfText,autopilot,assistant,outbound,
  modes:require('../../src/autopilot/job-modes'),requests:require('../../src/accounting/agent-statement-requests')};
}
const ASKED=['Statement request','Hi, could you send us our account statement? Thanks, Rita'];

test('an emailed request follows each plan, replies only to the address on file with the complete PDF, and never twice',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,first=await f.invoice(),second=await f.invoice('5.00');
 // Starter: the job is not included, so nothing is queued or sent.
 await f.subscribe('starter');
 let m=await f.capture(...ASKED);assert.deepEqual(await f.queued(m.messageId),[]);assert.equal((await f.run(m.messageId)).skipped,true);
 let r=await f.ask('Send Receiver their statement');assert.equal(r.status,'CLARIFY');assert.match(r.answer,/Growth|plan/i);
 // Growth: a first statement to a customer waits for a person.
 await f.subscribe('growth');
 m=await f.capture(...ASKED);assert(await f.queued(m.messageId).then(k=>k.includes('mail.customer-statement.v1')));
 r=await f.run(m.messageId);assert.equal(r.drafted,true,JSON.stringify(r));assert.match(r.reason,/first statement/);
 assert.equal((await f.run(m.messageId)).replayed,true,'One outcome per email.');
 const draft=await f.assistant.getProposal(db,ctx.workspaceId,r.proposalId);assert.equal(draft.status,'PENDING');assert.equal(draft.payload.recipient,'receiver@example.test');
 assert.equal(f.sent.length,0);
 await f.assistant.executeProposal(db,ctx,r.proposalId);await f.deliver();assert.equal(f.sent.length,1);
 const mailOut=f.sent[0];assert.equal(mailOut.recipient,'receiver@example.test');assert.match(mailOut.body,/attached as a PDF/);
 assert.equal(mailOut.attachments.length,1);assert.equal(mailOut.attachments[0].contentType,'application/pdf');assert.match(mailOut.attachments[0].filename,/^Statement-Receiver-USD-\d{4}-\d{2}-\d{2}\.pdf$/);
 const providers=require('../../src/connections/providers/photo-attachments');
 assert.match(providers.mime(mailOut),/Content-Type: application\/pdf\r\nContent-Disposition: attachment; filename="Statement-Receiver-USD-/,'Gmail gets the PDF as a MIME attachment.');
 assert.equal(providers.graph(mailOut.attachments)[0].contentType,'application/pdf','Microsoft 365 gets it as a file attachment.');
 const text=await f.pdfText(mailOut.attachments[0].content);assert.match(text,/ACCOUNT STATEMENT/);assert.match(text,new RegExp(first.invoice_number));assert.match(text,new RegExp(second.invoice_number));assert.match(text,/\$25\.00/);
 // That approved, delivered statement teaches Growth this customer and mailbox up to its value.
 await f.pay(first.id,500);
 r=await f.request(...ASKED);assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,2);assert.match(f.sent[1].body,/Account balance: \$20\.00/);
 const taught=await f.row(r.id);assert.deepEqual([taught.status,taught.automatic],['QUEUED',true]);
 // Asking again for the same unchanged statement replays it instead of sending it twice.
 r=await f.request(...ASKED);assert.equal(r.queued,true);assert.equal(r.replayed,true);await f.deliver();assert.equal(f.sent.length,2);
 // A larger account than the taught example waits again.
 await f.invoice('50.00');r=await f.request(...ASKED);assert.equal(r.drafted,true);assert.match(r.reason,/not taught/);assert.equal(f.sent.length,2);
 // Pro and Custom send on their own.
 for(const plan of ['pro','enterprise']){
  await f.subscribe(plan);await f.invoice('1.00');const before=f.sent.length;
  r=await f.request('Account statement','Please send our latest statement.');assert.equal(r.queued,true,plan+' '+JSON.stringify(r));await f.deliver();
  assert.equal(f.sent.length,before+1);assert.equal(f.sent.at(-1).recipient,'receiver@example.test');assert.equal(f.sent.at(-1).attachments[0].contentType,'application/pdf');
 }
 // Every outcome is audited; no money moved.
 assert((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action LIKE '%statement%'",[ctx.workspaceId])).rows[0].n>=4);
 assert.equal((await db.query("SELECT count(*)::int n FROM accounting_payments WHERE workspace_id=$1",[ctx.workspaceId])).rows[0].n,1);
});

test('unclear requests stop and ask; pause, Watch, shadow and Ask me first never send',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,inv=await f.invoice();await f.pay(inv.id,100);
 await f.subscribe('pro');
 // A sender who is not a customer: the mail is set aside and the request waits for the owner.
 const aside=await f.capture('Account statement','Please send our statement','stranger@example.test');assert.equal(aside.setAside,true);
 const stranger=(await db.query('SELECT * FROM stockchief_runtime.agent_statement_requests WHERE workspace_id=$1 AND set_aside_id=$2',[ctx.workspaceId,aside.id])).rows[0];
 assert.equal(stranger.status,'HELD');assert.match(stranger.reason,/not one of your customers/);
 assert((await f.needs()).some(n=>n.sourceId==='statement-request:aside:'+aside.id));
 // A request naming another customer.
 await db.query("INSERT INTO customers(id,workspace_id,name,email,record_state,created_by_user_id,created_at,updated_at) VALUES('other-trading',$1,'Other Trading','other@example.test','ACTIVE',$2,now()::text,now()::text)",[ctx.workspaceId,ctx.actorId]);
 let r=await f.request('Statement','Please send the account statement for Other Trading too.');assert.equal(r.held,true);assert.match(r.reason,/another customer, Other Trading/);
 // Another period.
 r=await f.request('Statement','Can you send our statement for March 2026?');assert.equal(r.held,true);assert.match(r.reason,/particular period/);
 // Two currencies named, or a currency the account does not have.
 r=await f.request('Statement','Please send our EUR and USD statements');assert.equal(r.held,true);assert.match(r.reason,/more than one currency \(EUR, USD\)/);
 r=await f.request('Statement','Please send our EUR statement');assert.equal(r.held,true);assert.match(r.reason,/no recorded receivables in EUR/);
 assert.equal(f.sent.length,0);
 // Pause, Watch only and shadow only watch.
 await f.autopilot.pause(db,ctx,{role:'owner'},'Hold statements');r=await f.request('Statement','Please send our USD statement');assert.equal(r.watched,true);assert.match(r.reason,/paused.*would have sent Receiver their USD statement/);await f.autopilot.resume(db,ctx,{role:'owner'});
 await f.modes.save(db,ctx,81,{mode:'watch',revision:0});r=await f.request('Statement','Please send our USD statement');assert.equal(r.watched,true);assert.match(r.reason,/Watch only/);
 // Ask me first prepares the statement for approval instead.
 await f.modes.save(db,ctx,81,{mode:'ask',revision:1});r=await f.request('Statement','Please send our USD statement');assert.equal(r.drafted,true);assert.match(r.reason,/Ask me first/);
 await f.modes.save(db,ctx,81,{mode:'inherit',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);r=await f.request('Statement','Please send our USD statement');assert.equal(r.watched,true);assert.match(r.reason,/first 14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);await f.autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 await f.deliver();assert.equal(f.sent.length,0,'Nothing was sent while unclear, paused, watched or in shadow.');
 // With nothing in the way, Pro sends the named currency on its own, to the address on file.
 r=await f.request('Statement','Please send our USD statement');assert.equal(r.queued,true,JSON.stringify(r));await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0].recipient,'receiver@example.test');
 // The owner can dismiss what waits for them.
 await f.requests.dismiss(db,ctx,stranger.id);assert(!(await f.needs()).some(n=>n.sourceId==='statement-request:aside:'+aside.id));
 await assert.rejects(f.requests.dismiss(db,ctx,stranger.id),/no longer waiting/);
});

test('Ask sends on Pro and waits on untaught Growth; large accounts send every row in the PDF; the page works on a phone',{timeout:600000},async t=>{
 const f=await fixture(t),{db,ctx}=f,inv=await f.invoice();await f.pay(inv.id,100);
 let r=await f.ask('Send Receiver their statement');assert.equal(r.status,'PREPARED',JSON.stringify(r));assert.match(r.answer,/waits for your approval: You have not taught/);
 await f.subscribe('pro');
 r=await f.ask('Send Receiver their account statement in USD');assert.equal(r.status,'ANSWERED',JSON.stringify(r));assert.match(r.answer,/^Sending Receiver their USD account statement/);
 await f.deliver();assert.equal(f.sent.length,1);assert.equal(f.sent[0].attachments[0].contentType,'application/pdf');
 r=await f.ask('Send Receiver their March statement');assert.equal(r.status,'CLARIFY');assert.match(r.answer,/current statement only/);
 // More rows than the email lists: the email summarizes and the PDF carries every invoice.
 const many=[];for(let i=0;i<70;i++)many.push(await f.invoice('1.00'));
 r=await f.ask('Send Receiver their statement');assert.equal(r.status,'ANSWERED',JSON.stringify(r));await f.deliver();
 const big=f.sent.at(-1);assert.match(big.body,/Every invoice is in the attached PDF/);const text=await f.pdfText(big.attachments[0].content);
 for(const one of many)assert(text.includes(one.invoice_number),one.invoice_number+' is in the PDF');
 // Larger than the statement limit: held for a full account review, never truncated.
 const statements=require('../../src/accounting/agent-customer-statements'),limit=statements.LIMITS.rows;statements.LIMITS.rows=50;
 try{r=await f.request(...ASKED);assert.equal(r.held,true);assert.match(r.reason,/more than 50/);}finally{statements.LIMITS.rows=limit;}
 // The review page lists the requests at desktop and phone width.
 const page=await f.browser.get('/autopilot/reviews/customer-statements').expect(200);assert.match(page.text,/Statement requests/);assert.match(page.text,/Ask/);assert.match(page.text,/Stopped for you/);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 try{
  const base='http://127.0.0.1:'+server.address().port;
  for(const [width,height,phone] of [[1600,1000,false],[390,844,true]]){
   const tab=await chrome.newPage({viewport:{width,height},isMobile:phone,hasTouch:phone});
   await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
   await tab.goto(base+'/autopilot/reviews/customer-statements');assert(await tab.locator('[data-statement-requests]').isVisible());assert(await tab.getByRole('button',{name:'Dismiss'}).first().isVisible());
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scrolling at '+width);
   const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await tab.screenshot({path:path.join(folder,'statement-requests-'+width+'.png'),fullPage:true});
   if(phone){await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Dismiss'}).first().click()]);assert.match(await tab.locator('body').innerText(),/Dismissed/);}
   await tab.close();
  }
 }finally{await chrome.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await app.locals.sessionStore.close();}
});
