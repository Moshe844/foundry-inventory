'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
const decision=(action,extra={})=>({action,progress:'Checking the recorded business details.',query:'',steps:[],answer:'',evidence:[],...extra});
const YIDDISH='נעם מיר צו דו סטאק טעב';// "take me to the stock tab", spelled by sound
// Staging, 2026-11-11, Hendels shoes (hosted business agent, answer style saved):
// 14:59 a reply to a waiting question: the agent called navigate.inventory, said
//   "I've opened the Inventory page" and COMPLETED with no page hand-off.
// 16:00 the same words as a new request: the agent said "done" before doing
//   anything, tried a tool it had not searched for, and gave up ("Could not finish").
async function setup(t){
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS','STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE','STOCKCHIEF_AI_METER','ANTHROPIC_API_KEY'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 // No real model: the Yiddish is not read in English, so it reaches the agent as it did on staging.
 delete process.env.ANTHROPIC_API_KEY;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'pro','COMP','CUSTOM','OFFLINE_FIXTURE')",[randomUUID(),owner.accountId]);
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_AI_METER='credits';
 const provision=require('../../scripts/provision-codex-staging');Object.assign(process.env,(await provision.provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=2000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await provision.shareWithOwnedBusinesses(db,{fundingWorkspaceId:ctx.workspaceId,accountId:owner.accountId});process.env.STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS='1';process.env.STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE=ctx.workspaceId;
 // As on staging, a saved answer style sends Ask to the hosted business agent.
 await require('../../src/assistant/postgres-answer-preferences').save(db,ctx,{answerStyle:'short bullet points'});
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const web=request.agent(app),login=await web.get('/login');
 await web.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
 const ask=await web.get('/ask');assert.equal(ask.status,200);
 const {PRICED_MODEL,pricedUsage}=require('../helpers/postgres-model-fixture');
 // The model is a script: next(prompt,actions) returns its decision for each turn.
 function model(next){const turns=[];return {turns,provider:{name:'anthropic',model:PRICED_MODEL,async complete(request){
  if(request.schemaName==='stockchief_adaptive_verification')return {usage:pricedUsage(),data:{complete:true,grounded:true,reason:''}};
  assert.equal(request.schemaName,'stockchief_adaptive_goal');const prompt=JSON.parse(request.prompt),actions=request.schema.properties.action.enum;
  turns.push({prompt,actions,system:request.system});return {usage:pricedUsage(),data:next(prompt,actions,turns.length)||decision('ask',{answer:'Unexpected extra turn.'})};
 }}};}
 return {...f,web,ask,model,store:require('../../src/assistant/postgres-goal-store'),pilot:require('../../src/assistant/postgres-codex-pilot'),
  controller:require('../../src/assistant/postgres-goal-controller')};
}
// What adaptive-goal.js does: submit the hand-off, land on the page, acknowledge arrival.
async function followHandOff(s,goalId,href,label){
 const progress=(await s.web.get('/ask/goals/'+goalId)).body;
 assert.equal(progress.conversation.phase,'navigation');
 assert.deepEqual({label:progress.navigation.label,state:progress.navigation.state,automatic:progress.navigation.automatic},{label,state:'PENDING',automatic:true});
 assert(!JSON.stringify(progress).includes('tokenHash'));
 const page=await s.web.get('/ask?goal='+goalId);
 assert.match(page.text,new RegExp('action="/ask/goals/'+goalId+'/navigate" data-goal-navigation >'),'The hand-off form is shown, not hidden');
 assert.match(page.text,new RegExp('data-navigation-label type="submit">Open '+label+'<'));
 const moved=await s.web.post('/ask/goals/'+goalId+'/navigate').type('form').send({_csrf:csrf(page.text),automatic:'1'});
 assert.equal(moved.status,303);assert.equal(moved.headers.location,href);
 const landed=await s.web.get(href);assert.equal(landed.status,200);
 const arrival=/data-agent-arrival data-token="([a-f0-9]{64})" data-csrf="([^"]+)"/.exec(landed.text);
 assert(arrival,'The destination page carries the arrival acknowledgement');
 const ack=await s.web.post('/ask/navigation/arrived').set('Accept','application/json').set('x-csrf-token',arrival[2]).send({token:arrival[1]});
 assert.equal(ack.status,200);assert.equal(ack.body.delivered,true);
 const done=await s.store.get(s.db,s.ctx,goalId);
 assert.equal(done.status,'COMPLETED');assert.equal(done.checkpoint.navigation.state,'DELIVERED');
 assert.equal(done.answer,`Opened ${label} in your browser.`);
 assert.equal((await s.web.get('/ask/goals/'+goalId)).body.navigation,null,'A delivered page is not handed over twice');
}

test('a page the hosted agent opens on a continuation reply is handed to the browser and completes on arrival',{timeout:180000},async t=>{
 const s=await setup(t),{db,ctx,web,ask,store,pilot,controller}=s;
 // First run: the agent cannot tell what "Shoe me all custom" means and asks.
 const started=await pilot.start(db,ctx,'Shoe me all custom');
 assert.equal((await store.get(db,ctx,started.goalId)).checkpoint.runtime,'hosted-business');
 const first=s.model(()=>decision('ask',{answer:'What outcome should I prioritize?'}));
 assert.equal((await controller.run(db,ctx,started.goalId,{provider:first.provider})).goalStatus,'WAITING_USER');
 const asking=(await web.get('/ask/goals/'+started.goalId)).body;
 assert.equal(asking.conversation.phase,'clarification');
 // The owner answers in the Ask box, as a reply to that waiting goal.
 const replied=await web.post('/ask').type('form').send({_csrf:csrf(ask.text),message:YIDDISH,continueGoalId:started.goalId,questionId:asking.conversation.input.id});
 assert.equal(replied.status,303);assert.match(replied.headers.location,new RegExp('goal='+started.goalId));
 const ready=await store.get(db,ctx,started.goalId);
 assert.equal(ready.status,'READY');assert.deepEqual(ready.checkpoint.messages,[YIDDISH]);
 // Second run: the agent opens the stock page and claims, too early, that it is open.
 const plan=[decision('discover',{query:'navigate.inventory'}),
  decision('operate',{steps:[{capability:'navigate.inventory',arguments:[],dependsOn:[]}]}),
  decision('finish',{answer:"I've opened the Inventory page for you, where you can view all stock items.",evidence:[0]})];
 const second=s.model(()=>plan.shift());
 await controller.run(db,ctx,started.goalId,{provider:second.provider});
 assert.equal(plan.length,0,'The agent used every planned turn');
 assert.deepEqual(second.turns.at(-1).prompt.userMessages,[YIDDISH],'The agent worked from the owner\'s reply');
 const handed=await store.get(db,ctx,started.goalId);
 assert.equal(handed.status,'WAITING_EVENT','The goal waits for the browser, not COMPLETED: '+handed.answer);
 assert.equal(handed.checkpoint.navigation.state,'PENDING');assert.equal(handed.checkpoint.navigation.href,'/inventory');
 assert.equal(handed.answer,'Ready to open Inventory in your browser.');
 assert.doesNotMatch(handed.answer,/opened/i,'Nothing claims the page opened before the browser arrives');
 assert.equal((await require('../../src/assistant/postgres-goal-resume').refresh(db,ctx,started.goalId)).status,'WAITING_EVENT',
  'A pending page hand-off is not re-run by the dependency sweep');
 await followHandOff(s,started.goalId,'/inventory','Inventory');
});

test('a new page request reaches the page even when the agent tries to finish first and skips searching',{timeout:180000},async t=>{
 const s=await setup(t),{db,ctx,web,ask,store,controller}=s;
 const sent=await web.post('/ask').type('form').send({_csrf:csrf(ask.text),message:YIDDISH});
 assert.equal(sent.status,303);const goalId=new URL(sent.headers.location,'http://x').searchParams.get('goal');assert(goalId,sent.headers.location);
 const goal=await store.get(db,ctx,goalId);
 assert.equal(goal.checkpoint.runtime,'hosted-business');assert.equal(goal.original_request,YIDDISH);
 // The 16:00 model: announce the move as finished; if that is not offered, call the
 // page tool straight from the directory without a search; finish once it has run.
 const behaviour=s.model((prompt,actions)=>{
  if(actions.includes('finish')&&!prompt.observations.length)return decision('finish',{answer:'Moving you to the stock tab.',evidence:[]});
  if(!prompt.observations.length){assert.match(prompt.directory,/\bnavigate\.inventory\b/);
   return decision('operate',{steps:[{capability:'navigate.inventory',arguments:[],dependsOn:[]}]});}
  return decision('finish',{answer:'I moved you to the stock tab.',evidence:[prompt.observations.at(-1).index]});
 });
 await controller.run(db,ctx,goalId,{provider:behaviour.provider});
 assert.deepEqual(behaviour.turns[0].actions,['discover','operate','ask'],'Nothing done yet, so finishing is not on offer');
 assert(behaviour.turns[1].actions.includes('finish'),'Once the page tool has run, the agent can finish');
 assert(behaviour.turns.every(turn=>turn.system.includes('"style":"short bullet points"')),'The saved answer style reaches the agent on every turn');
 const handed=await store.get(db,ctx,goalId);
 assert.equal(handed.status,'WAITING_EVENT',handed.answer);assert.equal(behaviour.turns.length,2,'Two turns: open the page, then finish');
 assert.equal(handed.recoveries,0,'No wasted attempts');
 assert.equal(handed.checkpoint.navigation.href,'/inventory');assert.equal(handed.answer,'Ready to open Inventory in your browser.');
 await followHandOff(s,goalId,'/inventory','Inventory');
});

// Staging, 16:25: the agent opened Inventory correctly, but the owner's network
// (an HTTPS filter) held the live update stream back, so the page sat on
// "Waiting to start" until the owner pressed Stop. Separately, the page treated
// the hidden text of the "Ask next" suggestions as an unsent draft and never
// moved on its own. A real browser must follow the hand-off with the stream
// held back and with it working.
test('the Ask page opens the requested page by itself, whether its live updates arrive or are held back',{timeout:300000},async t=>{
 const s=await setup(t),{db,ctx,store,controller}=s;
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()}),server=await new Promise(ok=>{const l=app.listen(0,'127.0.0.1',()=>ok(l));}),origin='http://127.0.0.1:'+server.address().port,browser=await require('playwright').chromium.launch();
 t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(ok=>server.close(ok));await app.locals.sessionStore.close();});
 for(const holdStream of [true,false]){
  const page=await (await browser.newContext({viewport:{width:1280,height:800}})).newPage();
  let held=0,streamed=0;
  if(holdStream)await page.route('**/ask/goals/*/stream',()=>{held++;});// never answered, like a buffering filter
  page.on('response',r=>{if(r.url().endsWith('/stream'))streamed++;});
  await page.goto(origin+'/login');await page.getByLabel('Work email').fill(s.email);await page.locator('[name=password]').fill(s.password);
  await Promise.all([page.waitForNavigation(),page.getByRole('button',{name:'Sign in',exact:true}).click()]);
  await page.goto(origin+'/ask');
  await page.getByRole('textbox',{name:'Ask StockChief',exact:true}).fill(YIDDISH);
  await Promise.all([page.waitForURL(/[?&]goal=/),page.getByRole('button',{name:'Continue',exact:true}).click()]);
  const goalId=new URL(page.url()).searchParams.get('goal');assert(goalId);
  assert(await page.locator('input[type="hidden"][name="message"]').count()>0,'"Ask next" suggestions (hidden message inputs) are on the page');
  // The worker's run: open the page, then finish.
  const plan=[decision('operate',{steps:[{capability:'navigate.inventory',arguments:[],dependsOn:[]}]}),decision('finish',{answer:'Opening the stock tab.',evidence:[0]})];
  await controller.run(db,ctx,goalId,{provider:s.model(()=>plan.shift()).provider});
  assert.equal((await store.get(db,ctx,goalId)).status,'WAITING_EVENT');
  const started=Date.now();
  try{await page.waitForURL(origin+'/inventory',{timeout:30000});}catch(e){
   t.diagnostic('NOT FOLLOWED '+JSON.stringify({holdStream,url:page.url(),state:await page.evaluate(()=>({phase:document.querySelector('[data-goal-phase-text]')?.textContent,
    hint:document.querySelector('[data-goal-hint]')?.textContent,status:document.querySelector('[data-adaptive-goal]')?.dataset.goalStatus}))}));throw e;}
  const seconds=(Date.now()-started)/1000;
  await page.waitForFunction(()=>document.querySelector('[data-agent-arrival]')?.dataset.confirmed==='true',null,{timeout:15000});
  if(holdStream)assert(held>=1,'The live stream really was held back');else assert(streamed>=1,'The live stream really was used');
  const done=await store.get(db,ctx,goalId);
  assert.equal(done.status,'COMPLETED');assert.equal(done.answer,'Opened Inventory in your browser.');
  assert(seconds<=(holdStream?12:20),(holdStream?'Held':'Live')+' stream: followed after '+seconds+'s');
  t.diagnostic(JSON.stringify({holdStream,secondsToFollow:Math.round(seconds*10)/10}));
  await page.context().close();
 }
});
