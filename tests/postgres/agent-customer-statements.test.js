'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

async function fixture(t,{currency='USD'}={}){
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
 await f.subscribe('growth');await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),old=require('../../src/accounting/customer-money').addDays(today.slice(0,7)+'-01',-1),connector=randomUUID();
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2,base_currency=$3 WHERE workspace_id=$1',[ctx.workspaceId,require('../../src/accounting/customer-money').addDays(old,-30),currency]);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at) VALUES($1,$2,$1,'Accounts mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'accounts-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'test-token'}));
 const statements=require('../../src/accounting/agent-customer-statements'),assistant=require('../../src/assistant/postgres-service'),outbound=require('../../src/connections/postgres-outbound-mail');
 const invoice=(amount='20.00',date=today,customerId='fixture-customer')=>require('../../src/accounting/postgres-manual-invoices').createCustomerInvoice(db,ctx,{customerId,description:'Recorded service',quantity:1,unitAmount:amount,issueDate:date,dueDate:today,idempotencyKey:randomUUID()});
 const facts=()=>statements.facts(db,ctx,'fixture-customer',connector,currency),prepare=()=>assistant.prepareAction(db,ctx,'Send this requested account statement',{action:'customer.statement',recordReference:'receiver@example.test',mailbox:connector,currency});
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}},deliver=p=>outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider});
 return {...f,today,old,connector,currency,invoice,facts,prepare,sent,provider,deliver,statements,assistant,outbound};
}
async function mission(f,p,extra={}){
 const {db,ctx}=f,plans=require('../../src/assistant/postgres-capability-plans'),{registry}=require('../../src/assistant/postgres-capability-registry');
 if(!await plans.missionForProposal(db,ctx.workspaceId,ctx.actorId,p.id)){
  const goal=await require('../../src/assistant/postgres-goal-store').create(db,ctx,'Send the requested customer statement then review financial permissions');
  await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',checkpoint=checkpoint||'{\"runtime\":\"codex-staging\"}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,goal.id]);
  const saved=await plans.save(db,ctx,'Send the requested customer statement then review financial permissions',randomUUID(),[{contract:registry.get('customer.statement'),args:{recordReference:p.payload.recordId,mailbox:f.connector,currency:f.currency},dependsOn:[]},{contract:registry.get('read.agent_review'),args:{agentJob:'financial-permissions'},dependsOn:[0]}],[{result:{status:'PREPARED',proposal:{id:p.id}}},{result:{status:'CLARIFY',reason:'dependency_waiting'}}]);
  await db.query('UPDATE stockchief_runtime.assistant_capability_plans SET goal_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,saved.id,goal.id]);
 }
 return f.assistant.executeMission(db,{...ctx,...extra},p.id,{provider:{name:'openai',model:'gpt-6.1-sol',complete:async()=>{throw Error('The statement uses its saved native steps.');}}});
}

test('requested statements reconcile posted account activity, credits and outstanding invoices without changing stock or money',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.invoice('10.00',f.old);const current=await f.invoice();
 await f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:current.id,amountMinor:300,currency:'USD',paymentDate:f.today,method:'BANK_TRANSFER',sourceKey:randomUUID(),idempotencyKey:randomUUID()});
 await require('../../src/accounting/postgres-ledger').post(db,ctx,{sourceKey:randomUUID(),currency:'USD',description:'Recorded account credit',lines:[{accountKey:'CASH',debitMinor:50},{accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:50,customerId:'fixture-customer'}]});
 let p=await f.facts();assert.equal(p.openingMinor,1000);assert.equal(p.balanceMinor,2650);assert.equal(p.outstandingMinor,2700);assert.equal(p.otherBalanceMinor,-50);assert.equal(p.entries.length,3);assert.equal(p.outstanding.length,2);assert.match(f.statements.compose(p).body,/-\$0.50/);
 const before=await f.balance(),payments=Number((await db.query('SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 for(const plan of ['starter','growth','pro','enterprise']){await f.subscribe(plan);if(plan==='starter'){await assert.rejects(f.prepare(),e=>e.code==='entitlement_required');await f.browser.get('/autopilot/reviews/customer-statements').expect(402);await assert.rejects(f.facts(),e=>e.code==='entitlement_required');}else{assert.equal((await f.prepare()).status,'PREPARED');await f.browser.get('/autopilot/reviews/customer-statements').expect(200);}}
 await f.subscribe('growth');const review=await f.browser.get('/autopilot/reviews/customer-statements').expect(200);
 const form=await f.browser.post('/autopilot/customer-statements/prepare').type('form').send({_csrf:f.csrf(review.text),customerReference:'receiver@example.test',connectorId:f.connector,currency:'USD'}).expect(303),id=form.headers.location.split('/').pop();
 const preview=await f.browser.get(form.headers.location).expect(200);assert.match(preview.text,/\$26.50/);assert.match(preview.text,/Opening account balance/);assert(!preview.text.includes('<dt>Source fingerprint</dt>'));
 const queued=await f.assistant.executeProposal(db,ctx,id);assert.equal(queued.result.status,'QUEUED');assert.equal(f.sent.length,0);await f.deliver(queued);await f.deliver(queued);assert.equal(f.sent.length,1);assert.match(f.sent[0].body,/Outstanding invoice total: \$27.00/);
 const repeated=await f.prepare(),replayed=await f.assistant.executeProposal(db,ctx,repeated.proposal.id);assert.equal(replayed.result.effectId,queued.result.effectId);assert.equal(replayed.result.replayed,true);assert.equal(replayed.result.communicationKind,'customer');await f.browser.get('/messages/'+replayed.result.communicationKind+'/'+replayed.result.communicationId).expect(200);
 assert.equal(await f.balance(),before);assert.equal(Number((await db.query('SELECT count(*) n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),payments);
});

test('Growth learns only confirmed individual statements and Pro and Custom retain the owner balance cap',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,training=require('../../src/autopilot/draft-authority');await f.invoice();
 const prepare=async()=>f.assistant.getProposal(db,ctx.workspaceId,(await f.prepare()).proposal.id);
 const first=await prepare();assert.equal(first.payload.needsStatementConfirmation,true);await assert.rejects(mission(f,first),/own confirmation|entitlement/);
 const manual=await f.assistant.executeProposal(db,ctx,first.id);assert.equal((await training.settings(db,ctx,first.id)).canTeach,false);await assert.rejects(training.save(db,ctx,first.id,{mode:'save',revision:0,maximum:'25.00'}),/Complete a reviewed example/);
 await f.deliver(manual);assert.equal((await training.settings(db,ctx,first.id)).canTeach,true);await training.save(db,ctx,first.id,{mode:'save',revision:0,maximum:'25.00'});
 await f.invoice('1.00');let p=await prepare();assert.equal(p.payload.needsStatementConfirmation,false);
 await require('../../src/autopilot/postgres-service').pause(db,ctx,{role:'owner'},'Hold requested statements');await assert.rejects(mission(f,p),/paused/);await require('../../src/autopilot/postgres-service').resume(db,ctx,{role:'owner'});
 await require('../../src/autopilot/job-modes').save(db,ctx,81,{mode:'ask',revision:0});await assert.rejects(mission(f,p),/Ask me first/);await require('../../src/autopilot/job-modes').save(db,ctx,81,{mode:'inherit',revision:1});
 await mission(f,p);let executed=await f.assistant.getProposal(db,ctx.workspaceId,p.id);await f.deliver(executed);assert.equal(f.sent.length,2);assert.equal((await training.settings(db,ctx,p.id)).canTeach,false);assert.equal((await training.settings(db,ctx,first.id,'25.00')).preview.total,1);
 await f.invoice('10.00');p=await prepare();for(const tier of ['growth','pro','enterprise']){await f.subscribe(tier);await assert.rejects(mission(f,p,{agentCustomerStatementScope:'individual'}),e=>e.code==='entitlement_required'||/statement rule/.test(e.message));}
 await f.assistant.executeProposal(db,ctx,p.id);await f.deliver(await f.assistant.getProposal(db,ctx.workspaceId,p.id));assert.equal(f.sent.length,3);
 await training.save(db,ctx,first.id,{mode:'remove',revision:1});for(const tier of ['pro','enterprise']){await f.subscribe(tier);await f.invoice('1.00');p=await prepare();const before=f.sent.length;await mission(f,p);await f.deliver(await f.assistant.getProposal(db,ctx.workspaceId,p.id));assert.equal(f.sent.length,before+1,tier+' sends a requested statement for a known customer without requiring a Growth teaching rule.');}
});

test('payments, plan changes, mailbox state and current owner authority stop stale statements at the provider boundary',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,invoice=await f.invoice();
 const queue=async()=>f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);
 let p=await queue();await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider:f.provider,beforeSend:async()=>f.workflows.recordCustomerPayment(db,ctx,{customerId:'fixture-customer',customerInvoiceId:invoice.id,amountMinor:200,currency:'USD',paymentDate:f.today,method:'BANK_TRANSFER',sourceKey:randomUUID(),idempotencyKey:randomUUID()})}),/changed/);assert.equal(f.sent.length,0);
 p=await queue();await f.subscribe('starter');await assert.rejects(f.deliver(p),e=>e.code==='entitlement_required');await f.subscribe('growth');assert.equal(f.sent.length,0);
 await f.invoice('1.00');p=await queue();await db.query("UPDATE workspace_connectors SET paused_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,f.connector]);await assert.rejects(f.deliver(p),/mailbox|paused|connection/i);assert.equal(f.sent.length,0);await db.query('UPDATE workspace_connectors SET paused_at=NULL WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.connector]);
 await f.invoice('1.00');p=await queue();await db.query("UPDATE customers SET email='changed@example.test' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);await assert.rejects(f.deliver(p),/changed/);assert.equal(f.sent.length,0);await db.query("UPDATE customers SET email='receiver@example.test' WHERE workspace_id=$1 AND id='fixture-customer'",[ctx.workspaceId]);
 await f.invoice('1.00');p=await queue();await require('../../src/autopilot/job-modes').save(db,ctx,81,{mode:'watch',revision:0});await assert.rejects(f.deliver(p),/watch/i);assert.equal(f.sent.length,0);await require('../../src/autopilot/job-modes').save(db,ctx,81,{mode:'inherit',revision:1});
 await f.invoice('1.00');p=await queue();await db.query("UPDATE users SET role='clerk' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(f.deliver(p),/owner/);await f.browser.get('/autopilot/reviews/customer-statements').expect(403);assert.equal(f.sent.length,0);
 await assert.rejects(f.statements.facts(db,{...ctx,workspaceId:'foreign'},'fixture-customer',f.connector,'USD'),/owner/);
});

test('currency units, net customer credits and strict customer selection stay exact and separate',{timeout:240000},async t=>{
 for(const currency of ['JPY','KWD']){
  await t.test(currency,async t=>{const f=await fixture(t,{currency}),{db,ctx}=f,amount=currency==='JPY'?'123':'1.001',minor=currency==='JPY'?123:1001;await f.invoice(amount);const p=await f.facts();assert.equal(p.balanceMinor,minor);assert.equal(p.outstandingMinor,minor);assert.match(f.statements.compose(p).body,new RegExp(require('../../src/domain/currency').format(minor,currency).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   await require('../../src/accounting/postgres-ledger').post(db,ctx,{sourceKey:randomUUID(),currency,description:'Additional recorded credit',lines:[{accountKey:'CASH',debitMinor:minor+1},{accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:minor+1,customerId:'fixture-customer'}]});
   const credit=await f.facts();assert.equal(credit.balanceMinor,-1);assert.equal(credit.otherBalanceMinor,-minor-1);assert.match(f.statements.compose(credit).body,/\(credit\)/);
   const proposed=await f.prepare(),queued=await f.assistant.executeProposal(db,ctx,proposed.proposal.id);await f.deliver(queued);assert.equal(f.sent.length,1);
   await assert.rejects(f.statements.facts(db,ctx,'fixture-customer',f.connector,'USD'),/no recorded receivables/);
   await require('../../src/operations/postgres-commerce').createCustomer(db,ctx,{name:'receiver@example.test',email:'different@example.test'});
   await assert.rejects(f.assistant.prepareAction(db,ctx,'Send a statement',{action:'customer.statement',recordReference:'receiver@example.test',mailbox:f.connector,currency}),/one exact active customer/);
  });
 }
});

test('the real phone form previews one requested statement and returns a usable customer record',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.invoice();
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),origin='http://127.0.0.1:'+server.address().port;
 await page.goto(origin+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await page.goto(origin+'/autopilot/reviews/customer-statements');await page.locator('form[action$=prepare]').getByLabel('Exact customer name or email').fill('receiver@example.test');await page.getByLabel('Currency',{exact:true}).fill('USD');await Promise.all([page.waitForURL(/\/actions\//),page.getByRole('button',{name:'Preview account statement',exact:true}).click()]);
 assert.match(await page.locator('body').innerText(),/\$20.00/);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const path=require('node:path'),folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});await page.screenshot({path:path.join(folder,'customer-statement-phone.png'),fullPage:true});
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Approve only this change',exact:true}).click()]);
 const communication=(await db.query("SELECT m.id,e.id effect_id FROM customer_communications m JOIN stockchief_runtime.provider_effects e ON e.workspace_id=m.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' WHERE m.workspace_id=$1 AND e.payload->'standingAuthority'->>'kind'='customer_statement'",[ctx.workspaceId])).rows;assert.equal(communication.length,1);await f.outbound.executeSendEffect(db,ctx.workspaceId,communication[0].effect_id,{provider:f.provider});assert.equal(f.sent.length,1);
 await f.browser.get('/sales/customers/fixture-customer').expect(200);
});

test('an unrelated posted journal cannot evidence an invoice and offsetting credits cannot hide a larger statement value',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,invoice=await f.invoice(),ledger=require('../../src/accounting/postgres-ledger');
 const original=(await db.query('SELECT journal_entry_id FROM accounting_customer_invoices WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,invoice.id])).rows[0].journal_entry_id;
 const unrelated=await ledger.post(db,ctx,{sourceKey:randomUUID(),currency:'USD',description:'Unrelated recorded expense',lines:[{accountKey:'OPERATING_EXPENSE',debitMinor:100},{accountKey:'CASH',creditMinor:100}]});
 await db.query('UPDATE accounting_customer_invoices SET journal_entry_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,invoice.id,unrelated.entry.id]);await assert.rejects(f.facts(),/does not match its current posted customer receivable/);
 await db.query('UPDATE accounting_customer_invoices SET journal_entry_id=$3 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,invoice.id,original]);assert.equal((await f.facts()).balanceMinor,2000);
 const queued=await f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);await f.deliver(queued);await require('../../src/autopilot/draft-authority').save(db,ctx,queued.id,{mode:'save',revision:0,maximum:'25.00'});
 await f.invoice('100.00');await ledger.post(db,ctx,{sourceKey:randomUUID(),currency:'USD',description:'Recorded offsetting account credit',lines:[{accountKey:'CASH',debitMinor:10000},{accountKey:'ACCOUNTS_RECEIVABLE',creditMinor:10000,customerId:'fixture-customer'}]});
 const proposal=await f.assistant.getProposal(db,ctx.workspaceId,(await f.prepare()).proposal.id);assert.equal(proposal.payload.balanceMinor,2000);assert.equal(proposal.payload.outstandingMinor,12000);assert.equal(proposal.payload.training.amountMinor,12000);
 await f.subscribe('enterprise');await assert.rejects(mission(f,proposal),/statement rule/);const preview=await f.browser.get('/actions/'+proposal.id).expect(200);assert.match(preview.text,/saved \$25.00 limit/);assert.match(preview.text,/<button[^>]*disabled[^>]*>Approve all remaining changes/);
 const forged={...proposal.payload,actorId:ctx.actorId,automatic:true,training:{...proposal.payload.training,amountMinor:1}};await assert.rejects(f.statements.authority(db,ctx.workspaceId,forged),/changed/);assert.equal(f.sent.length,1);
});

test('statement time savings count confirmed delivery once and use only owner-recorded timings',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f,roi=require('../../src/autopilot/time-saved');await f.invoice();const read=async()=>(await roi.report(db,ctx)).rows.find(r=>r.key==='customer-statement');
 let p=await f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);assert.equal((await read()).count,0);assert.equal((await read()).minutes,null);
 await f.deliver(p);assert.equal((await read()).count,1);assert.equal((await read()).minutes,null);
 await roi.sample(db,ctx,{activity:'customer-statement',manualMinutes:'8',reviewMinutes:'1',requestKey:randomUUID()});assert.equal((await read()).minutes,7);
 const replay=await f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);await f.deliver(replay);assert.equal((await read()).count,1);assert.equal((await read()).minutes,7);
 await f.invoice('1.00');p=await f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);let calls=0;const lost={send:async()=>{calls++;throw Error('Mailbox acceptance response lost');}};
 await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider:lost}),e=>e.code==='email_send_ambiguous');await f.outbound.executeSendEffect(db,ctx.workspaceId,p.result.effectId,{provider:lost}).catch(()=>{});assert.equal(calls,1);assert.equal((await read()).count,1);assert.equal((await read()).minutes,7);assert.equal((await require('../../src/autopilot/draft-authority').settings(db,ctx,p.id)).canTeach,false);
});

test('accounts over the statement limit are held instead of emailing a truncated statement',{timeout:240000},async t=>{
 const f=await fixture(t),limit=f.statements.LIMITS.rows;for(let i=0;i<101;i++)await f.invoice('1.00');
 assert.equal((await f.facts()).outstanding.length,101,'The PDF carries every row, so 101 invoices are within the statement limit.');
 f.statements.LIMITS.rows=100;try{await assert.rejects(f.facts(),/more than 100/);await assert.rejects(f.prepare(),/more than 100/);}finally{f.statements.LIMITS.rows=limit;}assert.equal(f.sent.length,0);
});

test('altered preview facts and a changed queued body cannot become customer statement authority',{timeout:240000},async t=>{
 const f=await fixture(t),{db,ctx}=f;await f.invoice();const p=await f.facts();
 const grant={...p,actorId:ctx.actorId,automatic:false};await assert.rejects(f.statements.authority(db,ctx.workspaceId,{...grant,balanceMinor:1}),/changed/);
 await assert.rejects(f.statements.authority(db,ctx.workspaceId,{...grant,entries:p.entries.map(r=>({...r,description:'Unreviewed replacement words'}))}),/changed/);
 await f.subscribe('enterprise');await assert.rejects(f.statements.authority(db,ctx.workspaceId,{...grant,automatic:true,needsStatementConfirmation:false}),/first customer statement individually/);
 const queued=await f.assistant.executeProposal(db,ctx,(await f.prepare()).proposal.id);await assert.rejects(f.outbound.executeSendEffect(db,ctx.workspaceId,queued.result.effectId,{provider:f.provider,beforeSend:()=>db.query("UPDATE customer_communications SET body='Unreviewed replacement words' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,queued.result.communicationId])}),/differs from its recorded account evidence/);assert.equal(f.sent.length,0);
});
