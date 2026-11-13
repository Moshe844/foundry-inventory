'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Job 179 is alone on every plan: staff ask "how do I…" in the app and get the
// guide's instructions for their role and plan, with a link to the page where
// the work is done. The guide covers the newer work: pick waves, put-aways,
// delivery checks, bin moves, staff tasks, team procedures, the team summary,
// returns, transfers, purchase requests and pausing. Every link it offers must
// open for the person asking.
test('the staff guide answers how-to questions for each role and plan, and every link it offers opens',{timeout:900000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:4}),{db,ctx,browser,subscribe}=f,ws=ctx.workspaceId;
 const guide=require('../../src/assistant/staff-guide'),policy=require('../../src/commercial/agent-plan');
 const ask=require('../../src/assistant/postgres-capability-registry').registry.get('read.staff_guide');
 const request=require('supertest'),app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 t.after(()=>app.locals.sessionStore.close());
 await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
 // Ana works anywhere; Ben is limited to Dispatch.
 const member=async(name,locations)=>{
  const email=randomUUID()+'@example.test',home=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name,businessName:name+' home',email,password:f.password}),id=randomUUID();
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,permissions,warehouse_location_ids,created_at) VALUES($1,$2,$3,$4,'staff',NULL,$5::jsonb,now()::text)",[id,ws,home.accountId,name,locations?JSON.stringify(locations):null]);
  const agent=request.agent(app),login=await agent.get('/login');
  await agent.post('/login').type('form').send({_csrf:f.csrf(login.text),email,password:f.password}).expect(302);
  const list=await agent.get('/inventories').expect(200);
  await agent.post('/inventories/switch').type('form').send({_csrf:f.csrf(list.text),workspaceId:ws}).expect(303);
  return {ctx:{workspaceId:ws,actorId:id},agent,email,name};
 };
 const ana=await member('Ana floor',null),ben=await member('Ben dock',[f.location.id]),owner={ctx,agent:browser,name:'Owner'};
 const titles=async(who,q)=>(await guide.read(db,who.ctx,q)).topics.map(x=>x.title);
 const first=async(who,q)=>(await titles(who,q))[0];
 // Shown: the topic is the first answer. Not shown: it is not offered at all.
 const expect=async(who,q,title,shown)=>{if(shown)assert.equal(await first(who,q),title,who.name+' '+q);else assert.equal((await titles(who,q)).includes(title),false,who.name+' '+q);};
 const jobs={'Pick orders on a wave':57,'Put away received goods':47,'Inspect a delivery on hold':51,'Move stock to the right bin':11,'See my tasks':177,'Give staff their tasks':177,
  'Follow a team procedure':178,'Write a procedure from your team’s work':178,'Read the daily team summary':180,'Receive a stock transfer':124,'Ask for a purchase':41,'Get low-stock alerts by email':166,'Plan the year-end stocktake':16};

 for(const tier of [null,'starter','growth','pro','enterprise']){
  if(tier)await subscribe(tier);
  const state=await policy.accountState(db,ws),agentTerms=policy.usesAgentTerms(state);
  for(const who of [owner,ana,ben]){
   const all=(await guide.read(db,who.ctx,'')).topics;
   assert.ok(all.length>0,tier+' '+who.name);
   for(const topic of all){
    // Plan: a topic for agent work shows only when the plan includes it.
    if(jobs[topic.title])assert.equal(agentTerms&&policy.permits(state.plan,jobs[topic.title],'suggest'),true,tier+' '+who.name+' '+topic.title);
    // The link opens for this person, without being sent elsewhere.
    const page=await who.agent.get(topic.href).redirects(0);
    assert.equal(page.status,200,tier+' '+who.name+' '+topic.title+' '+topic.href+' '+page.status+' '+(page.headers.location||''));
   }
  }
  const paid=['growth','pro','enterprise'].includes(tier);
  // Questions about the newer work, answered for the right person and plan.
  await expect(ana,'How do I pick a wave?','Pick orders on a wave',paid);
  await expect(ana,'Where are my tasks?','See my tasks',paid);
  await expect(ben,'Where are my tasks?','See my tasks',paid);
  await expect(owner,'How do I give tasks to my staff?','Give staff their tasks',paid);
  await expect(ana,'How do I inspect a delivery on hold?','Inspect a delivery on hold',paid);
  await expect(ben,'How do I put away goods?','Put away received goods',paid);
  await expect(ana,'Which procedure do I follow?','Follow a team procedure',paid);
  await expect(owner,'Where is the daily team summary?','Read the daily team summary',paid);
  await expect(ana,'How do I move stock from the wrong bin?','Move stock to the right bin',['pro','enterprise'].includes(tier));
  assert.equal(await first(owner,'How do I take back a customer return?'),'Take back a customer return');
  assert.equal(await first(ana,'How do I pause StockChief?'),'Pause StockChief');
  // Roles: staff limited to a warehouse never get pages they cannot open.
  assert.equal((await titles(ben,'How do I pick a wave?')).includes('Pick orders on a wave'),false);
  assert.equal((await titles(ben,'How do I inspect a delivery on hold?')).includes('Inspect a delivery on hold'),false);
  assert.equal((await titles(owner,'Where are my tasks?')).includes('See my tasks'),false,'The owner gets the owner topic instead.');
  assert.equal((await titles(ana,'How do I give tasks to my staff?')).includes('Give staff their tasks'),false);
  assert.deepEqual(await titles(ben,'How do I change purchasing authority?'),[]);
  // Ask reads the same guide.
  if(tier){
   const answer=await ask.prepare(null,db,ana.ctx,'How do I pick a wave?',{});
   assert.equal(answer.rows.some(r=>r.destination==='/warehouse/operations'),paid,tier);
  }
 }

 // The guide page reads well for the owner and on a limited worker's phone.
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));}),chrome=await require('playwright').chromium.launch();
 t.after(async()=>{await chrome.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const base='http://127.0.0.1:'+server.address().port,folder=require('node:path').join(process.cwd(),'output','agent-plan-review');require('node:fs').mkdirSync(folder,{recursive:true});
 const signIn=async(tab,email)=>{await tab.goto(base+'/login');await tab.getByLabel('Work email').fill(email);await tab.locator('[name=password]').fill(f.password);
  await Promise.all([tab.waitForNavigation(),tab.getByRole('button',{name:'Sign in',exact:true}).click()]);};
 for(const [name,viewport,phone] of [['desktop',{width:1366,height:900},false],['phone',{width:390,height:844},true]]){
  const tab=await chrome.newPage({viewport,isMobile:phone,hasTouch:phone});tab.setDefaultTimeout(15000);
  await signIn(tab,f.email);await tab.goto(base+'/guide?q='+encodeURIComponent('daily team summary'));
  assert(await tab.getByText('Read the daily team summary').first().isVisible());
  assert(await tab.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' must not scroll sideways');
  await tab.screenshot({path:require('node:path').join(folder,'staff-guide-'+name+'.png'),fullPage:true});
  await tab.close();
 }
 const mobile=await chrome.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});mobile.setDefaultTimeout(15000);
 await signIn(mobile,ben.email);await mobile.goto(base+'/inventories');
 await mobile.request.post(base+'/inventories/switch',{form:{_csrf:await mobile.locator('[name=_csrf]').first().inputValue(),workspaceId:ws}});
 await mobile.goto(base+'/guide');await mobile.getByLabel('How do I…?').fill('Where are my tasks?');
 await Promise.all([mobile.waitForNavigation(),mobile.getByRole('button',{name:'Find instructions'}).click()]);
 await Promise.all([mobile.waitForNavigation(),mobile.getByRole('link',{name:'Open my tasks'}).click()]);
 assert.equal(new URL(mobile.url()).pathname,'/warehouse/staff-tasks');
 assert(await mobile.getByRole('heading',{name:'My tasks'}).isVisible());
 await mobile.goto(base+'/guide?q='+encodeURIComponent('Where are my tasks?'));
 assert(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await mobile.screenshot({path:require('node:path').join(folder,'staff-guide-limited-phone.png'),fullPage:true});
});
