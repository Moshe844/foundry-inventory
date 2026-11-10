'use strict';

process.env.NODE_ENV='test';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const service=require('../../src/connections/agent-slack');
const slack=require('../../src/connections/slack-agent-command');
const jobs=require('../../src/operations/postgres-job-queue');
const {randomUUID}=require('node:crypto');

test('Slack answers authenticate each user, read current business facts and respect all plan and delivery boundaries',{timeout:720000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20});
  const {db,ctx,browser,csrf}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const fields={team:'TSTOCK1',app:'ASTOCK1',secret:'ab'.repeat(16),confirmed:'yes',revision:0};
  for(const plan of ['starter','growth']){
    await f.subscribe(plan);
    const locked=await browser.get(service.path).expect(200);
    assert.match(locked.text,/Slack answers require Pro or Custom/);
    assert.doesNotMatch(locked.text,/Save Slack configuration/);
    await assert.rejects(service.configure(db,ctx,fields),error=>error.code==='entitlement_required');
  }
  await f.subscribe('pro');
  await require('../../src/autopilot/postgres-service').setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  let page=await browser.get(service.path).expect(200);
  await browser.post(service.path+'/connection').type('form').send({...fields,_csrf:csrf(page.text)}).expect(303);
  const app=(await service.page(db,ctx)).connection;
  const endpoint=service.publicPath+'/'+app.endpoint_id;
  const publicApp=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
  f.cleanup(()=>publicApp.locals.sessionStore.close());
  const publicBrowser=request(publicApp);
  const callback='https://hooks.slack.com/commands/TSTOCK1/1234567890/abcdefghijabcdefghij';
  const now=String(Math.floor(Date.now()/1000));
  const signature=body=>slack.sign(Buffer.from(body),now,fields.secret);
  async function command(text,extra={}){
    const body=new URLSearchParams({team_id:fields.team,api_app_id:fields.app,user_id:'USTOCK1',
      command:'/stockchief',response_url:callback,text,...extra}).toString();
    return publicBrowser.post(endpoint).set('Content-Type','application/x-www-form-urlencoded')
      .set('x-slack-request-timestamp',now).set('x-slack-signature',signature(body)).send(body);
  }
  await publicBrowser.post(endpoint).type('form').send({text:'What is on hand?'}).expect(403);
  const unknown=await command('What is on hand?');
  assert.equal(unknown.status,403);
  assert.match(unknown.text,/Link your Slack user/);
  page=await browser.get(service.path).expect(200);
  const codePage=await browser.post(service.path+'/code').type('form').send({_csrf:csrf(page.text)}).expect(200);
  const code=/\/stockchief connect ([A-Za-z0-9_-]{32})/.exec(codePage.text)[1];
  const linked=await command('connect '+code);
  assert.equal(linked.status,200,linked.text);
  assert.match(linked.text,/Your Slack user is linked/);
  assert.equal((await command('connect '+code)).status,400);
  let calls=0,writes=0;
  const usage={provider:'anthropic',providerVersion:'2023-06-01',model:'claude-haiku-4-5-20251001',inputTokens:600,outputTokens:150};
  const provider={name:'anthropic',model:usage.model,async complete(req){
    calls++;
    assert.equal(req.commercial,true);
    assert.equal(req.schemaName,'bounded_business_read');
    return {data:{status:'read',question:'',queries:[{dataset:'stock',columns:['sku','location','on_hand']}]},usage};
  }};
  const responses=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,callback);
    assert.equal(options.redirect,'error');
    assert.equal(options.method,'POST');
    writes++;
    const reply=JSON.parse(options.body);
    assert.equal(reply.response_type,'ephemeral');
    assert.equal(reply.blocks[0].text.type,'plain_text');
    responses.push(reply.blocks[0].text.text);
    return new Response('ok',{status:200});
  });
  const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{aiProvider:provider});
  const run=()=>jobs.processOne(db,{[service.kind]:handlers[service.kind]},{owner:'slack-integration',leaseMs:120000});
  const firstQuestion=await command('What is on hand?');
  assert.equal(firstQuestion.status,200,firstQuestion.text);
  const replayedQuestion=await command('What is on hand?');
  assert.equal(replayedQuestion.status,200,replayedQuestion.text);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_slack_questions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  const completed=await run();
  assert.equal(completed.status,'COMPLETED',JSON.stringify(completed.lastError));
  assert.equal(completed.result.status,'replied');
  assert.equal(completed.result.answerProblem,null,JSON.stringify(completed.result.answerProblem));
  assert.equal(calls,1);
  assert.equal(writes,1);
  assert.match(responses[0],/20/);
  assert.match(responses[0],/AI credits used [1-9]/);
  assert.equal(await f.balance(),20);
  const again=await run();
  assert.equal(again,null);
  assert.equal((await command('Send an email to all my customers')).status,200);
  assert.equal((await run()).status,'COMPLETED');
  assert.equal(calls,1);
  assert.match(responses.at(-1),/Open StockChief to prepare or approve changes/);
  assert.equal((await command('What is on hand now?')).status,200);
  await f.subscribe('growth');
  const downgraded=await run();
  assert.equal(downgraded.result.status,'authority_changed');
  assert.equal(calls,1);
  assert.equal(writes,2);
  assert.equal((await command('What is on hand after downgrade?')).status,402);
  await f.subscribe('enterprise');
  await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
    VALUES($1,$2,'ai_work_credits',1000,'Synthetic Custom Slack answers')`,[randomUUID(),f.owner.accountId]);
  assert.equal((await command('What is in stock today?')).status,200);
  assert.equal((await run()).result.status,'replied');
  assert.equal(calls,2);
  assert.equal(writes,3);
  await db.query("UPDATE stockchief_runtime.agent_slack_questions SET created_at=clock_timestamp()-interval '2 minutes' WHERE workspace_id=$1",[ctx.workspaceId]);
  let failDelivery=true;
  t.mock.method(globalThis,'fetch',async()=>{
    writes++;
    if(failDelivery)return new Response('unavailable',{status:503});
    return new Response('ok',{status:200});
  });
  await command('What stock can I see before a provider outage?');
  const failedDelivery=await run();
  assert.equal(failedDelivery.status,'DEAD',JSON.stringify(failedDelivery));
  assert.equal(writes,4);
  assert.equal(calls,3);
  const latest=(await db.query(`SELECT id,status FROM stockchief_runtime.agent_slack_questions WHERE workspace_id=$1
    ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
  assert.equal(latest.status,'HELD');
  assert.equal((await db.query(`SELECT status FROM commercial_usage_events WHERE workspace_id=$1
    AND meter='ai_work_credits' AND idempotency_key=$2`,[ctx.workspaceId,ctx.workspaceId+':slack:'+latest.id])).rows[0].status,'REVERSED');
  assert.equal(await run(),null);
  assert.equal(writes,4);
  failDelivery=false;
  const savedComplete=provider.complete;
  provider.complete=async req=>{
    const response=await savedComplete(req);
    await f.subscribe('growth');
    return response;
  };
  await command('What stock can I see before authority changes?');
  const changedAuthority=await run();
  assert.equal(changedAuthority.result.status,'authority_changed',JSON.stringify(changedAuthority));
  assert.equal(calls,4);
  assert.equal(writes,4);
  const afterChange=(await db.query(`SELECT id,status FROM stockchief_runtime.agent_slack_questions WHERE workspace_id=$1
    ORDER BY created_at DESC LIMIT 1`,[ctx.workspaceId])).rows[0];
  assert.equal(afterChange.status,'HELD');
  assert.equal((await db.query(`SELECT status FROM commercial_usage_events WHERE workspace_id=$1
    AND meter='ai_work_credits' AND idempotency_key=$2`,[ctx.workspaceId,ctx.workspaceId+':slack:'+afterChange.id])).rows[0].status,'REVERSED');
  await f.subscribe('pro');
  await command('What stock is available after a worker restart?');
  const interrupted=await jobs.claim(db,{owner:'interrupted-slack-worker',kinds:[service.kind]});
  const interruptedKey=ctx.workspaceId+':slack:'+interrupted.payload.questionId;
  await require('../../src/commercial/entitlements').reserveUsage(db,{workspaceId:ctx.workspaceId,accountId:f.owner.accountId},
    {meter:'ai_work_credits',units:5,idempotencyKey:interruptedKey});
  await db.query('UPDATE stockchief_runtime.jobs SET lease_expires_at=0 WHERE id=$1',[interrupted.id]);
  await jobs.recoverExpired(db);
  assert.equal((await jobs.get(db,interrupted.id,ctx.workspaceId)).status,'DEAD');
  assert.equal((await db.query(`SELECT status FROM commercial_usage_events WHERE workspace_id=$1
    AND meter='ai_work_credits' AND idempotency_key=$2`,[ctx.workspaceId,interruptedKey])).rows[0].status,'REVERSED');
  assert.equal((await db.query(`SELECT sealed_question FROM stockchief_runtime.agent_slack_questions
    WHERE workspace_id=$1 AND id=$2`,[ctx.workspaceId,interrupted.payload.questionId])).rows[0].sealed_question,null);
  assert.equal(writes,4);
  await service.configure(db,ctx,{confirmed:'yes',revision:app.revision,stop:'yes'});
  assert.equal((await command('What is available after disconnect?')).status,404);
  assert.equal(await f.balance(),20);
});
