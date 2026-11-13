'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 181 is alone on every plan: one log of everything StockChief did, why,
// what allowed it and its evidence, with undo through the job's own undo where
// it is safe, and the correction path where it is not. Job 204 is alone on
// Growth, Pro and Custom and excluded on Starter: once a business day ends the
// worker writes that day's digest, which opens in Needs you and is emailed from
// the owner's mailbox with an undo or correction link for each action. The
// email waits during the first 14 days, pause and Ask me first.
test('the activity log says what StockChief did and why, undoes it safely, and the daily digest reaches the owner',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:10}),{db,ctx,subscribe,browser,workflows,location}=f,ws=ctx.workspaceId;
 const activity=require('../../src/autopilot/agent-activity'),digest=require('../../src/autopilot/agent-work-digest'),reviews=require('../../src/autopilot/job-reviews');
 const assistant=require('../../src/assistant/postgres-service'),autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
 const fixes=require('../../src/catalog/agent-catalog-fixes'),catalog=require('../../src/domain/postgres-catalog-service'),prices=require('../../src/pricing/postgres-service');
 const notices=require('../../src/autopilot/operational-notices'),needs=require('../../src/projections/postgres-service'),alerts=require('../../src/autopilot/agent-alerts');
 const quotes=require('../../src/sales/postgres-quotes'),mail=require('../../src/connections/postgres-outbound-mail'),clock=require('../../src/lib/business-time');
 const {addDays}=require('../../src/accounting/customer-money');
 const audits=action=>db.query('SELECT count(*)::int AS n FROM security_event_history WHERE workspace_id=$1 AND action=$2',[ws,action]).then(r=>r.rows[0].n);
 const age=interval=>db.query(`UPDATE accounts SET created_at=(now()-interval '${interval}')::text WHERE id=$1`,[f.owner.accountId]);
 await age('30 days');await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
 const today=await clock.today(db,ws),zone=(await clock.forWorkspace(db,ws)).timeZone,noon=day=>new Date(Date.parse(clock.dayBoundary(day,zone))+12*3600000).toISOString();

 // Every undo check, record lookup and source query runs against the real schema.
 for(const spec of Object.values(activity.UNDO))await spec.check(db,ws,[{record:'missing',row:{result:{tasks:[{id:'missing'}]}}}]);
 for(const s of activity.SOURCES.filter(s=>s.lookup))await db.query(s.lookup,[ws,['missing']]);
 for(const s of activity.SOURCES)if(s.undo)assert.ok(activity.UNDO[s.undo],s.undo);
 for(const w of Object.values(activity.WORK))if(w.undo)assert.ok(activity.UNDO[w.undo],w.undo);
 assert.ok(Array.isArray((await activity.work(db,ctx,{from:clock.dayBoundary(today,zone),to:clock.dayBoundary(today,zone,{nextDay:true}),order:'DESC',history:{activityAfter:null}})).rows));

 // A prepared change the owner approves: the audit trail records what allowed it.
 await subscribe('pro');
 const sku=f.item.skuIds[0],item=(await db.query('SELECT s.code,i.name FROM skus s JOIN items i ON i.id=s.item_id WHERE s.id=$1',[sku])).rows[0];
 await prices.setPrice(db,ctx,{skuId:sku,amountMinor:1000,currency:'USD'});
 const act=async request=>{const p=await assistant.prepareAction(db,ctx,'Carry out this reviewed request',request);await assistant.executeProposal(db,ctx,p.proposal.id);
  return (await db.query('SELECT * FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ws,p.proposal.id])).rows[0];};
 const quoteRequest={action:'sales_quote.create',recordReference:'Receiver',quoteValidUntil:addDays(today,10),orderLines:JSON.stringify([{sku:item.code,quantity:1}])};
 const quote=await act(quoteRequest);
 const completed=(await db.query("SELECT after_state FROM security_event_history WHERE workspace_id=$1 AND action='Agent action completed' AND reference=$2",[ws,quote.id])).rows;
 assert.equal(completed.length,1);
 assert.deepEqual([completed[0].after_state.job,completed[0].after_state.automatic,completed[0].after_state.allowedBy.kind,completed[0].after_state.plan],[73,false,'approval','pro']);

 // Work done on its own (Custom): a missing purchase cost fixed inside the daily limit.
 await subscribe('enterprise');
 const bought=async(code,unitCost)=>{
  const made=await catalog.createItem(db,ctx,{name:'Activity '+code,baseCode:code,trackingMode:'quantity',weightGrams:20});
  const po=await workflows.createPurchaseOrder(db,ctx,{supplierId:'fixture-supplier',destinationLocationId:location.id,idempotencyKey:randomUUID(),lines:[{skuId:made.skuIds[0],quantityUnits:1,unitCost}]});
  await workflows.approvePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});await workflows.placePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID()});
  await workflows.receivePurchaseOrder(db,ctx,po.purchaseOrderId,{idempotencyKey:randomUUID(),lines:[{lineId:po.lineIds[0],quantity:1,locationId:location.id}]});
  return made.skuIds[0];
 };
 const costSku=await bought('LOG-COST',3.25);
 await fixes.run({workspaceId:ws,payload:{}},db);
 const fix=(await db.query("SELECT * FROM stockchief_runtime.agent_catalog_fixes WHERE workspace_id=$1 AND sku_id=$2 AND kind='COST'",[ws,costSku])).rows[0];
 assert.deepEqual([fix.status,fix.automatic],['DONE',true]);
 const cost=async s=>(await db.query('SELECT amount_minor::int AS minor FROM sku_purchase_costs WHERE workspace_id=$1 AND sku_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ws,s])).rows[0]?.minor??null;
 assert.equal(await cost(costSku),325);

 // The log on every plan: what it did, why, what allowed it, evidence, and undo.
 const title=id=>require('../../src/commercial/agent-plan-v3.json').find(r=>r.id===id).job;
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  const log=await reviews.run(db,ctx,activity.key);
  const q=log.activity.entries.find(e=>e.origin==='action'&&e.id===quote.id),auto=log.activity.entries.find(e=>e.origin==='audit'&&e.what.startsWith('Catalog fix made on its own'));
  assert.ok(q&&auto,tier);
  assert.deepEqual([q.jobTitle,q.allowedBy,q.why,q.undo?.what],[title(73),'Your approval','Requested: Carry out this reviewed request','Withdraw the open quotation']);
  assert.equal(auto.jobTitle,title(126));assert.match(auto.why,/missing cost/);assert.match(auto.allowedBy,/^Your daily catalog fix limit \(limit \d+\)$/);assert.match(auto.evidence,/Kind: COST/);
  assert.match(auto.trail,/^\/audit\?q=/);
  // Undo goes through the job's own undo, which the plan must include.
  assert.equal(Boolean(auto.undo),tier!=='starter',tier);
  if(tier==='starter')assert.match(auto.correction,/Your plan does not include undo/);
  assert.ok(log.rows.some(r=>r.Action.startsWith('Catalog fix made on its own')&&r['Allowed by']===auto.allowedBy),'Ask reads the same rows');
  const page=await browser.get(activity.path).expect(200);
  for(const text of ['Everything StockChief did, and why','Allowed by:','Why:','Undo this change','Audit trail'])assert.ok(page.text.includes(text),tier+' '+text);
 }

 // Undo from the log on Starter (job 181 is alone there): the quote is withdrawn once.
 await subscribe('starter');
 const html=(await browser.get(activity.path).expect(200)).text;
 await browser.post('/autopilot/activity/undo').type('form').send({_csrf:f.csrf(html),origin:'action',id:quote.id,returnTo:activity.path}).expect(303);
 assert.equal((await quotes.get(db,ws,quote.result.quoteId)).status,'DECLINED');
 assert.deepEqual(await activity.undo(db,ctx,{origin:'action',id:quote.id}),{replayed:true});
 assert.equal((await db.query("SELECT count(*)::int n FROM security_event_history WHERE workspace_id=$1 AND action='Agent action undone' AND reference=$2",[ws,quote.id])).rows[0].n,1);
 assert.equal((await reviews.run(db,ctx,activity.key)).activity.entries.find(e=>e.id===quote.id).status,'Undone');
 // The catalog fix is the Custom job's own undo: refused on Starter.
 const fixEvent=(await db.query("SELECT id FROM security_event_history WHERE workspace_id=$1 AND action='Catalog fix made on its own' AND reference=$2",[ws,fix.id])).rows[0].id;
 await assert.rejects(activity.undo(db,ctx,{origin:'audit',id:fixEvent}),e=>e.code==='entitlement_required');
 assert.equal(await cost(costSku),325);

 // On Custom the same undo removes the fixed cost; a replay changes nothing.
 await subscribe('enterprise');
 assert.equal((await activity.undo(db,ctx,{origin:'audit',id:fixEvent})).replayed,false);
 assert.equal(await cost(costSku),null);
 assert.deepEqual(await activity.undo(db,ctx,{origin:'audit',id:fixEvent}),{replayed:true});
 assert.equal(await audits('Catalog fix undone'),1);
 assert.equal((await reviews.run(db,ctx,activity.key)).activity.entries.find(e=>e.id===fixEvent).status,'Undone');
 // A record changed since: the job's own recheck refuses and nothing moves.
 const changedSku=await bought('LOG-LATER',4);await fixes.run({workspaceId:ws,payload:{}},db);
 const later=(await db.query("SELECT id FROM security_event_history WHERE workspace_id=$1 AND action='Catalog fix made on its own' AND reference=(SELECT id FROM stockchief_runtime.agent_catalog_fixes WHERE workspace_id=$1 AND sku_id=$2 AND kind='COST')",[ws,changedSku])).rows[0].id;
 await prices.setPurchaseCost(db,ctx,{skuId:changedSku,amountMinor:450,currency:'USD'});
 await assert.rejects(activity.undo(db,ctx,{origin:'audit',id:later}),/changed since StockChief did it/);
 assert.match((await reviews.run(db,ctx,activity.key)).activity.entries.find(e=>e.id===later).correction,/Undo the fix|correct/i);
 assert.equal(await cost(changedSku),450);
 await assert.rejects(activity.undo(db,ctx,{origin:'unknown',id:later}),e=>e.code==='not_found');

 // Job 204: Starter is excluded.
 await subscribe('starter');
 await assert.rejects(digest.report(db,ctx),e=>e.code==='entitlement_required');
 assert.deepEqual(await digest.deliver(db,ws),{skipped:'plan'});
 await browser.get(digest.path).expect(402);

 // Growth writes yesterday's digest once, for the day just finished.
 await subscribe('growth');
 const tomorrow=new Date(Date.now()+86400000);
 const written=await digest.deliver(db,ws,{now:tomorrow});
 assert.equal(written.day,today);assert.ok(written.actions>=3);
 assert.deepEqual(await digest.deliver(db,ws,{now:tomorrow}),{replayed:true,day:today});
 assert.equal(await audits('Daily work digest prepared'),1);
 const lines=await digest.lines(db,ws,[{reference:today}]);
 assert.match(lines[0],new RegExp('^What StockChief did on '+today+': \\d+ actions\\.$'));
 assert.ok(lines.some(l=>l.startsWith('Catalog fix made on its own')&&l.includes('Already undone.')),lines.join('\n'));
 assert.ok(lines.some(l=>l.startsWith('Catalog fix made on its own')&&/Undo it in one tap: .*daily-work\?filter=.*#entry-audit-/.test(l)),lines.join('\n'));
 // It opens in Needs you, and the page shows one-tap undo.
 await notices.refresh(db,ws);
 const notice=(await needs.needs(db,ws,ctx.actorId)).find(n=>n.sourceId==='agent-notice-204');
 assert.deepEqual([notice.title,notice.href],['Your daily record of StockChief work',digest.path+'?filter='+today]);
 const day=await browser.get(digest.path+'?filter='+today).expect(200);
 assert.match(day.text,/How you get these alerts/);assert.match(day.text,/Allowed by:/);assert.ok((day.text.match(/>Undo this change</g)||[]).length>=1);

 // Email from the owner's mailbox: held during the first 14 days, then sent on its own.
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
  VALUES($1,$2,$1,'Owner mail','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'owner-mail',$5,now(),now())`,[connector,ws,'connection_credentials:'+connector,ctx.actorId,f.email]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ws,connector,'provider',{accessToken:'test-token'}));
 await browser.post('/autopilot/alerts/204').type('form').send({_csrf:f.csrf(day.text),mailbox:connector,revision:'0'}).expect(303);
 await age('1 day');await notices.refresh(db,ws);
 let panel=await alerts.panel(db,ctx,204);assert.equal(panel.waiting,1);assert.match(panel.note,/first 14 days/);
 await age('30 days');await notices.refresh(db,ws);
 assert.equal((await alerts.panel(db,ctx,204)).waiting,0);
 const latest=async()=>(await db.query('SELECT * FROM customer_communications WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1',[ws])).rows[0];
 const effect=async id=>(await db.query("SELECT id FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND aggregate_id=$2 AND kind='mail.outbound.send'",[ws,id])).rows[0].id;
 const delivered=[],provider={send:async({message})=>{delivered.push(message);return {externalMessageId:'accepted-'+message.id};}};
 await mail.executeSendEffect(db,ws,await effect((await latest()).id),{provider});
 assert.equal(delivered[0].recipient,f.email);assert.equal(delivered[0].subject,'What StockChief did on '+today);
 assert.match(delivered[0].body,/each with a one-tap undo or how to correct it/);assert.match(delivered[0].body,/- Catalog fix made on its own/);
 // The email itself is in the log, as an outside effect that cannot be recalled.
 const sent=(await reviews.run(db,ctx,activity.key)).activity.entries.find(e=>e.what.startsWith('Alert email queued'));
 assert.deepEqual([sent.jobTitle,sent.undo,/cannot be recalled/.test(sent.correction)],[title(204),null,true]);

 // A new day while paused, then under Ask me first: the email waits, and the owner can send it.
 await subscribe('pro');const second=await act(quoteRequest);await subscribe('growth');
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET executed_at=$3 WHERE workspace_id=$1 AND id=$2',[ws,second.id,noon(addDays(today,1))]);
 assert.equal((await digest.deliver(db,ws,{now:new Date(Date.now()+2*86400000)})).day,addDays(today,1));
 await autopilot.pause(db,ctx,{role:'owner'},'Stocktake');await notices.refresh(db,ws);
 panel=await alerts.panel(db,ctx,204);assert.equal(panel.waiting,1);assert.match(panel.note,/paused/);
 await autopilot.resume(db,ctx,{role:'owner'});
 assert.deepEqual((await modes.page(db,ctx)).find(x=>x.id===204).allowed,['inherit','watch','ask','routine']);
 await modes.save(db,ctx,204,{mode:'ask',revision:0});await notices.refresh(db,ws);
 panel=await alerts.panel(db,ctx,204);assert.match(panel.note,/Ask me first/);assert.equal(panel.canSendNow,true);
 await browser.post('/autopilot/alerts/204/send').type('form').send({_csrf:f.csrf((await browser.get(digest.path).expect(200)).text)}).expect(303);
 assert.equal(await audits('Alert email queued'),2);
 await modes.save(db,ctx,204,{mode:'inherit',revision:1});

 // The plan's history: Starter keeps 90 days, Growth a year, Pro everything.
 const old=addDays(today,-200);
 await db.query('UPDATE stockchief_runtime.assistant_action_proposals SET executed_at=$3 WHERE workspace_id=$1 AND id=$2',[ws,second.id,noon(old)]);
 for(const [tier,shown] of [['starter',0],['growth',1],['pro',1]]){await subscribe(tier);assert.equal((await activity.report(db,ctx,{filter:old})).rows.length,shown,tier);}
 // Pro and Custom export it; Custom reads it through the API.
 await browser.get(activity.path+'/download?filter='+addDays(today,-7)+'..'+today).expect(200).then(r=>{
  assert.ok(r.text.includes('"When (UTC)","Job","What it did","Why","Allowed by","Evidence","Undo or correction","Status","Record"'));assert.ok(r.text.includes('Catalog fix made on its own'));});
 await subscribe('growth');await browser.get(activity.path+'/download').expect(402);
 await subscribe('enterprise');
 const token=(await require('../../src/connections/postgres-public-api').create(db,ctx,{name:'Activity reader',scopes:['audit:read']})).token;
 const api=await browser.get('/api/v1/public/audit').query({view:'agent-activity',filter:today}).set('Authorization','Bearer '+token).expect(200);
 assert.ok(api.body.data.some(r=>r.action.startsWith('Catalog fix made on its own')&&r.job===126&&/daily catalog fix limit/.test(r.allowedBy)));
 await subscribe('pro');await browser.get('/api/v1/public/audit').query({view:'agent-activity'}).set('Authorization','Bearer '+token).expect(402);

 // The pages read well on a desktop and on a 390 px phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 const chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const [page,heading] of [[activity.path+'?filter='+addDays(today,-7)+'..'+addDays(today,1),'Everything StockChief did, and why'],[digest.path+'?filter='+today,'Daily record of StockChief work']]){
   await tab.goto(base+page);
   assert.ok(await tab.getByRole('heading',{name:heading,exact:true}).isVisible(),heading);
   assert.ok(await tab.locator('[data-activity-log]').isVisible());
   assert.ok(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' '+page+' must not scroll sideways');
   await tab.screenshot({path:require('node:path').join(folder,(page.startsWith(digest.path)?'daily-work-':'activity-log-')+name+'.png'),fullPage:true});
  }
  await tab.close();
 }

 // Staff cannot read the log or undo from it.
 await db.query("UPDATE users SET role='staff',permissions='[\"VIEW\"]' WHERE workspace_id=$1 AND id=$2",[ws,ctx.actorId]);
 await assert.rejects(activity.report(db,ctx),e=>e.code==='forbidden');
 await assert.rejects(activity.undo(db,ctx,{origin:'audit',id:later}),e=>e.code==='forbidden');
 await assert.rejects(digest.report(db,ctx),e=>e.code==='forbidden');
});
