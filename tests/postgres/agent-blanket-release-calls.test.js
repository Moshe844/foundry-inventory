'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const modes=require('../../src/autopilot/job-modes'),jobs=require('../../src/operations/postgres-job-queue'),handlers=require('../../src/operations/postgres-runtime-handlers').create();

// The blanket fixture: Pro, past shadow mode, routine authority, one product
// with 20 in stock bought earlier from the supplier at $1.00.
async function setup(t,plan,limits=null){
 const f=await require('../helpers/agent-blanket-release-fixture').fixture(t),{db,ctx}=f,origin=process.env.FOUNDRY_PUBLIC_URL;
 process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';t.after(()=>{if(origin===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=origin;});
 await f.subscribe(plan);
 if(limits)await db.query("UPDATE commercial_plan_versions SET configuration=jsonb_set(configuration,'{agentPurchaseLimits}',$1::jsonb) WHERE plan_id='enterprise' AND status='ACTIVE'",[JSON.stringify(limits)]);
 await db.query("UPDATE suppliers SET email='contracts@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
 const connector=randomUUID();
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,credential_ref,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Purchasing mailbox','gmail','[]','{}','connected','["MAIL_SEND"]',$3,'CONNECTED',$4,'contracts-mailbox',now(),now())`,[connector,ctx.workspaceId,'connection_credentials:'+connector,ctx.actorId]);
 await db.transaction(c=>require('../../src/connections/postgres-credential-store').put(c,ctx.workspaceId,connector,'provider',{accessToken:'synthetic-token'}));
 // The product's stock target at the receiving warehouse: real demand for the release to follow.
 const demand=async(reorder,target)=>{await db.query('DELETE FROM reorder_policies WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,f.item.skuIds[0]]);
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,safety_stock,source,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,0,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,f.item.skuIds[0],f.location.id,reorder,target]);};
 // A week passes: every date on the contract moves seven days earlier.
 const week=async id=>{for(const shift of [-1000,993]){
  await db.query(`UPDATE stockchief_runtime.agent_blanket_releases SET release_date=(release_date::date+$3::int)::text,expected_date=(expected_date::date+$3::int)::text WHERE workspace_id=$1 AND contract_id=$2`,[ctx.workspaceId,id,shift]);
  await db.query(`UPDATE stockchief_runtime.agent_blanket_contracts SET first_release=(first_release::date+$3::int)::text,last_release=(last_release::date+$3::int)::text WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,id,shift]);}};
 const slot=async(id,date)=>(await db.query('SELECT * FROM stockchief_runtime.agent_blanket_releases WHERE workspace_id=$1 AND contract_id=$2 AND release_date=$3',[ctx.workspaceId,id,date])).rows[0];
 const po=async id=>(await db.query('SELECT p.status,(SELECT sum(quantity_units)::int FROM purchase_order_lines l WHERE l.purchase_order_id=p.id) units FROM purchase_orders p WHERE p.id=$1',[id])).rows[0];
 const mail=async id=>(await db.query("SELECT m.status,e.status effect FROM supplier_communications m JOIN stockchief_runtime.provider_effects e ON e.aggregate_id=m.id WHERE m.workspace_id=$1 AND m.purchase_order_id=$2",[ctx.workspaceId,id])).rows[0];
 const run=async id=>{await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:f.service.kind,idempotencyKey:randomUUID(),payload:{contractId:id}});const done=await jobs.processOne(db,{[f.service.kind]:handlers[f.service.kind]},{owner:'contract-release-worker'});assert.equal(done.status,'COMPLETED',JSON.stringify(done.lastError));return done.result;};
 return {...f,demand,week,slot,po,mail,run};
}

test('Pro drafts releases until taught, then places them on its own: adjusted to demand within the agreed range, inside the contract value, undoable before the email goes out',{timeout:420000},async t=>{
 const f=await setup(t,'pro'),{db,ctx,service:s}=f;
 await f.demand(30,60);
 const p=await f.contract({firstRelease:f.today,lastRelease:f.add(f.today,28),flexPercent:'50',valueLimit:'90.00'});
 assert.equal(p.slots.length,5);assert.equal(Number((await s.get(db,ctx,p.id)).value_limit_minor),9000);
 // Pro may run the schedule before teaching: the release is drafted and waits for approval.
 await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});
 let result=await f.run(p.id);
 assert(result.purchaseOrderId);assert.equal(result.sent,false);assert.match(result.reason,/teach/);
 // 20 in stock, target 60: 40 needed, so the 20 scheduled moves up to the 30 the 50% range allows.
 assert.deepEqual(await f.po(result.purchaseOrderId),{status:'DRAFT',units:30});
 let first=await f.slot(p.id,f.today);assert.equal(first.adjustment.notes[0].why,'More needed than scheduled');assert.equal(first.scheduled_lines[0].quantityUnits,20);
 await assert.rejects(s.teach(db,ctx,first.id,{confirmed:'yes'}),/approved yourself/);
 await f.workflows.approvePurchaseOrder(db,ctx,result.purchaseOrderId,{idempotencyKey:randomUUID()});
 await s.teach(db,ctx,first.id,{confirmed:'yes'});
 // A week later: 50 on hand or coming, so only 10 more are needed. Taught, it places the release itself.
 await f.week(p.id);result=await f.run(p.id);
 assert.equal(result.sent,true,JSON.stringify(result));assert.deepEqual(await f.po(result.purchaseOrderId),{status:'APPROVED',units:10});
 assert.deepEqual(await f.mail(result.purchaseOrderId),{status:'QUEUED',effect:'PENDING'});
 assert.equal((await db.query("SELECT count(*)::int n FROM work_items WHERE purchase_order_id=$1 AND approval_requirement='NONE'",[result.purchaseOrderId])).rows[0].n,1,'Counts against the weekly automatic limit');
 assert.equal((await f.run(p.id)).notDue,true,'Replaying places nothing more today');
 // Undo before the email goes out: PO and email cancelled, the units go back on the contract.
 const second=await f.slot(p.id,f.today),undone=result.purchaseOrderId;
 await s.undo(db,ctx,second.id,{confirmed:'yes'});assert.equal((await s.undo(db,ctx,second.id,{confirmed:'yes'})).replayed,true);
 assert.equal((await f.po(undone)).status,'CANCELLED');assert.deepEqual(await f.mail(undone),{status:'CANCELLED',effect:'CANCELLED'});
 assert.equal((await s.screen(db,ctx,{id:p.id})).value.drawnMinor,3000);
 result=await f.run(p.id);assert.equal(result.held,true);assert.match(result.reason,/You undid/);
 const again=await s.manual(db,ctx,second.id,{confirmed:'yes'});assert.notEqual(again.purchaseOrderId,undone);assert.deepEqual(await f.po(again.purchaseOrderId),{status:'DRAFT',units:10});
 await f.workflows.approvePurchaseOrder(db,ctx,again.purchaseOrderId,{idempotencyKey:randomUUID()});
 // Demand jumps: the release goes up to the most the range allows (30), still within the $90 contract value.
 await f.demand(100,150);await f.week(p.id);result=await f.run(p.id);
 assert.equal(result.sent,true,JSON.stringify(result));assert.equal((await f.po(result.purchaseOrderId)).units,30);
 // Only $20 of the contract value is left: the next release is trimmed to fit, never over.
 await f.week(p.id);result=await f.run(p.id);
 assert.equal(result.sent,true,JSON.stringify(result));assert.equal((await f.po(result.purchaseOrderId)).units,20);
 const screen=await s.screen(db,ctx,{id:p.id});assert.equal(screen.value.leftMinor,0);assert.equal(screen.drawdown[0].currentUnits,90);
 // The value is used up: the last release orders nothing and the units stay unordered.
 await f.week(p.id);result=await f.run(p.id);assert.equal(result.skipped,true);
 const last=(await s.screen(db,ctx,{id:p.id})).slots.at(-1);assert.equal(last.status,'SKIPPED');assert.match(last.adjustment.skipped,/used up/);
 const actions=(await db.query('SELECT action FROM security_event_history WHERE workspace_id=$1',[ctx.workspaceId])).rows.map(r=>r.action);
 for(const a of ['Unapproved supplier contract release drafted','Supplier contract release placed and queued to the supplier','Supplier contract release undone before sending','Contract release not needed and skipped'])assert(actions.includes(a),a);
 const digest=(await require('../../src/autopilot/agent-work-digest').report(db,ctx)).rows.filter(r=>r.link==='/autopilot/blanket-releases/'+p.id);
 assert(digest.some(r=>/ordered and queued/.test(r.Action)),JSON.stringify(digest));
 // The contract page at desktop width and on a phone.
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const x=app.listen(0,'127.0.0.1',()=>r(x));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport,isMobile:viewport.width<500,hasTouch:viewport.width<500}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/login');await page.getByLabel('Work email',{exact:true}).fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  for(const path of ['/autopilot/blanket-releases','/autopilot/blanket-releases/'+p.id]){
   assert.equal((await page.goto(origin+path)).status(),200);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No sideways scroll on '+path+' at '+viewport.width);
  }
  await page.locator('[data-blanket-dates] summary').first().click();
  const text=await page.locator('main').innerText();assert.match(text,/Ordered and queued to the supplier/);assert.match(text,/\$0\.00 left/);assert.match(text,/used up/);assert.match(text,/more needed than scheduled/);
  require('node:fs').mkdirSync('output',{recursive:true});await page.screenshot({path:'output/blanket-release-calls-'+viewport.width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);await page.close();
 }
 const form=await f.browser.get('/autopilot/blanket-releases').expect(200);assert.match(form.text,/Contract total value/);assert.match(form.text,/move with demand/);
});

test('Custom places releases without teaching inside agreed limits; shadow, Watch only and Ask me first stop or ask; the weekly limit asks; no release past the contract dates',{timeout:420000},async t=>{
 const f=await setup(t,'enterprise',{currency:'USD',perOrder:1000,perWeek:25}),{db,ctx,service:s}=f;
 const p=await f.contract({firstRelease:f.today,lastRelease:f.add(f.today,28)});await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const before=await f.orders();
 await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);let result=await f.run(p.id);assert.equal(result.held,true);assert.match(result.reason,/14 days/);
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 await modes.save(db,ctx,42,{mode:'watch',revision:0});result=await f.run(p.id);assert.equal(result.held,true);assert.match(result.reason,/Watch only/);assert.equal(await f.orders(),before);
 // Ask me first: the exact release is drafted and waits for approval.
 await modes.save(db,ctx,42,{mode:'ask',revision:1});result=await f.run(p.id);assert.match(result.reason,/Ask me first/);assert.deepEqual(await f.po(result.purchaseOrderId),{status:'DRAFT',units:20});
 const needs=(await require('../../src/projections/postgres-service').needs(db,ctx.workspaceId,ctx.actorId)).filter(n=>n.sourceId==='blanket-contracts');assert.equal(needs.length,1);
 await f.workflows.approvePurchaseOrder(db,ctx,result.purchaseOrderId,{idempotencyKey:randomUUID()});
 // Handle routine work: no teaching on Custom; two workers place one release.
 await modes.save(db,ctx,42,{mode:'routine',revision:2});await f.week(p.id);
 const both=await Promise.all([s.onContract(db,ctx.workspaceId,p.id),s.onContract(db,ctx.workspaceId,p.id)]);
 const placed=both.filter(r=>r.sent);assert.equal(placed.length,1,JSON.stringify(both));assert.equal(both.filter(r=>r.notDue).length,1);
 assert.deepEqual(await f.po(placed[0].purchaseOrderId),{status:'APPROVED',units:20});
 // The next release would pass the agreed $25 a week of automatic buying: it waits for a person.
 await f.week(p.id);result=await f.run(p.id);assert.equal(result.sent,false);assert.match(result.reason,/weekly automatic purchasing limit/);assert.equal((await f.po(result.purchaseOrderId)).status,'DRAFT');
 // Releases follow demand: with stock above target, a flexible release is not needed and its units stay on the contract.
 await f.demand(5,10);
 const flex=await f.contract({reference:'FLEX-CONTRACT',firstRelease:f.today,lastRelease:f.add(f.today,28),flexPercent:'100'});await s.configure(db,ctx,flex.id,{revision:1,confirmed:'yes'});
 result=await f.run(flex.id);assert.equal(result.skipped,true);assert.match((await f.slot(flex.id,f.today)).adjustment.skipped,/Not needed/);
 // Never past the contract's dates: after its last release date nothing more is prepared, by the routine or by hand.
 for(let i=0;i<6;i++)await f.week(flex.id);
 const late=(await s.screen(db,ctx,{id:flex.id})).slots.find(r=>r.status==='PLANNED');
 await assert.rejects(s.manual(db,ctx,late.id,{confirmed:'yes'}),/last release date/);
 result=await f.run(flex.id);assert.equal(result.held,true);assert.match(result.reason,/missed/);
});

test('Starter and Growth cannot run contract releases',{timeout:300000},async t=>{
 const f=await setup(t,'enterprise',{currency:'USD',perOrder:1000,perWeek:5000}),{db,ctx,service:s}=f;
 const p=await f.contract({firstRelease:f.today,lastRelease:f.add(f.today,28)});await s.configure(db,ctx,p.id,{revision:1,confirmed:'yes'});const before=await f.orders();
 for(const tier of ['starter','growth']){
  await f.subscribe(tier);const result=await s.onContract(db,ctx.workspaceId,p.id);assert.equal(result.held,true);assert.match(result.reason,/Pro|Custom|plan/);
  await assert.rejects(s.manual(db,ctx,p.slots[0].id,{confirmed:'yes'}),/Pro|Custom|plan/);
  const page=await f.browser.get('/autopilot/blanket-releases/'+p.id).expect(200);assert.match(page.text,/Pro or Custom required/);assert.doesNotMatch(page.text,/>Run the release schedule</);
 }
 assert.equal(await f.orders(),before);
});
