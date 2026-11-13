'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 201 is excluded on Starter and alone on Growth, Pro and Custom. Every
// automatic action StockChief takes counts toward its usual day: purchases,
// transfers and labels from their own records, and everything else (emails it
// sends on its own, prepared changes routines carry out, price and cost
// changes, delivery cost postings) recorded once as it happens. When today is
// far above a usual day it pauses all automatic work at once, opens an urgent
// Needs you item, emails the owner during that pause, and waits for the owner
// to review and resume. The resume is audited with what was reviewed.
test('unusual automatic volume or money pauses everything at once, tells the owner, and only the owner resumes after review',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  const breaker=require('../../src/autopilot/circuit-breaker'),auto=require('../../src/autopilot/postgres-service'),policy=require('../../src/commercial/agent-plan');
  const mail=require('../../src/connections/postgres-outbound-mail'),alerts=require('../../src/autopilot/agent-alerts'),needs=require('../../src/projections/postgres-service');
  const time=require('../../src/lib/business-time'),addDays=require('../../src/accounting/customer-money').addDays;
  await db.query("UPDATE accounts SET created_at=(now()-interval '60 days')::text WHERE id=$1",[f.owner.accountId]);
  const {calendarDate:today,timeZone}=await time.forWorkspace(db,ws),noon=n=>time.wall(addDays(today,n),12,0,timeZone).toISOString();
  const count=async(sql,args=[])=>Number((await db.query(sql,[ws,...args])).rows[0].n);
  const audits=action=>count('SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[action]);
  const paused=async()=>(await auto.getState(db,ws)).paused;
  const refresh=()=>db.transaction(c=>breaker.refresh(c,ws));
  const notice=async actor=>(await needs.needs(db,ws,actor)).find(n=>n.sourceId==='agent-notice-201');
  const worker=()=>db.transaction(c=>require('../../src/operations/postgres-runtime-handlers').autopilotEvaluate({id:randomUUID(),workspaceId:ws,payload:{actorId:ctx.actorId,requestedByUser:true}},c));

  // A connected mailbox: StockChief's own supplier and customer emails, and the alert email.
  const connector=randomUUID();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
    VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
  await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
  let sent=0;
  const email=(grant={kind:'supplier_forecast',automatic:true})=>db.transaction(c=>mail.queueInTransaction(c,ctx,{recipientKind:'address',
    recipientEmail:'buyer'+(++sent)+'@example.test',connectorId:connector,subject:'Weekly forecast '+sent,body:'Your weekly forecast.',standingAuthority:grant},'automatic-mail:'+sent));
  const recorded=()=>count("SELECT count(*)::int n FROM stockchief_runtime.agent_automatic_actions WHERE workspace_id=$1 AND at>=$2::timestamptz",[time.dayBoundary(today,timeZone)]);

  // The usual day: two automatic emails and a $10.00 delivery cost posting on each of four earlier days.
  for(const n of [-4,-3,-2,-1]){
    for(const i of [1,2])await db.query(`INSERT INTO stockchief_runtime.agent_automatic_actions(workspace_id,action_key,kind,at) VALUES($1,$2,'email',$3)`,[ws,'history:'+n+':'+i,noon(n)]);
    await db.query(`INSERT INTO stockchief_runtime.agent_automatic_actions(workspace_id,action_key,kind,at,currency,amount_minor) VALUES($1,$2,'landed_cost',$3,'USD',1000)`,[ws,'history:'+n+':cost',noon(n)]);
  }
  assert.deepEqual(['landed_cost.apply','catalog.set_purchase_cost','inventory.adjust','inventory.transfer','sales_order.create','customer_credit.prepare','customer_return.refund'].map(breaker.kindOf),
    ['landed_cost','price','stock','transfer','sale','credit','credit'],'Prepared changes are counted by what they do.');

  // Emails a person approved, and alert emails to the owner, are not automatic work.
  await email({kind:'supplier_forecast',automatic:false});await email({kind:'purchase_followup',manual:true});
  assert.equal(await recorded(),0);
  await auto.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');

  // Starter: excluded, with the plan lock. Today's five emails are recorded but nothing pauses.
  await subscribe('starter');
  for(let i=0;i<5;i++)await email();
  assert.equal(await recorded(),5);
  await refresh();assert.equal(await paused(),false);
  assert.match((await browser.get(breaker.path).expect(402)).text,/Growth/);
  await assert.rejects(alerts.configure(db,ctx,201,{mailbox:connector}),e=>e.code==='entitlement_required');

  // Growth: the first 14 days and Watch only never pause; an owner's own pause is left alone.
  await subscribe('growth');
  await db.query("UPDATE accounts SET created_at=now()::text WHERE id=$1",[f.owner.accountId]);
  await refresh();assert.equal(await paused(),false,'Shadow mode only watches.');
  await db.query("UPDATE accounts SET created_at=(now()-interval '60 days')::text WHERE id=$1",[f.owner.accountId]);
  await auto.setMode(db,ctx,{role:'owner'},'OBSERVE');await refresh();assert.equal(await paused(),false,'Watch only does nothing automatic.');
  await auto.setMode(db,ctx,{role:'owner'},'SUPERVISED');
  await auto.pause(db,ctx,{role:'owner'},'Stock take');await refresh();
  assert.equal((await auto.getState(db,ws)).pausedReason,'Stock take');assert.equal(await audits('Paused unusual automatic activity'),0);
  await auto.resume(db,ctx,{role:'owner'});
  const page=await browser.get(breaker.path).expect(200);
  assert.match(page.text,/Automatic work is running/);assert.match(page.text,/How you get these alerts/);
  await browser.post('/autopilot/alerts/201').type('form').send({_csrf:f.csrf(page.text),revision:0,mailbox:connector}).expect(303);

  // The sixth automatic email of the day (a usual day has two) pauses at once.
  await email();
  assert.equal(await paused(),true);
  const reason=(await auto.getState(db,ws)).pausedReason;
  assert.match(reason,/^Unusual automatic activity today\. 6 automatic emails to suppliers and customers is above the usual daily range/);
  assert.equal(await audits('Paused unusual automatic activity'),1);
  const pausedAudit=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Paused unusual automatic activity'",[ws])).rows[0].after_state;
  assert.deepEqual(pausedAudit.evidence.find(e=>e.measure==='Emails to suppliers and customers'),{measure:'Emails to suppliers and customers',today:6,usual:2,pausesAbove:4});
  // Everything automatic stops: every job checks the same pause.
  const state=await policy.accountState(db,ws);
  assert.match(await policy.stopped(db,ws,state,'communication.send_email',true),/paused/);
  assert.match(await policy.stopped(db,ws,state,'alert.unusual_activity',true),/paused/);
  // Needs you, for the owner only.
  const item=await notice(ctx.actorId);
  assert.deepEqual([item.importance,item.title,item.href,item.actionLabel],['Urgent','StockChief paused its automatic work',breaker.path,'Review and resume']);
  const auth=require('../../src/domain/postgres-auth-service'),P=require('../../src/actions/permissions');
  const staffAccount=await auth.createBusiness(db,{name:'Buyer',businessName:'Buyer elsewhere',email:randomUUID()+'@example.test',password:f.password});
  const staff={workspaceId:ws,actorId:'staff-'+randomUUID()};
  await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Buyer','staff',$4,now()::text)`,[staff.actorId,ws,staffAccount.accountId,P.encodeGrant([P.VIEW,P.VIEW_PURCHASING,P.APPROVE_PO,P.OPERATE])]);
  assert.equal(await notice(staff.actorId),undefined);
  // The alert email went out at once, during the pause it reports.
  const delivery=(await db.query('SELECT email_communication_id AS id FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=201',[ws])).rows;
  assert.equal(delivery.length,1);assert.ok(delivery[0].id);
  const effect=(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,delivery[0].id])).rows[0].id;
  const messages=[],provider={send:async({message})=>{messages.push(message);return {externalMessageId:'accepted-'+message.id};}};
  await mail.executeSendEffect(db,ws,effect,{provider});
  assert.equal(messages[0].recipient,f.email);assert.equal(messages[0].subject,'StockChief paused its automatic work');
  assert.match(messages[0].body,/Nothing automatic runs until you review it and resume/);assert.match(messages[0].body,/6 automatic emails to suppliers and customers/);
  assert.equal(await recorded(),6,'The alert email is not counted as automatic work.');

  // Replays change nothing: one pause, one item, one email, and the routine check keeps the item open.
  await refresh();await worker();await worker();
  assert.equal(await audits('Paused unusual automatic activity'),1);
  assert.equal(await count('SELECT count(*)::int n FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=201 AND NOT resolved'),1);
  assert.equal(await count('SELECT count(*)::int n FROM stockchief_runtime.agent_alert_deliveries WHERE workspace_id=$1 AND job_id=201'),1);
  assert.equal(await audits('Alert email queued'),1);
  assert.ok(await notice(ctx.actorId));

  // The review page shows today against a usual day, and the resume form.
  const review=await browser.get(breaker.path).expect(200);
  assert.match(review.text,/Automatic work is paused/);assert.match(review.text,/Resume automatic work/);assert.match(review.text,/Emails to suppliers and customers/);
  // Only the owner resumes, and only after confirming the review (PDF page 13).
  await assert.rejects(breaker.resume(db,staff,{reviewed:'yes'}),/owner/);
  await assert.rejects(auto.resume(db,staff,{role:'staff',permissions:P.encodeGrant([P.VIEW,P.OPERATE])}),/owner/);
  await assert.rejects(breaker.resume(db,ctx,{}),/Confirm you reviewed/);
  await browser.post('/autopilot/circuit-breaker/resume').type('form').send({_csrf:f.csrf(review.text),reviewed:'yes',note:'The weekly forecasts went out early.'}).expect(303);
  assert.equal(await paused(),false);
  const resumed=(await db.query("SELECT actor_id,before_state,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Reviewed unusual automatic activity and resumed'",[ws])).rows;
  assert.equal(resumed.length,1);assert.equal(resumed[0].actor_id,ctx.actorId);assert.match(resumed[0].before_state.reason,/6 automatic emails/);
  assert.equal(resumed[0].after_state.note,'The weekly forecasts went out early.');
  assert.deepEqual(resumed[0].after_state.reviewed.find(e=>e.measure==='Actions'),{measure:'Actions',today:6,usual:3,pausesAbove:6});
  assert.equal(await notice(ctx.actorId),undefined,'The item closes with the resume.');
  await assert.rejects(breaker.resume(db,ctx,{reviewed:'yes'}),/not paused/);
  // What the owner reviewed no longer counts toward today.
  assert.deepEqual(await breaker.observations(db,ws),[]);
  await email();assert.equal(await paused(),false);

  // Money: a $500.00 delivery cost posting against a usual $10.00 pauses; another currency has no usual day yet.
  await db.transaction(c=>breaker.note(c,ws,{key:'eur-cost',kind:'landed_cost',reference:'EUR bill',amountMinor:90000,currency:'EUR'}));
  assert.equal(await paused(),false);
  await db.transaction(c=>breaker.note(c,ws,{key:'big-cost',kind:'landed_cost',reference:'Freight bill',amountMinor:50000,currency:'USD'}));
  assert.equal(await paused(),true);assert.match((await auto.getState(db,ws)).pausedReason,/\$500\.00 committed/);
  assert.equal(await db.transaction(c=>breaker.note(c,ws,{key:'big-cost',kind:'landed_cost',amountMinor:50000,currency:'USD'})),false,'The same action is recorded once.');
  await breaker.resume(db,ctx,{reviewed:'yes'});

  // Pro and Custom pause the same way.
  for(const tier of ['pro','enterprise']){
    await subscribe(tier);
    let n=0;while(!(await paused())&&n<10){await email();n++;}
    assert.equal(await paused(),true,tier);assert.equal(n,5,tier+': the fifth email after the last review is above four.');
    assert.ok(await notice(ctx.actorId),tier);
    await breaker.resume(db,ctx,{reviewed:'yes'});assert.equal(await paused(),false,tier);
  }
  assert.equal(await audits('Reviewed unusual automatic activity and resumed'),4);

  // The page reads well on a desktop and on a 390 px phone.
  await email();for(let i=0;i<5&&!(await paused());i++)await email();
  assert.equal(await paused(),true);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+server.address().port;
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+breaker.path);
    assert(await tab.getByRole('heading',{name:'Review unusual automatic activity',exact:true}).isVisible(),name);
    assert(await tab.getByRole('button',{name:'Resume automatic work'}).isVisible(),name);
    assert(await tab.getByLabel('I reviewed today’s automatic work below').isVisible(),name);
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.goto(base+'/needs-you');
    assert(await tab.getByText('StockChief paused its automatic work').first().isVisible(),name);
    await tab.close();
  }
});
