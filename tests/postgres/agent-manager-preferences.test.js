'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto'),path=require('node:path');

// Job 214, Custom only: each manager's report and approval preferences,
// learned from that manager's own repeated choices and never from anyone
// else's, set or reset by them, and always overridden by an explicit choice.
test('each Custom manager’s reports and approvals follow what that manager chooses, visibly and resettably',{timeout:900000},async t=>{
  const prior=process.env.FOUNDRY_PUBLIC_URL;process.env.FOUNDRY_PUBLIC_URL='https://stockchief.example.test';
  t.after(()=>{if(prior===undefined)delete process.env.FOUNDRY_PUBLIC_URL;else process.env.FOUNDRY_PUBLIC_URL=prior;});
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const prefs=require('../../src/reports/manager-presentation'),path_='/reports/my-preferences';
  const calendar=await require('../../src/lib/business-time').forWorkspace(db,ws),{bounds}=require('../../src/reports/relative-dates');
  const choices=async(actor=ctx.actorId)=>Number((await db.query('SELECT count(*) n FROM stockchief_runtime.manager_preference_choices WHERE workspace_id=$1 AND actor_id=$2',[ws,actor])).rows[0].n);
  const thrice=async fn=>{for(let i=0;i<3;i++)await fn(i);};
  const view=()=>prefs.personal(db,ctx);

  // Starter, Growth and Pro: nothing is remembered or learned.
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);
    assert.match((await browser.get(path_).expect(402)).text,/data-agent-plan-locked/);
    await thrice(()=>browser.get('/needs-you?sort=oldest').expect(200));
    assert.equal(await choices(),0);assert.equal(await view(),null);
  }

  await subscribe('enterprise');
  let page=await browser.get(path_).expect(200);
  assert.equal((page.text.match(/data-preference-source="Standard"/g)||[]).length,Object.keys(prefs.choices).length);

  // Decision order: the same choice three times in a row becomes the preference.
  await browser.get('/needs-you?sort=oldest').expect(200);await browser.get('/needs-you?sort=oldest').expect(200);
  assert.equal((await view()).inbox_sort,'priority','two choices are not yet a habit');
  await browser.get('/needs-you?sort=oldest').expect(200);
  assert.equal((await view()).inbox_sort,'oldest');
  assert.match((await browser.get('/needs-you').expect(200)).text,/data-decision-sort="oldest"/);
  assert.match((await browser.get('/needs-you?sort=priority').expect(200)).text,/data-decision-sort="priority"/,'an explicit choice wins on the page');
  // A broken run of choices teaches nothing.
  for(const sort of ['newest','newest','priority'])await browser.get('/needs-you?sort='+sort).expect(200);
  assert.equal((await view()).inbox_sort,'oldest');

  // What Needs you shows first, and grouped or one-by-one approvals.
  await thrice(()=>browser.get('/needs-you?category=approval&picked=category').expect(200));
  await thrice(()=>browser.get('/needs-you?groups=one_by_one').expect(200));
  let mine=await view();
  assert.equal(mine.inbox_category,'approval');assert.equal(mine.approval_grouping,'one_by_one');
  const {present}=require('../../src/web/needs-you-presentation');
  const desk=present([{kind:'approval',title:'Approve order',href:'/a',priority:80},{kind:'mail',title:'Message',href:'/m',priority:70},{kind:'inventory',title:'Count',href:'/i',priority:60}],
    {category:mine.inbox_category},'priority',mine.inbox_category);
  assert.equal(desk.rows.length,1);assert.match(desk.groups.find(g=>g.key==='all').href,/category=all/,'Everything stays one tap away');

  // Report dates: only a picked date range counts, not dates carried by links.
  const last7=bounds('last_7_days',calendar),last30=bounds('last_30_days',calendar);
  await thrice(()=>browser.get('/reports').query(last7).expect(200));
  assert.equal((await view()).report_period,'default');
  await thrice(()=>browser.get('/reports').query({...last30,picked:'period'}).expect(200));
  assert.equal((await view()).report_period,'last_30_days');
  assert.match((await browser.get('/reports').expect(200)).text,new RegExp('name="from" value="'+last30.from+'"'));

  // Rows on item reports.
  await thrice(()=>browser.get('/reports/business/sellers').query({view:'items',picked:'view'}).expect(200));
  assert.equal((await view()).report_view,'items');
  assert.match((await browser.get('/reports/business/sellers').expect(200)).text,/segmented__item is-on" href="[^"]*view=items/);
  assert.match((await browser.get('/reports/business/sellers?view=variants').expect(200)).text,/segmented__item is-on" href="[^"]*view=variants/);

  // Download format, from the downloads the manager actually takes.
  const saved=await require('../../src/reports/postgres-service').save(db,ctx,{role:'owner',email:f.email},{dataset:'stock',title:'Manager stock',columns:['sku','on_hand'],sort:'sku'});
  await thrice(()=>browser.get('/reports/saved/'+saved.id+'/export.pdf').expect(200));
  assert.equal((await view()).download_format,'pdf');
  assert.match((await browser.get('/reports/saved/'+saved.id).expect(200)).text,/>Download PDF<\/a>/);

  // The hour of new scheduled reports, from the schedules they save.
  const builder=await browser.get('/reports/builder').expect(200);
  for(let i=0;i<3;i++)await browser.post('/reports/save').type('form').send({_csrf:f.csrf(builder.text),
    definition:JSON.stringify({dataset:'stock',title:'Morning stock '+i,columns:['sku','on_hand'],sort:'sku'}),frequency:'daily',hour:7,minute:0,weekday:1}).expect(303);
  assert.equal((await view()).report_hour,7);
  assert.match((await browser.get('/reports/builder').expect(200)).text,/name="hour" min="0" max="23" value="7"/);

  // Every preference shows where it came from.
  page=await browser.get(path_).expect(200);
  for(const key of ['inbox_sort','inbox_category','approval_grouping','report_period','report_view','download_format','report_hour'])
    assert.match(page.text,new RegExp('data-preference="'+key+'" data-preference-source="Learned from your last 3 choices"'));

  // Another manager's choices never change the owner's preferences.
  const second=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Second manager',businessName:'Independent space',email:randomUUID()+'@example.test',password:f.password});
  const colleague={workspaceId:ws,actorId:randomUUID()};
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,$3,'Reporting manager','accountant',now()::text)",[colleague.actorId,ws,second.accountId]);
  await thrice(()=>prefs.note(db,colleague,'inbox_sort','newest'));
  await thrice(()=>prefs.note(db,colleague,'download_format','csv'));
  assert.equal((await prefs.personal(db,colleague)).inbox_sort,'newest');
  mine=await view();assert.equal(mine.inbox_sort,'oldest');assert.equal(mine.download_format,'pdf');

  // How approvals reach this manager: only the owner's channel they keep.
  await db.query(`INSERT INTO stockchief_runtime.agent_alert_channels(workspace_id,job_id,sms,push,authorized_by) VALUES($1,175,true,true,$2)
    ON CONFLICT(workspace_id,job_id) DO UPDATE SET sms=true,push=true`,[ws,ctx.actorId]);
  page=await browser.get(path_).expect(200);
  assert.match(page.text,/Approvals go out by text and push, as the owner chose/);
  await browser.post(path_).type('form').send({_csrf:f.csrf(page.text),revision:(await view()).revision,report_period:'last_30_days',download_format:'pdf',
    inbox_sort:'oldest',approval_channel:'push'}).expect(303);
  mine=await view();assert.equal(mine.approval_channel,'push');assert.equal(mine.learned.inbox_sort.value,'oldest','unchanged learned preferences stay learned');
  const links=require('../../src/autopilot/approval-links'),policy=require('../../src/commercial/agent-plan');
  const link=async title=>{const id=randomBytes(24).toString('base64url');await db.query(`INSERT INTO stockchief_runtime.agent_approval_links(id,workspace_id,user_id,item_key,source_id,href,title,revision,expires_at)
    VALUES($1,$2,$3,$4,$4,'/needs-you',$5,'1',now()+interval '1 day')`,[id,ws,ctx.actorId,randomUUID().slice(0,32),title]);return id;};
  const deliver=()=>db.transaction(async c=>links.deliver(c,ws,await policy.accountState(c,ws),(await c.query('SELECT * FROM stockchief_runtime.agent_alert_channels WHERE workspace_id=$1 AND job_id=175',[ws])).rows[0],{manual:true}));
  const sent=async id=>(await db.query('SELECT sms_batch,push_batch FROM stockchief_runtime.agent_approval_links WHERE id=$1',[id])).rows[0];
  const pushOnly=await link('Approve a purchase');await deliver();
  assert.equal((await sent(pushOnly)).sms_batch,'not-wanted','no text for a manager who keeps approvals to push');
  assert.equal((await links.review(db,ctx,{page:1})).rows.find(r=>r.Approval==='Approve a purchase').Sent,'Not yet');

  // Reset one preference, then all of them.
  page=await browser.get(path_).expect(200);
  await browser.post(path_+'/reset').type('form').send({_csrf:f.csrf(page.text),preference:'inbox_sort'}).expect(303);
  mine=await view();assert.equal(mine.inbox_sort,'priority');assert.equal(mine.learned.inbox_sort,undefined);
  assert.equal(Number((await db.query("SELECT count(*) n FROM stockchief_runtime.manager_preference_choices WHERE workspace_id=$1 AND actor_id=$2 AND preference='inbox_sort'",[ws,ctx.actorId])).rows[0].n),0);
  await browser.post(path_+'/reset').type('form').send({_csrf:f.csrf(page.text),preference:'all'}).expect(303);
  mine=await view();
  for(const [key,value] of Object.entries(prefs.standard))assert.equal(mine[key],value,key);
  const both=await link('Approve a transfer');await deliver();
  assert.equal((await sent(both)).sms_batch,null,'with the standard, every channel the owner chose is tried');
  assert.equal(await choices(),0);

  // Downgrade: standard views; the saved preferences come back on Custom.
  await thrice(()=>browser.get('/needs-you?sort=newest').expect(200));
  await subscribe('pro');
  assert.equal(await view(),null);
  assert.match((await browser.get('/needs-you').expect(200)).text,/data-decision-sort="priority"/);
  await subscribe('enterprise');
  assert.equal((await view()).inbox_sort,'newest');

  // The page reads well on a desktop and on a 390 px phone.
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  const listener=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const chrome=await require('playwright').chromium.launch();
  t.after(async()=>{await chrome.close();listener.closeAllConnections();await new Promise(r=>listener.close(r));await app.locals.sessionStore.close();});
  const base='http://127.0.0.1:'+listener.address().port,folder=path.join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
  for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
    const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
    await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(f.email);await tab.locator('[name=password]').fill(f.password);
    await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);
    await tab.goto(base+path_);
    assert(await tab.getByText('Learned from your last 3 choices').first().isVisible());
    assert(await tab.getByRole('button',{name:'Save my preferences'}).isVisible());
    assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
    await tab.screenshot({path:path.join(folder,'manager-preferences-'+name+'.png'),fullPage:true});
    await tab.close();
  }
});
