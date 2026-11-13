'use strict';
process.env.NODE_ENV='test';
process.env.FOUNDRY_PUBLIC_URL='https://stockchief.test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Jobs 155 and 156 are alone on every plan. Scheduled reports are emailed by
// the worker from the mailbox the owner chose, to the people chosen on the
// report, with the report attached; the daily briefing shows in Needs you and
// is emailed at the owner's chosen time. Both wait during the first 14 days,
// pause and Ask me first (where the owner presses send), stop and ask when no
// mailbox was chosen or a person left, audit every send and send each slot once.
test('scheduled reports and the daily briefing are emailed on their own from the chosen mailbox to the chosen people',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,subscribe,csrf}=f,ws=ctx.workspaceId;
 const reports=require('../../src/reports/postgres-service'),scheduling=require('../../src/reports/postgres-scheduling'),mail=require('../../src/reports/agent-report-email');
 const briefing=require('../../src/autopilot/briefing-email'),briefs=require('../../src/autopilot/daily-briefs'),needs=require('../../src/projections/postgres-service');
 const modes=require('../../src/autopilot/job-modes'),autopilot=require('../../src/autopilot/postgres-service'),outbox=require('../../src/connections/postgres-outbound-mail');
 const policy=require('../../src/commercial/agent-plan'),time=require('../../src/lib/business-time'),{addDays}=require('../../src/accounting/customer-money');
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{});
 const audits=async action=>Number((await db.query('SELECT count(*) FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action])).rows[0].count);
 const count=async(sql,args=[ws])=>Number((await db.query(sql,args)).rows[0].count);
 const owner={role:'owner',permissions:null,email:f.email};
 const age=days=>db.query("UPDATE accounts SET created_at=(now()-make_interval(days=>$2))::text WHERE id=$1",[f.owner.accountId,days]);
 const {timeZone:zone,calendarDate:today}=await time.forWorkspace(db,ws);

 // People in the business: Ana on the floor, and Ben who sees one warehouse only.
 const person=async(name,extra='NULL')=>{
  const home=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name,businessName:name+' home',email:name.toLowerCase()+'-'+randomUUID().slice(0,8)+'@example.test',password:f.password}),id=randomUUID();
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,$4,'staff',NULL,${extra},now()::text)`,[id,ws,home.accountId,name]);
  return {id,email:(await db.query('SELECT email FROM accounts WHERE id=$1',[home.accountId])).rows[0].email,accountId:home.accountId};
 };
 const ana=await person('Ana'),ben=await person('Ben',`'["${f.location.id}"]'`);
 const connect=async name=>{
  const id=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
   VALUES($1,$2,$1,$3,'gmail','[]','{}','connected','["MAIL_SEND"]',$4,'CONNECTED',$5,$1,$6,now(),now())`,[id,ws,name,'connection_credentials:'+id,ctx.actorId,name.toLowerCase().replace(/\s+/g,'-')+'@example.test']);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,id,'provider',{accessToken:'test-token'}));
  return id;
 };
 const sent=[],provider={send:async({message})=>{sent.push(message);return {externalMessageId:'accepted-'+message.id};}};
 const deliverAll=async()=>{
  const effects=(await db.query(`SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND kind='mail.outbound.send' AND status='PENDING' ORDER BY created_at,id`,[ws])).rows;
  const out=[];for(const e of effects){try{out.push(await outbox.executeSendEffect(db,ws,e.id,{provider}));}catch(error){out.push({error:error.message});}}
  await mail.settle(db,ws);return out;
 };

 // Accounts on older terms keep the plan card on the new page and the
 // earlier report form; nothing changes for them.
 const lockedPage=await browser.get(mail.path).expect(200);
 assert.match(lockedPage.text,/data-agent-plan-locked/);
 assert.doesNotMatch((await browser.get('/reports/builder?dataset=stock').expect(200)).text,/name="recipientsShown"/);

 // Starter, after the first 14 days. The owner schedules a report for
 // themselves and Ana, as an Excel file, from the report form.
 await subscribe('starter');await age(30);
 const builder=(await browser.get('/reports/builder?dataset=stock').expect(200)).text;
 assert.match(builder,/name="recipientsShown"/);assert.match(builder,/>Send to</);assert.match(builder,/ Ana</);assert.match(builder,/Choose the mailbox report emails are sent from|Connect a mailbox/);
 await browser.post('/reports/save').type('form').send({_csrf:csrf(builder),definition:JSON.stringify({dataset:'stock',title:'Daily stock',columns:['sku','on_hand'],sort:'sku'}),
  frequency:'daily',hour:'6',minute:'0',weekday:'1',timeZone:zone,recipientsShown:'1',recipients:[ctx.actorId,ana.id],attach:'xlsx'}).expect(303);
 let report=(await db.query("SELECT * FROM stockchief_runtime.report_templates WHERE workspace_id=$1 AND title='Daily stock'",[ws])).rows[0];
 assert.deepEqual(report.recipient_user_ids,[ctx.actorId,ana.id]);assert.equal(report.attachment_format,'xlsx');
 assert.equal(await audits('Report recipients saved'),1);
 // Ben sees one warehouse only and Ana may not see money reports: both are refused.
 await assert.rejects(mail.saveRecipients(db,ctx,{...report},{recipientsShown:true,recipients:[ctx.actorId,ben.id]}),/Ben may not see everything/);
 const anaRow=(await mail.people(db,ws)).find(p=>p.id===ana.id);
 assert.equal(mail.canSee(anaRow,{owner_user_id:ctx.actorId,definition:{dataset:'expenses',title:'Expenses',columns:['amount'],sort:'amount'}}),false);
 assert.equal(mail.canSee(anaRow,report),true);
 // Only the owner may send a report to other people.
 await assert.rejects(mail.saveRecipients(db,{workspaceId:ws,actorId:ana.id},{...report,owner_user_id:ana.id},{recipientsShown:true,recipients:[ana.id,ctx.actorId]}),/Only the owner/);

 const slot=async()=>{
  await db.query("UPDATE stockchief_runtime.report_templates SET next_send_at=clock_timestamp()-interval '1 second' WHERE id=$1",[report.id]);
  await scheduling.enqueueDue(db,new Date());
  const d=(await db.query('SELECT id FROM stockchief_runtime.report_deliveries WHERE workspace_id=$1 AND template_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ws,report.id])).rows[0];
  const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='report.generate-delivery' AND payload->>'deliveryId'=$2",[ws,d.id])).rows[0];
  const result=await handlers['report.generate-delivery']({id:job.id,workspaceId:ws,payload:job.payload},db);
  return {id:d.id,job,result,row:(await db.query('SELECT * FROM stockchief_runtime.report_deliveries WHERE id=$1',[d.id])).rows[0]};
 };

 // No mailbox connected: the slot waits and asks, and nothing is sent.
 let s=await slot();
 assert.equal(s.row.status,'HELD');assert.match(s.row.hold_reason,/Connect a mailbox/);
 // Two mailboxes and none chosen: it never picks one on its own.
 const shop=await connect('Shop mail'),other=await connect('Other mail');
 s=await slot();
 assert.match(s.row.hold_reason,/Choose the mailbox report emails are sent from\. StockChief never picks one on its own\./);
 assert.equal(await count('SELECT count(*) FROM customer_communications WHERE workspace_id=$1'),0);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.report_deliveries WHERE workspace_id=$1 AND template_id=$2 ORDER BY created_at LIMIT 1',[ws,report.id])).rows[0].status,'CANCELLED','A later slot replaces a waiting one.');
 let inbox=await needs.needs(db,ws,ctx.actorId);
 assert.equal(inbox.filter(n=>String(n.sourceId).startsWith('report-email:')).length,1);
 assert.equal(inbox.find(n=>String(n.sourceId).startsWith('report-email:')).title,'Report email waiting: Daily stock');
 assert.equal(await audits('Report email held'),2);

 // The owner chooses the mailbox on the Report emails page.
 let page=(await browser.get(mail.path).expect(200)).text;
 assert.match(page,/How reports are emailed/);assert.match(page,/Waiting for you/);
 await browser.post('/autopilot/report-emails/155').type('form').send({_csrf:csrf(page),mailbox:'not-a-mailbox',revision:'0'}).expect(r=>assert(r.status>=300));
 assert.equal((await mail.setting(db,ws,155))?.email_connector_id??null,null);
 await browser.post('/autopilot/report-emails/155').type('form').send({_csrf:csrf(page),mailbox:shop,revision:'0'}).expect(303);
 assert.equal((await mail.setting(db,ws,155)).email_connector_id,shop);
 assert.equal(await audits('Report email settings saved'),1);

 // The next slot goes on its own: one email each, from Shop mail, with the file.
 s=await slot();
 assert.equal(s.result.queued,2,JSON.stringify(s.result)+' '+s.row.hold_reason);
 const messages=(await db.query("SELECT recipient,subject,body,connector_id,approved_by_user_id FROM customer_communications WHERE workspace_id=$1 ORDER BY recipient",[ws])).rows;
 assert.deepEqual(messages.map(m=>m.recipient).sort(),[ana.email,f.email].sort());
 assert.ok(messages.every(m=>m.connector_id===shop&&m.subject==='StockChief report: Daily stock'&&m.approved_by_user_id===ctx.actorId));
 assert.match(messages.find(m=>m.recipient===f.email).body,/Open the saved report: https:\/\/stockchief\.test\/reports\/saved\//);
 assert.doesNotMatch(messages.find(m=>m.recipient===ana.email).body,/Open the saved report/,'Only the report owner gets the link to their private report.');
 await deliverAll();
 assert.equal(sent.length,2);
 for(const m of sent){
  assert.equal(m.attachments.length,1);assert.equal(m.attachments[0].contentType,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(m.attachments[0].filename,/^Daily-stock-\d{4}-\d{2}-\d{2}\.xlsx$/);assert.equal(m.attachments[0].content.readUInt32LE(0),0x04034b50);
  assert.match(m.body,/The full report is attached as an Excel file\./);
 }
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.report_deliveries WHERE id=$1',[s.id])).rows[0].status,'SENT');
 assert.ok((await reports.load(db,ctx,owner,report.id)).last_delivered_at);
 assert.equal(await audits('Report email queued'),1);
 // A replay of the same slot sends nothing twice.
 assert.equal((await handlers['report.generate-delivery']({id:s.job.id,workspaceId:ws,payload:s.job.payload},db)).skipped,'delivery_no_longer_pending');
 await scheduling.enqueueDue(db,new Date());await deliverAll();
 assert.equal(sent.length,2);assert.equal(await count('SELECT count(*) FROM customer_communications WHERE workspace_id=$1'),2);
 assert.equal((await needs.needs(db,ws,ctx.actorId)).filter(n=>String(n.sourceId).startsWith('report-email:')).length,0,'A sent slot replaces the waiting one in Needs you.');

 // As a PDF instead.
 await db.query("UPDATE stockchief_runtime.report_templates SET attachment_format='pdf' WHERE id=$1",[report.id]);
 s=await slot();await deliverAll();
 assert.equal(sent.at(-1).attachments[0].contentType,'application/pdf');assert.equal(sent.at(-1).attachments[0].content.subarray(0,5).toString(),'%PDF-');

 // Paused: the slot waits; the owner can still send it.
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');
 s=await slot();assert.equal(s.row.status,'HELD');assert.match(s.row.hold_reason,/paused/);
 page=(await browser.get(mail.path).expect(200)).text;assert.match(page,/Send it now/);
 await browser.post('/autopilot/report-emails/155/send').type('form').send({_csrf:csrf(page),deliveryId:s.id}).expect(303);
 assert.equal((await db.query('SELECT status,sent_by_owner FROM stockchief_runtime.report_deliveries WHERE id=$1',[s.id])).rows[0].sent_by_owner,true);
 await deliverAll();assert.equal(sent.length,6);
 await autopilot.resume(db,ctx,{role:'owner'});

 // Checked again before the mailbox sends: paused after queueing, nothing goes.
 await db.query("UPDATE stockchief_runtime.report_templates SET attachment_format='xlsx' WHERE id=$1",[report.id]);
 s=await slot();assert.equal(s.result.queued,2);
 await autopilot.pause(db,ctx,{role:'owner'},'Hold everything');
 const refused=await deliverAll();assert.ok(refused.every(r=>/paused/.test(r.error||'')));assert.equal(sent.length,6);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.report_deliveries WHERE id=$1',[s.id])).rows[0].status,'FAILED');
 await autopilot.resume(db,ctx,{role:'owner'});

 // Ask me first: the slot waits in Needs you until the owner presses send.
 await modes.save(db,ctx,155,{mode:'ask',revision:0});
 s=await slot();assert.match(s.row.hold_reason,/Ask me first/);
 inbox=await needs.needs(db,ws,ctx.actorId);
 assert.match(inbox.find(n=>n.sourceId==='report-email:'+s.id).recommendation,/Send it/);
 await mail.sendHeld(db,ctx,s.id);await assert.rejects(mail.sendHeld(db,ctx,s.id),/no longer waiting/);
 await deliverAll();assert.equal(sent.length,8);
 assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===155).allowed,['inherit','watch','ask']);
 await modes.save(db,ctx,155,{mode:'inherit',revision:1});

 // A chosen person left: it stops and asks instead of guessing.
 await db.query("INSERT INTO platform_account_access(account_id,disabled_at,reason,changed_by) VALUES($1,now(),'Left the business',$2)",[ana.accountId,f.owner.accountId]);
 s=await slot();assert.match(s.row.hold_reason,/no longer in the business/);
 await db.query('UPDATE platform_account_access SET disabled_at=NULL WHERE account_id=$1',[ana.accountId]);

 // The first 14 days: it waits and the owner cannot send it either.
 await age(0);
 s=await slot();assert.match(s.row.hold_reason,/first 14 days/);
 await assert.rejects(mail.sendHeld(db,ctx,s.id),/first 14 days/);
 await age(30);

 // Growth, Pro and Custom send on their own too.
 for(const tier of ['growth','pro','enterprise']){
  await subscribe(tier);const before=sent.length;
  s=await slot();assert.ok(s.result.queued>=1,tier);await deliverAll();assert.ok(sent.length>before,tier);
  assert.equal(policy.allowance((await policy.accountState(db,ws)).plan,155),'alone');
 }

 // Job 156. The routine check writes yesterday's briefing and gives the
 // business its default time; nothing is emailed without a chosen mailbox.
 await subscribe('starter');
 await briefs.deliver(db,ws,await policy.accountState(db,ws));
 let settings=await mail.setting(db,ws,156);
 assert.ok(settings.next_send_at);assert.equal(Number(settings.send_hour),7);
 await require('../../src/domain/postgres-inventory-engine').adjust(db,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,countedQuantity:18,reasonCode:'cycle_count',idempotencyKey:randomUUID()});
 const due=async when=>{
  await db.query("UPDATE stockchief_runtime.agent_report_email_settings SET next_send_at=$2 WHERE workspace_id=$1 AND job_id=156",[ws,when.toISOString()]);
  await briefing.enqueueDue(db,when);
  const job=(await db.query("SELECT * FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='agent.briefing-delivery' AND payload->>'slotAt'=$2",[ws,when.toISOString()])).rows[0];
  assert.ok(job,'the sweep queues the briefing at its time');
  return handlers['agent.briefing-delivery']({id:job.id,workspaceId:ws,payload:job.payload},db);
 };
 const at=(days,hour=7,minute=0)=>time.wall(addDays(today,days),hour,minute,zone);
 let b=await due(at(1));
 assert.equal(b.day,today);assert.match(b.held,/Choose the mailbox the briefing is sent from\. StockChief never picks one on its own\./);
 assert.ok(new Date((await mail.setting(db,ws,156)).next_send_at)>at(1),'the next time moves on');
 let item=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='daily-briefing:'+today);
 assert.equal(item.title,'Your daily briefing');assert.equal(item.href,briefing.path+'?filter='+today);assert.match(item.happened,/The email is waiting/);
 assert.equal((await briefing.run(db,ws,{slotAt:at(1).toISOString()})).replayed,true);
 assert.equal(await audits('Daily briefing delivered'),1);

 // The owner chooses the mailbox, Ana and the owner, and 8:30 Monday to Friday.
 page=(await browser.get(briefing.path+'?filter='+today).expect(200)).text;
 assert.match(page,/How you get the briefing/);assert.match(page,/Count adjustments/);
 await browser.post('/autopilot/report-emails/156').type('form').send({_csrf:csrf(page),revision:'0',mailbox:other,recipientsShown:'1',recipients:[]}).expect(r=>assert(r.status>=300));
 await browser.post('/autopilot/report-emails/156').type('form').send({_csrf:csrf(page),revision:String((await mail.setting(db,ws,156)).revision),mailbox:other,recipientsShown:'1',recipients:[ctx.actorId,ana.id],hour:'8',minute:'30',days:'weekdays'}).expect(303);
 settings=await mail.setting(db,ws,156);
 assert.deepEqual([settings.email_connector_id,settings.recipient_user_ids,Number(settings.send_hour),Number(settings.send_minute),settings.send_days],[other,[ctx.actorId,ana.id],8,30,'weekdays']);
 assert.notEqual([0,6].includes(new Date(time.context(zone,new Date(settings.next_send_at)).calendarDate+'T12:00:00Z').getUTCDay()),true,'Monday to Friday skips the weekend');
 assert.equal(await audits('Briefing settings saved'),1);
 // The owner sends the waiting briefing; each person gets their own Needs you list.
 page=(await browser.get(briefing.path).expect(200)).text;assert.match(page,/Email the briefing now/);
 await browser.post('/autopilot/report-emails/156/send').type('form').send({_csrf:csrf(page)}).expect(303);
 const before=sent.length;await deliverAll();
 const letters=sent.slice(before);
 assert.deepEqual(letters.map(m=>m.recipient).sort(),[ana.email,f.email].sort());
 for(const m of letters){assert.equal(m.subject,'Your StockChief briefing for '+today);assert.match(m.body,/What happened on /);assert.match(m.body,/- Count adjustments: \d+/);assert.match(m.body,/What needs you now:/);}
 assert.match(letters.find(m=>m.recipient===f.email).body,/Read the briefing: https:\/\/stockchief\.test\/autopilot\/reviews\/daily-briefing\?filter=/);
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.agent_briefing_deliveries WHERE workspace_id=$1 AND report_date=$2',[ws,today])).rows[0].status,'SENT');
 assert.match((await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='daily-briefing:'+today).happened,/It was emailed to 2 people/);

 // Two days on, the briefing goes on its own and covers the day it missed.
 b=await due(at(3,8,30));
 assert.equal(b.from,addDays(today,1));assert.equal(b.day,addDays(today,2));assert.equal(b.emailed,2);
 await deliverAll();assert.equal(sent.length,before+4);assert.equal(sent.at(-1).subject,'Your StockChief briefing for '+addDays(today,1)+' to '+addDays(today,2));
 assert.equal((await due(at(3,8,30))).replayed,true);
 assert.equal(sent.length,before+4,'a replay sends nothing twice');

 // Pause, Ask me first and the first 14 days hold the email; the briefing still shows.
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');
 b=await due(at(4,8,30));assert.match(b.held,/paused/);
 assert.match((await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='daily-briefing:'+b.day).happened,/The email is waiting: Automatic work is paused/);
 await briefing.sendNow(db,ctx);await deliverAll();assert.equal(sent.length,before+6);
 await autopilot.resume(db,ctx,{role:'owner'});
 await modes.save(db,ctx,156,{mode:'ask',revision:0});
 b=await due(at(5,8,30));assert.match(b.held,/Ask me first/);
 assert.equal((await briefing.panel(db,ctx)).canSend,true);
 await modes.save(db,ctx,156,{mode:'inherit',revision:1});
 await age(0);
 b=await due(at(6,8,30));assert.match(b.held,/first 14 days/);
 await assert.rejects(briefing.sendNow(db,ctx),/first 14 days/);
 await age(30);
 // Checked again before the mailbox sends: a changed mailbox stops it.
 b=await due(at(7,8,30));assert.equal(b.emailed,2);
 await mail.configure(db,ctx,156,{mailbox:shop,revision:String((await mail.setting(db,ws,156)).revision)});
 assert.ok((await deliverAll()).every(r=>/mailbox for the briefing changed/.test(r.error||'')));
 assert.equal((await db.query('SELECT status FROM stockchief_runtime.agent_briefing_deliveries WHERE workspace_id=$1 AND report_date=$2',[ws,b.day])).rows[0].status,'FAILED');

 // Monday to Friday: Friday's next time is Monday.
 const friday=new Date('2026-11-13T10:00:00Z');
 assert.equal(briefing.slotAfter({send_days:'weekdays',send_hour:8,send_minute:30},'UTC',friday).toISOString(),'2026-11-16T08:30:00.000Z');
 assert.equal(briefing.slotAfter({send_days:'daily',send_hour:8,send_minute:30},'UTC',friday).toISOString(),'2026-11-14T08:30:00.000Z');

 // Growth, Pro and Custom deliver it on their own too.
 let ahead=8;
 for(const tier of ['growth','pro','enterprise']){
  await subscribe(tier);const n=sent.length;
  b=await due(at(ahead++,8,30));assert.equal(b.emailed,2,tier);await deliverAll();assert.equal(sent.length,n+2,tier);
 }
 assert.ok(await audits('Daily briefing delivered')>=8);

 // The pages read well on a desktop and on a 390 px phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const [file,href,heading] of [['report-emails',mail.path,'How reports are emailed'],['daily-briefing',briefing.path,'How you get the briefing'],['report-schedule','/reports/saved/'+report.id,'Delivery']]){
   await tab.goto(base+href);
   assert(await tab.getByRole('heading',{name:heading,exact:true}).isVisible(),file+' '+name);
   assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),file+' '+name+' must not scroll sideways');
   await tab.screenshot({path:require('node:path').join(folder,file+'-'+name+'.png'),fullPage:true});
  }
  await tab.close();
 }
});
