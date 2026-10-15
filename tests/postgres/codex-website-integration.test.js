'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)?.[1];
test('pilot preserves fast navigation and hands native navigation to the customer browser only after verified arrival',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','FOUNDRY_DATABASE_URL'];
 const old=Object.fromEntries(keys.map(k=>[k,process.env[k]])),cleanup=[];
 t.after(async()=>{for(const close of cleanup.reverse())await close();for(const [k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.close();cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const email=randomUUID()+'@example.test',password='Offline!'+randomUUID();
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline website owner',businessName:'Testing',email,password});
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other',businessName:'Other',email:randomUUID()+'@example.test',password});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 Object.assign(process.env,(await require('../../scripts/provision-codex-staging').provision(db,{businessName:'Testing',emails:[email]})).environment);
 process.env.FOUNDRY_DATABASE_URL=cluster.connectionString;
 await db.query(`UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=500000,
  approval_reference='OFFLINE ONLY' WHERE workspace_id=$1`,[ctx.workspaceId]);
 await require('../../scripts/environment-agent-demo/run-pilot').seedPrices(db);
 await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Offline navigation item',baseCode:'NAV-'+randomUUID().slice(0,8),trackingMode:'quantity'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID(),
  aiProvider:{complete:async()=>{throw Error('NO_LIVE_CALLS');}}});cleanup.push(()=>app.locals.sessionStore.close());
 const novel='/screen-'+randomUUID(),label='Workspace review '+randomUUID().slice(0,6);
 // A real rendered route absent from every destination registry.
 app.get(novel,(req,res)=>res.page('attention/ask-capabilities',{title:label,groups:[],query:'',total:0,visibleCount:0}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});cleanup.push(()=>new Promise(resolve=>server.close(resolve)));
 const origin=`http://127.0.0.1:${server.address().port}`;
 const browser=await require('playwright').chromium.launch();cleanup.push(()=>browser.close());
 const page=await browser.newPage(),web=request.agent(app),login=await web.get('/login');
 const signed=await web.post('/login').type('form').send({_csrf:csrf(login.text),email,password});
 const cookie=signed.headers['set-cookie'].find(c=>c.startsWith('foundry.sid='));
 await page.context().addCookies([{name:'foundry.sid',value:cookie.split(';')[0].slice('foundry.sid='.length),url:origin}]);
 const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot');
 const send=async message=>{await page.goto(origin+'/ask');await page.getByLabel('Ask StockChief',{exact:true}).fill(message);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);};
 const businessCounts=async()=>(await db.query(`SELECT (SELECT count(*) FROM movements WHERE workspace_id=$1) AS movements,
  (SELECT count(*) FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1) AS proposals`,[ctx.workspaceId])).rows[0];
 const before=await businessCounts(),times=[];
 for(const [message,target]of [['Open suppliers tab','/suppliers'],['Open customers tab','/customers'],['Open inventory page','/inventory']]){
  const start=performance.now();await send(message);times.push({message,ms:Math.round(performance.now()-start)});
  assert.equal(new URL(page.url()).pathname,target);
 }
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 // A compound request cannot be swallowed by the deterministic shortcut.
 await send('Open suppliers and prepare a new supplier for my approval');
 const compound=await store.latest(db,ctx);assert.equal(compound.status,'READY');await store.cancel(db,ctx,compound.id);
 // Submit the EXACT typo from the recorded live failure. No special matcher.
 await send('Take e to the suppliers tab');const requested=await store.latest(db,ctx);
 assert.equal(requested.original_request,'Take e to the suppliers tab');
 const verification=require('../../src/assistant/postgres-codex-verification');
 await page.getByLabel('Ask StockChief',{exact:true}).fill('Draft prevents navigation while assertions run');
 let nativeCalls=0;
 // Reproduce the recorded four-response sequence through the ACTUAL SDK and
 // restricted browser. Only this offline provider fixture supplies decisions.
 const run=await pilot.run(db,ctx,requested.id,{apiKey:'FAKE',
  image:process.env.STOCKCHIEF_OFFLINE_CODEX_IMAGE||JSON.parse(require('node:fs').readFileSync('data/environment-agent-demo/codex-sdk-approval-handoff/runtime.json')).image,
  countInput:async()=>({object:'response.input_tokens',input_tokens:200}),fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body);nativeCalls++;
   if(nativeCalls===1)return require('../helpers/codex-offline-response')(body,nativeCalls,
    `const b=ALL_TOOLS.find(t=>t.name.endsWith('__environment_browser'));text(await tools[b.name]({action:'inspect',ref:null,value:null}));`);
   const current=await store.get(db,ctx,requested.id),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='environment_browser');
   assert(entry,'The current browser observation is durably recorded independently of other evidence');
   const observed=JSON.parse(entry.text),screen=observed.screen||observed,prefix=observed.screen?'/screen':'';
   assert(Array.isArray(screen.controls),'The recorded browser observation contains live controls: '+JSON.stringify(Object.keys(screen)));
   if(nativeCalls<4){
    const target=screen.controls.find(c=>c.href===(nativeCalls===2?'/purchasing':'/suppliers'));assert(target,JSON.stringify(screen.controls.map(c=>({label:c.label,href:c.href}))));
    return require('../helpers/codex-offline-response')(body,nativeCalls,
     `const b=ALL_TOOLS.find(t=>t.name.endsWith('__environment_browser'));text(await tools[b.name](${JSON.stringify({action:'click',ref:target.ref,value:null})}));`);
   }
   assert.equal(nativeCalls,4);assert.equal(screen.applicationPage,true);
   const recordedFinal={status:'completed',answer:'Opened the Suppliers tab.',claims:[{evidenceId:entry.id,path:prefix+'/title',value:screen.title}]};
   const actor=(await db.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
   const catalogue=await require('../../src/assistant/postgres-control-plane').planningCatalogue(db,ctx,actor);
   assert.equal((await verification.verify(db,ctx,current,JSON.stringify(recordedFinal),catalogue)).verified,false,
    'Recorded title-only final cannot falsely claim user-browser completion');
   return require('../helpers/codex-offline-response').final(body,nativeCalls,JSON.stringify({...recordedFinal,outcome:'navigation',
    navigation:{evidenceId:entry.id,path:prefix+'/url'}}));
  }});
 assert.equal(run.status,'WAITING_EVENT',JSON.stringify({failure:run.checkpoint.harness.failure,interruption:run.checkpoint.harness.interruption,nativeCalls}));assert.equal(nativeCalls,4);
 assert.equal(new URL(page.url()).pathname,'/ask','Private browser arrival is not user-browser arrival');
 await page.getByLabel('Ask StockChief',{exact:true}).fill('');
 await page.waitForURL(origin+'/suppliers',{timeout:15000});
 await page.waitForFunction(()=>document.querySelector('[data-agent-arrival]')?.dataset.confirmed==='true');
 const done=await store.get(db,ctx,requested.id);assert.equal(done.status,'COMPLETED');
 assert.equal(done.checkpoint.harness.completionSource,'user_browser_arrival');
 assert.equal(done.checkpoint.navigation.state,'DELIVERED');
 await page.goto(origin+'/ask');await page.waitForTimeout(3300);assert.equal(new URL(page.url()).pathname,'/ask','Returning to Ask cannot reopen an old destination');
 // Unknown paths use the same host handoff; no route registry additions.
 const inspect=await require('../../scripts/environment-agent-demo/browser').createBrowserTools(browser,{origin});cleanup.push(()=>inspect.close());
 await inspect.context.addCookies(await page.context().cookies());
 await send('Open the newly discovered workspace review');const unknown=await store.latest(db,ctx),active=await store.claim(db,ctx,unknown.id);
 const g=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:active.original_request,goalId:active.id,runToken:active.run_token});
 const s=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:active.id,runToken:active.run_token,candidate:'codex',authorize:g.authorize});
 await page.getByLabel('Ask StockChief',{exact:true}).fill('Keep my unsent draft');
 const screen=await s.execute('environment_browser',{action:'restore'},()=>inspect.restore(origin+novel));
 const state=await store.get(db,ctx,active.id),e=Object.values(state.checkpoint.harness.evidence).at(-1);
 const checked=await verification.verify(db,ctx,state,JSON.stringify({status:'completed',outcome:'navigation',answer:'Ready to open.',
  navigation:{evidenceId:e.id,path:'/url'},claims:[{evidenceId:e.id,path:'/title',value:screen.title}]}),(await g.authorize()).catalogue,{browser:inspect});
 assert.equal(checked.verified,true,JSON.stringify(checked));await s.finish(checked);
 assert.equal((await require('../../scripts/environment-agent-demo/waits').refresh(db,ctx,active.id)).status,'WAITING_EVENT',
  'A pending page handoff must not enqueue another model run after restart');
 await page.getByRole('button',{name:'Open '+label,exact:true}).waitFor();
 assert.equal(new URL(page.url()).pathname,'/ask');assert.equal(await page.getByLabel('Ask StockChief',{exact:true}).inputValue(),'Keep my unsent draft');
 const nav=require('../../src/assistant/postgres-agent-navigation');
 const delivery=await nav.begin(db,ctx,active.id,{automatic:true});assert(delivery);
 assert.equal(await nav.begin(db,ctx,active.id,{automatic:true}),null,'Concurrent tabs cannot both start automatic delivery');
 await db.query("UPDATE users SET role='viewer' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(nav.begin(db,ctx,active.id),/SESSION_AUTHORITY_CHANGED/);
 await db.query("UPDATE users SET role='owner' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await page.getByLabel('Ask StockChief',{exact:true}).fill('');
 await page.getByRole('button',{name:'Open '+label,exact:true}).click();await page.waitForURL(origin+novel);
 await page.waitForFunction(()=>document.querySelector('[data-agent-arrival]')?.dataset.confirmed==='true');
 assert.equal((await store.get(db,ctx,active.id)).status,'COMPLETED');
 await assert.rejects(nav.begin(db,{workspaceId:other.workspaceId,actorId:other.userId},active.id));
 assert.equal((await web.post('/ask/navigation/arrived').set('Accept','application/json').send({token:'bad'})).status,403,'CSRF remains mandatory');
 const progress=(await web.get(`/ask/goals/${active.id}`)).body;assert.equal(progress.navigation,null);assert(!JSON.stringify(progress).includes('tokenHash'));
 // Conversation and page references persist, but a new conversation excludes them.
 await page.getByRole('link',{name:'Ask StockChief',exact:true}).click();
 await page.getByLabel('Ask StockChief',{exact:true}).fill('What is this page for?');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
 const follow=await store.latest(db,ctx);assert.equal(follow.checkpoint.page.path,novel);
 assert(follow.checkpoint.conversation.turns.some(turn=>turn.id===active.id));
 await page.getByRole('button',{name:'New conversation',exact:true}).click();
 await page.getByLabel('Ask StockChief',{exact:true}).fill('Start a separate investigation');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
 const fresh=await store.latest(db,ctx);assert.equal(fresh.checkpoint.conversation.turns.length,0);assert.equal(fresh.checkpoint.page,null);
 await db.query("UPDATE stockchief_runtime.assistant_goals SET status='WAITING_USER',answer='Which date range should I investigate?' WHERE id=$1",[fresh.id]);
 await page.reload();assert.equal(await page.locator('#tell-foundry input[name="continueGoalId"]').inputValue(),fresh.id);
 await page.getByLabel('Ask StockChief',{exact:true}).fill('The previous calendar month');
 await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Continue',exact:true}).click()]);
 const continued=await store.latest(db,ctx);assert.equal(continued.id,fresh.id);assert.equal(continued.status,'READY');
 assert.deepEqual(continued.checkpoint.messages,['The previous calendar month']);
 assert.deepEqual(await businessCounts(),before);
 t.diagnostic(JSON.stringify({fastNavigation:times,paidCalls:0,privateObservationIsNotCompletion:true,unknownRouteDelivered:true}));
});
