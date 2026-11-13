'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{randomUUID}=crypto;
const request=require('supertest');

// Job 188: staff and owners ask StockChief in Microsoft Teams or WhatsApp (Slack
// has its own test, agent-slack.test.js). The sender is matched to their own
// StockChief membership, the answer uses that person's permissions (a role
// without cost access never gets costs, job 203), the owner can read agent
// reviews through Ask's read.agent_review, a change request only links back to
// the app, and every answer is audited. Starter and Growth are excluded; Pro and
// Custom answer alone inside pause, Watch only, Ask me first and the first 14
// days. Teams and WhatsApp are the test doubles of the real channels: their
// token and signature checks are real, their replies are recorded.
test('Teams and WhatsApp answer the linked person inside their permissions and the plan, change nothing and audit every answer',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20}),{db,ctx,browser,csrf}=f,ws=ctx.workspaceId;
 const chat=require('../../src/connections/chat-providers'),service=require('../../src/connections/agent-chat'),jobs=require('../../src/operations/postgres-job-queue');
 const P=require('../../src/actions/permissions'),autopilot=require('../../src/autopilot/postgres-service'),jobModes=require('../../src/autopilot/job-modes');
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Teams signs with a Bot Framework key; the test holds its own key pair.
 const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const tenant='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',app='11111111-2222-3333-4444-555555555555',service_='https://smba.trafficmanager.net/amer/';
 const teams=chat.fake('teams',{keys:[{...publicKey.export({format:'jwk'}),kid:'bot-key',endorsements:['msteams']}]});
 const twilio={sid:'AC'+'0'.repeat(32),token:'twilio-test-token',from:'+15550001000'},whatsapp=chat.fake('whatsapp',{settings:twilio});
 const restore=[chat.use('teams',teams),chat.use('whatsapp',whatsapp)];f.cleanup(()=>restore.forEach(r=>r()));
 const sign=(claims={})=>{const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);
  const head=enc({alg:'RS256',kid:'bot-key',typ:'JWT'}),body=enc({iss:chat.BOT_ISSUER,aud:app,exp:now+600,nbf:now-10,serviceurl:service_,...claims});
  return 'Bearer '+head+'.'+body+'.'+crypto.sign('RSA-SHA256',Buffer.from(head+'.'+body),privateKey).toString('base64url');};
 const ownerAad=randomUUID();let seq=0;
 const activity=(text,extra={})=>JSON.stringify({type:'message',id:'activity-'+(++seq),serviceUrl:service_,channelId:'msteams',from:{id:'29:owner',aadObjectId:ownerAad},
  conversation:{id:'a:owner-chat',conversationType:'personal'},channelData:{tenant:{id:tenant}},text,...extra});
 const publicApp=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});f.cleanup(()=>publicApp.locals.sessionStore.close());
 const outside=request(publicApp);
 let teamsPath=null;
 const toTeams=(body,auth=sign())=>outside.post(teamsPath).set('Authorization',auth).set('Content-Type','application/json').send(body);
 const toWhatsapp=(from,text,{token=twilio.token,sid='SM'+randomUUID().replaceAll('-','')}={})=>{
  const fields=new URLSearchParams({AccountSid:twilio.sid,From:'whatsapp:'+from,To:'whatsapp:'+twilio.from,Body:text,MessageSid:sid});
  return outside.post(service.publicPaths.whatsapp).set('Host','stockchief.test').set('Content-Type','application/x-www-form-urlencoded')
   .set('X-Twilio-Signature',chat.twilioSignature('http://stockchief.test'+service.publicPaths.whatsapp,fields,token)).send(fields.toString());};
 // The model is a test double; what it reads is chosen per question.
 let calls=0,plan=null;const usage={provider:'anthropic',providerVersion:'2023-06-01',model:'claude-haiku-4-5-20251001',inputTokens:600,outputTokens:150};
 const provider={name:'anthropic',model:usage.model,async complete(req){calls++;assert.equal(req.schemaName,'bounded_business_read');return {data:plan,usage};}};
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider});
 const run=()=>jobs.processOne(db,{[service.kind]:handlers[service.kind]},{owner:'chat-answers',leaseMs:120000});
 const age=()=>db.query("UPDATE stockchief_runtime.agent_chat_questions SET created_at=created_at-interval '2 minutes' WHERE workspace_id=$1",[ws]);
 const asked=async()=>(await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_chat_questions WHERE workspace_id=$1',[ws])).rows[0].n;
 const last=list=>list.at(-1)?.text||'';
 const stockRead={status:'read',question:'',queries:[{dataset:'stock',columns:['sku','location','on_hand']}]};

 // Starter and Growth: the plan lock, and nothing can be connected.
 for(const tier of ['starter','growth']){
  await f.subscribe(tier);const locked=await browser.get(service.path).expect(200);
  assert.match(locked.text,/require Pro or Custom/);assert.doesNotMatch(locked.text,/Save Teams bot/);
  await assert.rejects(service.configure(db,ctx,'teams',{tenant,app,secret:'s',confirmed:'yes',revision:0}),e=>e.code==='entitlement_required');
 }
 await f.subscribe('pro');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 let page=await browser.get(service.path).expect(200);
 await browser.post(service.path+'/teams/connection').type('form').send({_csrf:csrf(page.text),tenant,app,secret:'bot-client-secret',confirmed:'yes',revision:0}).expect(303);
 page=await browser.get(service.path).expect(200);assert.match(page.text,/Messaging endpoint for the bot/);assert.doesNotMatch(page.text,/bot-client-secret/);
 teamsPath=/value="[^"]*?(\/integrations\/stockchief\/teams\/[A-Za-z0-9_-]{32})"/.exec(page.text)[1];
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Chat question connection saved'",[ws])).rows[0].n,1);

 // Only Teams itself can send: no token, another bot, another tenant.
 for(const auth of ['Bearer nothing',sign({aud:randomUUID()})])assert.equal((await toTeams(activity('What is on hand?'),auth)).status,403);
 assert.equal((await toTeams(activity('What is on hand?',{channelData:{tenant:{id:randomUUID()}}}))).status,403);
 // An unlinked Teams user is told how to link; nothing is read.
 assert.equal((await toTeams(activity('What is on hand?'))).status,200);assert.match(last(teams.sent),/Link your Teams user/);assert.equal(await asked(),0);
 // The owner links with a one-use code.
 page=await browser.get(service.path).expect(200);
 const codePage=await browser.post(service.path+'/teams/code').type('form').send({_csrf:csrf(page.text)}).expect(200);
 const code=/connect ([A-Za-z0-9_-]{32})/.exec(codePage.text)[1];
 await toTeams(activity('connect '+code)).expect(200);assert.match(last(teams.sent),/Your Teams user is linked/);
 await toTeams(activity('connect '+code)).expect(200);assert.match(last(teams.sent),/expired or was already used/);
 // A question is answered privately from current records, once, with its credits.
 const question=activity('What is on hand?');
 await toTeams(question).expect(200);await toTeams(question).expect(200);assert.equal(await asked(),1);
 plan=stockRead;let done=await run();
 assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));assert.equal(done.result.status,'replied');assert.equal(done.result.outcome,'read');
 assert.equal(calls,1);assert.match(last(teams.sent),/20/);assert.match(last(teams.sent),/AI credits used [1-9]/);
 assert.equal(teams.sent.at(-1).conversation,'a:owner-chat');assert.equal(teams.sent.at(-1).replyTo,'activity-'+seq);
 assert.equal(await run(),null);
 const audit=async()=>(await db.query("SELECT actor_id,reference,after_state FROM security_event_history WHERE workspace_id=$1 AND action='Chat question answered' ORDER BY created_at,id",[ws])).rows;
 let trail=await audit();assert.equal(trail.length,1);assert.equal(trail[0].actor_id,ctx.actorId);assert.deepEqual(trail[0].after_state,{channel:'teams',outcome:'read'});
 // A change request changes nothing and links back to the app.
 const before=(await db.query('SELECT (SELECT count(*) FROM customer_communications WHERE workspace_id=$1)::int AS mails,(SELECT count(*) FROM sales_orders WHERE workspace_id=$1)::int AS orders',[ws])).rows[0];
 await toTeams(activity('Send an email to all my customers')).expect(200);done=await run();
 assert.equal(done.result.outcome,'change_refused');assert.equal(calls,1);assert.match(last(teams.sent),/Open StockChief to prepare or approve changes: \S*\/ask/);
 assert.deepEqual((await db.query('SELECT (SELECT count(*) FROM customer_communications WHERE workspace_id=$1)::int AS mails,(SELECT count(*) FROM sales_orders WHERE workspace_id=$1)::int AS orders',[ws])).rows[0],before);
 // The owner reads agent reviews through Ask's read.agent_review.
 await toTeams(activity('reviews slack')).expect(200);done=await run();assert.equal(done.result.outcome,'review_list');assert.match(last(teams.sent),/slack-answers \(Ask StockChief in Slack, Teams or WhatsApp\)/);
 await toTeams(activity('review slack-answers')).expect(200);done=await run();assert.equal(done.result.outcome,'review');
 assert.match(last(teams.sent),/Ask StockChief in Slack, Teams or WhatsApp/);assert.match(last(teams.sent),/Open the review: \S*\/autopilot\/reviews\/slack-answers/);
 await age();
 await toTeams(activity('review not-a-review')).expect(200);done=await run();assert.equal(done.result.outcome,'review_unknown');
 // A group conversation is never answered in front of others.
 await toTeams(activity('What is on hand?',{conversation:{id:'19:team-channel',conversationType:'channel'}})).expect(200);
 assert.match(last(teams.sent),/private chat/);
 // A failed delivery is held and its credits returned.
 teams.fail=true;await toTeams(activity('What is on hand before an outage?')).expect(200);done=await run();teams.fail=false;
 assert.equal(done.status,'DEAD');
 const held=(await db.query("SELECT id,status FROM stockchief_runtime.agent_chat_questions WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1",[ws])).rows[0];
 assert.equal(held.status,'HELD');
 assert.equal((await db.query("SELECT status FROM commercial_usage_events WHERE workspace_id=$1 AND meter='ai_work_credits' AND idempotency_key=$2",[ws,ws+':teams:'+held.id])).rows[0].status,'REVERSED');
 await age();
 // Pause, Watch only, Ask me first and the first 14 days answer nothing and say why.
 const sentBefore=teams.sent.length;
 await autopilot.pause(db,ctx,{role:'owner'},'Chat pause');await toTeams(activity('What is on hand now?')).expect(200);assert.match(last(teams.sent),/paused/i);await autopilot.resume(db,ctx,{role:'owner'});
 await jobModes.save(db,ctx,188,{mode:'ask',revision:0});await toTeams(activity('What is on hand now?')).expect(200);assert.match(last(teams.sent),/Ask me first/);
 await jobModes.save(db,ctx,188,{mode:'watch',revision:1});await toTeams(activity('What is on hand now?')).expect(200);assert.match(last(teams.sent),/Watch only/);
 await jobModes.save(db,ctx,188,{mode:'routine',revision:2});
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);await toTeams(activity('What is on hand now?')).expect(200);assert.match(last(teams.sent),/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 assert.equal(teams.sent.length,sentBefore+4);
 // A downgrade before delivery stops the answer; on Growth the plan is named.
 await toTeams(activity('What is on hand after a downgrade?')).expect(200);await f.subscribe('growth');done=await run();
 assert.equal(done.result.status,'authority_changed');
 await toTeams(activity('What is on hand on Growth?')).expect(200);assert.match(last(teams.sent),/Pro/);
 await f.subscribe('enterprise');await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES($1,$2,'ai_work_credits',1000,'Synthetic Custom chat answers')`,[randomUUID(),f.owner.accountId]);
 await age();await toTeams(activity('What is in stock on Custom?')).expect(200);done=await run();assert.equal(done.result.status,'replied');
 // The owner sees stock value; the counter below does not.
 plan={status:'read',question:'',queries:[{dataset:'inventory_valuation',summary:true}]};
 await toTeams(activity('What is our stock worth?')).expect(200);done=await run();assert.equal(done.result.outcome,'read',JSON.stringify(done.result));

 // WhatsApp: a staff member without cost access asks from their confirmed number.
 const auth=require('../../src/domain/postgres-auth-service'),home=await auth.createBusiness(db,{name:'Counter',businessName:'Counter home',email:randomUUID()+'@example.test',password:f.password});
 const counter={workspaceId:ws,actorId:'member-'+randomUUID()};
 await db.query(`INSERT INTO users(id,workspace_id,account_id,name,role,permissions,created_at) VALUES($1,$2,$3,'Counter','staff',$4,now()::text)`,[counter.actorId,ws,home.accountId,P.encodeGrant([P.VIEW,P.ADJUST,P.VIEW_SALES])]);
 await db.query(`INSERT INTO stockchief_runtime.agent_alert_phones(workspace_id,user_id,phone,verified_at) VALUES($1,$2,'+15550002222',now()),($1,$3,'+15550002222',now())`,[ws,counter.actorId,ctx.actorId]);
 await assert.rejects(service.linkPhone(db,counter),/not turned on WhatsApp/);
 page=await browser.get(service.path).expect(200);assert.match(page.text,/Turn on WhatsApp questions/);
 await browser.post(service.path+'/whatsapp/connection').type('form').send({_csrf:csrf(page.text),confirmed:'yes',revision:0}).expect(303);
 await service.linkPhone(db,counter);
 await assert.rejects(service.linkPhone(db,ctx),/already asks another inventory or person/);
 // Only Twilio can send, and only linked numbers are answered.
 assert.equal((await toWhatsapp('+15550002222','What is on hand?',{token:'forged'})).status,403);
 let reply=await toWhatsapp('+15550009999','What is on hand?');assert.equal(reply.status,200);assert.match(reply.text,/<Message>This number is not linked to StockChief/);
 plan=stockRead;
 reply=await toWhatsapp('+15550002222','What is on hand?');assert.equal(reply.status,200);assert.match(reply.text,/<Response><\/Response>/);
 done=await run();assert.equal(done.result.status,'replied');assert.match(last(whatsapp.sent),/20/);assert.equal(whatsapp.sent.at(-1).to,'+15550002222');
 // Costs and stock value stay hidden from this role; agent reviews are the owner's.
 plan={status:'read',question:'',queries:[{dataset:'inventory_valuation',summary:true}]};
 await toWhatsapp('+15550002222','What is our stock worth?').expect(200);done=await run();
 assert.equal(done.result.status,'replied');assert.equal(done.result.outcome,'failed');assert.match(last(whatsapp.sent),/could not complete/);assert.doesNotMatch(last(whatsapp.sent),/\$|value/i);
 const actor=(await db.query('SELECT id,role,permissions FROM users WHERE id=$1',[counter.actorId])).rows[0];
 assert.ok(!require('../../src/assistant/bounded-business-read').contracts(actor).some(d=>Object.keys(d.fields).includes('recorded_cost_minor')),'no cost field is offered to this role');
 await age();
 await toWhatsapp('+15550002222','reviews').expect(200);done=await run();assert.equal(done.result.outcome,'review_refused');assert.match(last(whatsapp.sent),/for the inventory owner/);
 // A permission change while the answer is prepared stops it.
 plan=stockRead;const complete=provider.complete;
 provider.complete=async req=>{const r=await complete(req);await db.query('UPDATE users SET permissions=$2 WHERE id=$1',[counter.actorId,P.encodeGrant([P.VIEW])]);return r;};
 await toWhatsapp('+15550002222','What is on hand today?').expect(200);done=await run();provider.complete=complete;
 assert.equal(done.result.status,'authority_changed');
 // A number that is no longer confirmed is not answered.
 await age();await db.query('UPDATE stockchief_runtime.agent_alert_phones SET verified_at=NULL WHERE user_id=$1',[counter.actorId]);
 reply=await toWhatsapp('+15550002222','What is on hand?');assert.match(reply.text,/Confirm this mobile number/);
 // Every delivered answer is in the audit trail, without the question text.
 trail=await audit();
 assert.deepEqual(trail.map(r=>r.after_state.channel+':'+r.after_state.outcome),['teams:read','teams:change_refused','teams:review_list','teams:review','teams:review_unknown','teams:read','teams:read','whatsapp:read','whatsapp:failed','whatsapp:review_refused']);
 assert.ok(trail.every(r=>!JSON.stringify(r.after_state).includes('worth')));
 assert.equal(trail.at(-1).actor_id,counter.actorId);
 // The page and the review show both channels; disconnecting stops Teams at once.
 page=await browser.get(service.path).expect(200);assert.match(page.text,/Your recent questions/);assert.match(page.text,/Teams · Replied/);
 const review=await browser.get('/autopilot/reviews/slack-answers').expect(200);assert.match(review.text,/WhatsApp/);
 // The page fits a phone and a desktop.
 const server=await new Promise(r=>{const x=publicApp.listen(0,'127.0.0.1',()=>r(x));}),origin='http://127.0.0.1:'+server.address().port,chromium=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await chromium.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 for(const viewport of [{width:390,height:844},{width:1280,height:900}]){
  const owner=await chromium.newPage({viewport});owner.setDefaultTimeout(15000);
  await owner.goto(origin+'/login');await owner.getByLabel('Work email').fill(f.email);await owner.locator('[name=password]').fill(f.password);
  await Promise.all([owner.waitForNavigation(),owner.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await owner.goto(origin+service.path);await owner.getByRole('heading',{name:'Microsoft Teams',exact:true}).waitFor();await owner.getByRole('heading',{name:'WhatsApp',exact:true}).waitFor();
  assert(await owner.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'chat page fits '+viewport.width);
  if(viewport.width===390){require('node:fs').mkdirSync('output',{recursive:true});await owner.screenshot({path:'output/chat-channels-mobile.png',fullPage:true});}
  await owner.close();
 }
 await browser.post(service.path+'/teams/connection').type('form').send({_csrf:csrf(page.text),confirmed:'yes',revision:1,stop:'yes'}).expect(303);
 assert.equal((await toTeams(activity('What is on hand?'))).status,404);
 assert.equal(await f.balance(),20);
});
