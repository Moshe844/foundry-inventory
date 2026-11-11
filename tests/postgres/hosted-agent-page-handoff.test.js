'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
const csrf=html=>/name="_csrf" value="([^"]+)"/.exec(html)[1];
const decision=(action,extra={})=>({action,progress:'Checking the recorded business details.',query:'',steps:[],answer:'',evidence:[],...extra});
// Staging, 2026-11-11: a hosted agent asked a question, the owner answered in
// Yiddish "take me to the stock tab", and the agent called navigate.inventory
// then finished "I've opened the Inventory page". The goal completed without a
// page hand-off, so the browser never moved. A navigation tool only names a
// page; the goal must hand it to the browser and complete on arrival.
test('a page the hosted agent opens on a continuation reply is handed to the browser and completes on arrival',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f;
 const keys=['STOCKCHIEF_RUNTIME_ENV','STOCKCHIEF_CODEX_PILOT','STOCKCHIEF_CODEX_PILOT_WORKSPACES','STOCKCHIEF_CODEX_PILOT_EMAILS','STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS','STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE','STOCKCHIEF_AI_METER','ANTHROPIC_API_KEY'],old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 t.after(()=>{for(const k of keys)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];});
 // No real model: the Yiddish reply is not read in English and reaches the waiting goal, as it did on staging.
 delete process.env.ANTHROPIC_API_KEY;
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'pro','COMP','CUSTOM','OFFLINE_FIXTURE')",[randomUUID(),owner.accountId]);
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';process.env.STOCKCHIEF_AI_METER='credits';
 const provision=require('../../scripts/provision-codex-staging');Object.assign(process.env,(await provision.provision(db,{businessName:'Shipping operation fixture',emails:[f.email]})).environment);
 await db.query("UPDATE stockchief_runtime.codex_pilots SET enabled=true,stopped=false,ceiling_micro_usd=2000000,approval_reference='OFFLINE ONLY' WHERE workspace_id=$1",[ctx.workspaceId]);
 await provision.shareWithOwnedBusinesses(db,{fundingWorkspaceId:ctx.workspaceId,accountId:owner.accountId});process.env.STOCKCHIEF_CODEX_PILOT_ACCOUNT_ACCESS='1';process.env.STOCKCHIEF_STAGING_CERTIFICATION_FUNDING_WORKSPACE=ctx.workspaceId;
 const store=require('../../src/assistant/postgres-goal-store'),pilot=require('../../src/assistant/postgres-codex-pilot'),controller=require('../../src/assistant/postgres-goal-controller');
 const {PRICED_MODEL,pricedUsage}=require('../helpers/postgres-model-fixture');
 const queue=[],prompts=[];
 const provider={name:'anthropic',model:PRICED_MODEL,async complete(request){
  if(request.schemaName==='stockchief_adaptive_verification')return {usage:pricedUsage(),data:{complete:true,grounded:true,reason:''}};
  assert.equal(request.schemaName,'stockchief_adaptive_goal');prompts.push(JSON.parse(request.prompt));
  return {usage:pricedUsage(),data:queue.shift()||decision('ask',{answer:'Unexpected extra turn.'})};
 }};
 const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});t.after(()=>app.locals.sessionStore.close());
 const web=request.agent(app),login=await web.get('/login');
 await web.post('/login').type('form').send({_csrf:csrf(login.text),email:f.email,password:f.password});
 const ask=await web.get('/ask');assert.equal(ask.status,200);

 // As on staging, a saved answer style sends Ask to the hosted business agent.
 await require('../../src/assistant/postgres-answer-preferences').save(db,ctx,{answerStyle:'short bullet points'});
 // First run: the agent cannot tell what "Shoe me all custom" means and asks.
 const started=await pilot.start(db,ctx,'Shoe me all custom');
 assert.equal((await store.get(db,ctx,started.goalId)).checkpoint.runtime,'hosted-business');
 queue.push(decision('ask',{answer:'What outcome should I prioritize?'}));
 assert.equal((await controller.run(db,ctx,started.goalId,{provider})).goalStatus,'WAITING_USER');
 const asking=(await web.get('/ask/goals/'+started.goalId)).body;
 assert.equal(asking.conversation.phase,'clarification');

 // The owner answers in the Ask box, as a reply to that waiting goal.
 const replied=await web.post('/ask').type('form').send({_csrf:csrf(ask.text),message:'נעם מיר צו דו סטאק טעב',
  continueGoalId:started.goalId,questionId:asking.conversation.input.id});
 assert.equal(replied.status,303);assert.match(replied.headers.location,new RegExp('goal='+started.goalId));
 const ready=await store.get(db,ctx,started.goalId);
 assert.equal(ready.status,'READY');assert.deepEqual(ready.checkpoint.messages,['נעם מיר צו דו סטאק טעב']);

 // Second run: the agent opens the stock page and claims, too early, that it is open.
 queue.push(decision('discover',{query:'navigate.inventory'}),
  decision('operate',{steps:[{capability:'navigate.inventory',arguments:[],dependsOn:[]}]}),
  decision('finish',{answer:"I've opened the Inventory page for you, where you can view all stock items.",evidence:[0]}));
 await controller.run(db,ctx,started.goalId,{provider});
 assert.equal(queue.length,0,'The agent used every planned turn');
 assert.deepEqual(prompts.at(-1).userMessages,['נעם מיר צו דו סטאק טעב'],'The agent worked from the owner\'s reply');
 const handed=await store.get(db,ctx,started.goalId);
 assert.equal(handed.status,'WAITING_EVENT','The goal waits for the browser, not COMPLETED: '+handed.answer);
 assert.equal(handed.checkpoint.navigation.state,'PENDING');assert.equal(handed.checkpoint.navigation.href,'/inventory');
 assert.equal(handed.answer,'Ready to open Inventory in your browser.');
 assert.doesNotMatch(handed.answer,/opened/i,'Nothing claims the page opened before the browser arrives');
 assert.equal((await require('../../src/assistant/postgres-goal-resume').refresh(db,ctx,started.goalId)).status,'WAITING_EVENT',
  'A pending page hand-off is not re-run by the dependency sweep');

 // The Ask page sees an automatic hand-off for the goal this tab replied to.
 const progress=(await web.get('/ask/goals/'+started.goalId)).body;
 assert.equal(progress.conversation.phase,'navigation');
 assert.deepEqual({label:progress.navigation.label,state:progress.navigation.state,automatic:progress.navigation.automatic},
  {label:'Inventory',state:'PENDING',automatic:true});
 assert(!JSON.stringify(progress).includes('tokenHash'));

 // adaptive-goal.js submits the hand-off form; the browser lands on the page and acknowledges.
 const page=await web.get('/ask?goal='+started.goalId);
 assert.match(page.text,new RegExp('action="/ask/goals/'+started.goalId+'/navigate" data-goal-navigation >'),'The hand-off form is shown, not hidden');
 assert.match(page.text,/data-navigation-label type="submit">Open Inventory</);
 const moved=await web.post('/ask/goals/'+started.goalId+'/navigate').type('form').send({_csrf:csrf(page.text),automatic:'1'});
 assert.equal(moved.status,303);assert.equal(moved.headers.location,'/inventory');
 const landed=await web.get('/inventory');assert.equal(landed.status,200);
 const arrival=/data-agent-arrival data-token="([a-f0-9]{64})" data-csrf="([^"]+)"/.exec(landed.text);
 assert(arrival,'The destination page carries the arrival acknowledgement');
 const ack=await web.post('/ask/navigation/arrived').set('Accept','application/json').set('x-csrf-token',arrival[2]).send({token:arrival[1]});
 assert.equal(ack.status,200);assert.equal(ack.body.delivered,true);
 const done=await store.get(db,ctx,started.goalId);
 assert.equal(done.status,'COMPLETED');assert.equal(done.checkpoint.navigation.state,'DELIVERED');
 assert.equal(done.answer,'Opened Inventory in your browser.');
 assert.equal((await web.get('/ask/goals/'+started.goalId)).body.navigation,null,'A delivered page is not handed over twice');
});
