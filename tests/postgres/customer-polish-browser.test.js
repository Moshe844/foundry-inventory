'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('briefings dismiss correctly and upload allowance failures stop the browser on every plan',{timeout:300000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,subscribe}=f;
 await db.query('UPDATE accounts SET email_verified_at=now() WHERE id=$1',[f.owner.accountId]);
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();
 f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),base='http://127.0.0.1:'+server.address().port,errors=[];page.on('pageerror',error=>errors.push(error.message));page.setDefaultTimeout(20000);
 await page.goto(base+'/login');await page.getByLabel('Work email').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 const briefing=require('../../src/autopilot/briefing-email'),needs=require('../../src/projections/postgres-service'),uploads=require('../../src/imports/postgres-source-uploads'),jobs=require('../../src/operations/postgres-job-queue');
 for(const [index,plan]of ['starter','growth','pro'].entries())await t.test(plan+' briefing, dismiss, notices and exact allowance',async()=>{
  await subscribe(plan);const day='2026-11-'+String(10+index),data={format:'agent-brief',day,deliveredOn:'2026-11-17',totals:{receive:3,issue:1,transfer:0,adjust:0},business:[2,4,1],actions:2,verified:2,approvals:3,overdue:1,stockOuts:0,runningLow:2};
  await db.query('INSERT INTO workspace_daily_digests(workspace_id,report_date,generated_at,summary) VALUES($1,$2,$3,$4)',[ctx.workspaceId,day,new Date().toISOString(),JSON.stringify(data)]);
  await briefing.setNotices(db,ctx,true);
  const entry=(await needs.needs(db,ctx.workspaceId,ctx.actorId)).find(row=>row.sourceId==='daily-briefing:'+day);assert(entry?.dismiss,'The notice must expose an actual dismissal action');
  await page.goto(base+briefing.path+'?filter='+day);await page.getByRole('heading',{name:'Daily briefing',exact:true}).waitFor();assert.equal(await page.locator('.sc-briefing-metric').count(),4);assert(await page.getByRole('button',{name:'Dismiss this briefing',exact:true}).isVisible());
  await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.setViewportSize({width:1440,height:1000});
  await Promise.all([page.waitForURL(base+'/needs-you'),page.getByRole('button',{name:'Dismiss this briefing',exact:true}).click()]);const remaining=(await needs.needs(db,ctx.workspaceId,ctx.actorId)).find(row=>row.sourceId==='daily-briefing:'+day);assert(!remaining,JSON.stringify({remaining:remaining&&{kind:remaining.kind,href:remaining.href,key:remaining.entryKey},dismissed:(await db.query('SELECT entry_id FROM needs_you_dismissals WHERE workspace_id=$1',[ctx.workspaceId])).rows}));assert.equal((await db.query('SELECT count(*)::int n FROM workspace_daily_digests WHERE workspace_id=$1 AND report_date=$2',[ctx.workspaceId,day])).rows[0].n,1,'Dismissal keeps briefing history');
  await page.goto(base+briefing.path+'?filter='+day);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Hide future briefing notices',exact:true}).click()]);assert.equal(await briefing.noticesEnabled(db,ctx.workspaceId),false);assert.equal((await briefing.inbox(db,ctx.workspaceId)).length,0);await briefing.setNotices(db,ctx,true);
  const policy=await require('../../src/imports/plan-upload-policy').presentation(db,ctx.workspaceId);await page.goto(base+'/onboarding');assert(await page.getByRole('heading',{name:policy.planName+' import allowance',exact:true}).isVisible());assert(await page.getByText('Maximum file sizes',{exact:true}).isVisible());assert(await page.getByText('Records and AI included in your plan',{exact:true}).isVisible());
 });
 await t.test('Starter rejects 25,001 rows before interpretation and hides the running meter',async()=>{
  await subscribe('starter');const source=Buffer.from('Name,SKU,Quantity\n'+Array.from({length:25001},(_,i)=>'Part '+i+',ROW-'+i+',0').join('\n'));
  const saved=await uploads.enqueue(db,ctx,{buffer:source,filename:'starter-row-limit.csv',requestKey:randomUUID(),allowModel:false});
  await page.goto(base+'/settings?section=advanced');assert(await page.locator('[data-source-upload]').filter({hasText:'starter-row-limit.csv'}).isVisible());
  const handler=require('../../src/operations/postgres-runtime-handlers').create({})['import.analyse-source'];const result=await jobs.processOne(db,{'import.analyse-source':handler},{owner:'starter-row-limit-test'});assert.equal(result.status,'PAUSED');assert.equal(result.lastError.code,'entitlement_required');assert.equal(result.lastError.details.requiredRows,25001);
  const panel=page.locator('[data-source-upload]').filter({hasText:'starter-row-limit.csv'});await panel.getByText('This file exceeds your plan allowance',{exact:true}).waitFor();assert(await panel.locator('[data-source-meter]').isHidden());assert(await panel.getByRole('link',{name:'View plans and allowance'}).isVisible());assert(!/Counting the rows/.test(await panel.innerText()));
  assert.doesNotMatch(await panel.innerText(),/once the preview is ready/);
  await panel.getByRole('button',{name:'Dismiss notice',exact:true}).click();assert.equal(await panel.count(),0,'The stopped global notice is removed immediately');
  assert.equal(new URL(page.url()).searchParams.get('section'),'advanced','Dismissing keeps the current page');
  await page.reload();assert.equal(await page.locator('[data-source-upload]').filter({hasText:'starter-row-limit.csv'}).count(),0,'Stopped work does not reappear as a global loading notice');
  await page.goto(base+'/imports');assert(await page.getByText('starter-row-limit.csv',{exact:true}).first().isVisible(),'The saved file remains in import history');
  const retained=(await db.query('SELECT u.source_content,j.status FROM import_source_uploads u JOIN stockchief_runtime.jobs j ON j.id=u.job_id WHERE u.id=$1',[saved.id])).rows[0];assert(retained.source_content);assert.equal(retained.status,'PAUSED','Dismissal never retries or bypasses the plan refusal');
  assert.equal((await uploads.get(db,ctx.workspaceId,saved.id)).active,false);assert.equal((await db.query('SELECT count(*)::int n FROM import_plans WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);assert.equal(await f.balance(),4);
 });
 assert.deepEqual(errors,[]);
});
