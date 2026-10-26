'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('native approval display uses readable records without changing approval authority',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 f.cleanup(()=>{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 const store=require('../../src/assistant/postgres-goal-store'),handoff=require('../../scripts/environment-agent-demo/approval-handoff'),service=require('../../src/assistant/postgres-service'),display=require('../../src/web/proposal-presentation'),revision=require('../../src/assistant/approval-revision');
 const goal=await store.create(db,ctx,'Use concise answers'),prefs={answerLanguage:'he',answerStyle:'Short answers',timeZone:'America/New_York'},raw='Save preferences: '+JSON.stringify(prefs),prepared=await service.createProposal(db,ctx,goal.original_request,'settings.ask_preferences',prefs,raw),id=prepared.proposal.id;
 const h={calls:{prepared:{state:'DONE',result:{outcomes:[{result:{proposal:{id}}}]}}}},cards=await handoff.stage(db,ctx,goal,h);assert.equal(cards.length,1);
 const answer='Approval required. These changes are prepared, not executed:\n- '+raw;
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_APPROVAL',answer=$3,checkpoint=$2::jsonb WHERE id=$1",[goal.id,JSON.stringify({runtime:'codex-staging',harness:h}),answer]);
 const original=await service.getProposal(db,ctx.workspaceId,id),digest=revision.digest(revision.snapshot('business',original));
 await t.test('canonical declared accounting effects are retained alongside record identity',()=>{assert.equal(display.impact('customer_return.credit_receipt'),'Changes accounting');assert.equal(display.impact('report.template.schedule'),'Changes a saved report');assert.equal(display.impact('settings.ask_preferences'),'Changes Ask preferences');});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'approval-presentation-fixture'}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));}),browser=await require('playwright').chromium.launch();f.cleanup(async()=>{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});
 const page=await browser.newPage(),origin='http://127.0.0.1:'+server.address().port;await page.goto(origin+'/login');await page.locator('[name=email]').fill(f.email);await page.locator('[name=password]').fill(f.password);await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
 await t.test('Home and native chat format existing frozen preferences, with the exact original decision digest',async()=>{
  await page.goto(origin+'/');const home=await page.locator('#needs-you').innerText();assert.match(home,/Update Ask preferences: Short answers/);assert(!home.includes('"answerStyle"'));
  await page.goto(origin+'/ask?goal='+goal.id);const card=page.locator('[data-approval-id]');assert.match(await card.innerText(),/Short answers/);assert.match(await card.innerText(),/Answer language/i);assert(!(await page.locator('[data-adaptive-goal]').innerText()).includes('"answerStyle"'));assert.equal(await card.locator('[name=sha256]').inputValue(),digest);
  const progress=await page.request.get(origin+'/ask/goals/'+goal.id),body=await progress.json();assert.match(body.answer,/Update Ask preferences/);assert(!JSON.stringify(body.conversation).includes('\\"answerStyle\\"'));
  const after=await service.getProposal(db,ctx.workspaceId,id);assert.equal(revision.digest(revision.snapshot('business',after)),digest);assert.equal(after.status,'PENDING');assert.equal(after.summary,raw);assert.equal((await db.query('SELECT count(*) n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 });
 await t.test('new preference proposals and nested report fields use the same readable presentation',async()=>{
  const next=await service.prepareAction(db,ctx,'Answer clearly',{action:'settings.ask_preferences',answerPreferences:JSON.stringify({answerStyle:'Plain explanations'})});assert.match(next.proposal.summary,/Update Ask preferences: Plain explanations/);assert(!next.proposal.summary.includes('{'));
  const rows=display.fields({reportSchedule:JSON.stringify({frequency:'weekly',hour:17,minute:30,timeZone:'America/New_York'}),expectedHash:'private',answerPreferences:JSON.stringify({answerStyle:'Bullets'})});assert(rows.some(r=>/^Report schedule · Minute$/i.test(r.label)&&r.value==='30'));assert(!rows.some(r=>/^Expected hash$/i.test(r.label)));assert(!rows.some(r=>r.value.includes('{')));
 });
});
