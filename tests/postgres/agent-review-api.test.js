'use strict';

process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const clients=require('../../src/connections/postgres-public-api'),hooks=require('../../src/connections/postgres-outbound-webhooks');
const queue=require('../../src/operations/postgres-job-queue'),runtime=require('../../src/operations/postgres-runtime-handlers');

test('only Custom can start an agent review by API and receive the signed completion event',{timeout:240000},async t=>{
  const {db,ctx,browser,subscribe}=await require('../helpers/agent-workflow-fixture').fixture(t);
  const mint=scopes=>clients.create(db,ctx,{name:'ERP test system',scopes});
  const endpoint=()=>hooks.create(db,ctx,{name:'ERP test endpoint',eventTypes:['agent.review.completed'],endpointUrl:'https://erp.example.com/stockchief'});
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);await assert.rejects(mint(['agent:run']),e=>e.code==='entitlement_required');
    await assert.rejects(endpoint(),e=>e.code==='entitlement_required');
  }
  await subscribe('enterprise');
  const client=await mint(['agent:run']),other=await mint(['agent:run']),ordinary=await mint(['inventory:read']),hook=await endpoint();
  const base='/api/v1/public/agent/jobs',auth=token=>'Bearer '+token;
  const submit=(token,key,review='catalog-health')=>browser.post(base).set('Authorization',auth(token)).set('Idempotency-Key',key).send({review});
  await submit(ordinary.token,'denied').expect(403);
  const {body:job}=await submit(client.token,'one-review').expect(202);
  assert.equal((await submit(client.token,'one-review').expect(200)).body.jobId,job.jobId);
  await submit(client.token,'one-review','stock-health').expect(409);
  const status=token=>browser.get(base+'/'+job.jobId).set('Authorization',auth(token));
  await status(other.token).expect(404);
  let sent=0;
  const handlers=runtime.create(undefined,{webhookDelivery:{fetch:async(_url,options)=>{
    sent++;const signed=options.headers['x-stockchief-timestamp']+'.'+options.body;
    assert.equal(options.headers['x-stockchief-signature'],'v1='+crypto.createHmac('sha256',hook.secret).update(signed).digest('hex'));
    const data=JSON.parse(options.body);assert.equal(data.type,'agent.review.completed');assert.equal(data.data.jobId,job.jobId);
    assert.equal(data.data.rows,undefined);return new Response('',{status:200});
  }}});
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']})).status,'COMPLETED');
  const ready=(await status(client.token).expect(200)).body;
  assert.equal(ready.status,'COMPLETED');assert.match(ready.result.summary,/Catalog health/);
  const check=await browser.get('/settings/connections?section=developers').expect(200);assert.match(check.text,/value="agent:run"/);
  const pending=await submit(client.token,'other-review').expect(202);
  await subscribe('pro');
  const proPage=await browser.get('/settings/connections?section=developers').expect(200);
  assert.doesNotMatch(proPage.text,/value="agent:run"|value="agent\.review\.completed"/);
  await status(client.token).expect(402);await submit(client.token,'after-downgrade').expect(402);
  const prevented=await queue.processOne(db,handlers,{owner:'agent-review-test',kinds:['agent.api_review']});assert.notEqual(prevented.status,'COMPLETED');
  const registered=(await db.query('SELECT * FROM outbound_webhook_deliveries WHERE workspace_id=$1 AND event_type=$2',[ctx.workspaceId,'agent.review.completed'])).rows;
  assert.equal(registered.length,1);
  const delivery={workspaceId:ctx.workspaceId,payload:{deliveryId:registered[0].id},attemptCount:1,maxAttempts:12};
  await assert.rejects(hooks.deliver(db,delivery,{fetch:async()=>{sent++;throw Error('unexpected external call');}}),e=>e.code==='entitlement_required');
  assert.equal(sent,0);
  await subscribe('enterprise');
  assert.equal((await queue.processOne(db,handlers,{owner:'agent-hook-test',kinds:['webhook.deliver']})).status,'COMPLETED');
  assert.equal(sent,1);
  await clients.revoke(db,ctx.workspaceId,client.id,ctx.actorId);
  await browser.get(base+'/'+pending.body.jobId).set('Authorization',auth(client.token)).expect(401);
});
