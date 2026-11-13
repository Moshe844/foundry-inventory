'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const clients=require('../../src/connections/postgres-public-api'),hooks=require('../../src/connections/postgres-outbound-webhooks');
const queue=require('../../src/operations/postgres-job-queue'),runtime=require('../../src/operations/postgres-runtime-handlers');
const agentJobs=require('../../src/connections/agent-api-jobs'),vans=require('../../src/shipping/agent-van-routes');

// Job 189: Custom only. Another system starts agent jobs through the API. Each
// runs through its own job's service, plan, mode and limits; the "always needs
// a person" list comes back waiting for a person; pause, Watch only and the
// first 14 days hold it. Starts are idempotent by key, rate limited and
// audited with the API client as the actor, and every finish, hold or failure
// sends one signed webhook to the test receiver.
test('only Custom starts agent jobs from another system, through each job’s own service, with signed webhooks',{timeout:900000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t,{units:20,timeZone:'America/New_York'}),{db,ctx,browser,subscribe}=f;
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  const mint=(scopes,name='ERP test system')=>clients.create(db,ctx,{name,scopes});
  const endpoint=()=>hooks.create(db,ctx,{name:'ERP receiver',eventTypes:['agent.job.completed','agent.job.held','agent.job.failed'],endpointUrl:'https://erp.example.com/stockchief'});
  for(const tier of ['starter','growth','pro']){
    await subscribe(tier);
    await assert.rejects(mint(['agent:run']),e=>e.code==='entitlement_required');
    await assert.rejects(endpoint(),e=>e.code==='entitlement_required');
  }
  await subscribe('enterprise');
  const autopilot=require('../../src/autopilot/postgres-service'),modes=require('../../src/autopilot/job-modes');
  await autopilot.setMode(db,ctx,{role:'owner'},'POLICY_AUTOMATED');
  const client=await mint(['agent:run']),other=await mint(['agent:run'],'Other system'),hook=await endpoint();
  const base='/api/v1/public/agent/jobs',auth=token=>'Bearer '+token;
  const submit=(key,body,token=client.token)=>browser.post(base).set('Authorization',auth(token)).set('Idempotency-Key',key).send(body);
  const status=(id,token=client.token)=>browser.get(base+'/'+id).set('Authorization',auth(token));
  const handlers=runtime.create(undefined,{webhookDelivery:{fetch:async(url,options)=>{
    assert.equal(new URL(url).hostname,'erp.example.com','only the test receiver');
    const signed=options.headers['x-stockchief-timestamp']+'.'+options.body;
    assert.equal(options.headers['x-stockchief-signature'],'v1='+crypto.createHmac('sha256',hook.secret).update(signed).digest('hex'));
    received.push(JSON.parse(options.body));return new Response('',{status:200});
  }}});
  const received=[];
  const work=async()=>{const job=await queue.processOne(db,handlers,{owner:'api-job-test',kinds:[agentJobs.KIND]});assert.ok(job);return job;};
  const deliver=async()=>{while(await queue.processOne(db,handlers,{owner:'api-hook-test',kinds:['webhook.deliver']}));};
  const run=async(key,body)=>{const {body:started}=await submit(key,body).expect(202);const job=await work();assert.equal(job.status,'COMPLETED',JSON.stringify(job));
    await deliver();return (await status(started.jobId).expect(200)).body;};

  // A routine finishes on its own: idempotent by key, audited with the client as the actor, one signed webhook.
  const {body:started}=await submit('expiry-1',{job:'warn-before-expiry'}).expect(202);
  assert.equal(started.status,'queued');
  assert.equal((await submit('expiry-1',{job:'warn-before-expiry'}).expect(200)).body.jobId,started.jobId);
  await submit('expiry-1',{job:'fix-product-data'}).expect(409);
  await submit('unknown-1',{job:'delete-everything'}).expect(400);
  await status(started.jobId,other.token).expect(404);
  assert.equal((await status(started.jobId).expect(200)).body.status,'queued');
  assert.equal((await work()).status,'COMPLETED');await deliver();
  const finished=(await status(started.jobId).expect(200)).body;
  assert.equal(finished.status,'completed');assert.equal(finished.waiting,0);
  assert.deepEqual(received.map(r=>[r.type,r.data.jobId,r.data.status]),[['agent.job.completed',started.jobId,'completed']]);
  const trail=(await db.query('SELECT action,actor_id FROM security_event_history WHERE workspace_id=$1 AND reference=$2 ORDER BY created_at',[ctx.workspaceId,started.jobId])).rows;
  assert.deepEqual(trail,[{action:agentJobs.STARTED,actor_id:client.id},{action:agentJobs.RUN,actor_id:client.id}]);
  assert.match((await browser.get('/audit').query({q:'Agent job run'}).expect(200)).text,/API: ERP test system/);
  assert.match(JSON.stringify((await require('../../src/autopilot/agent-activity').report(db,ctx)).rows),/Agent job run for your other system/);

  // Van routes start through job 71's own routine and fleet rule.
  const today=await require('../../src/lib/business-time').today(db,ctx.workspaceId),tomorrow=require('../../src/accounting/customer-money').addDays(today,1);
  const plan=async(box,fleet,publish)=>{
    const made=await vans.prepare(db,ctx,{selected:box.shipmentId,depotId:f.location.id,deliveryDate:tomorrow,vans:fleet,opens:{[box.shipmentId]:'08:00'},
      closes:{[box.shipmentId]:'16:00'},service:{[box.shipmentId]:'10'},roadTimes:JSON.stringify({points:['DEPOT',box.shipmentNumber],seconds:[[0,600],[660,0]]}),confirmed:'yes'});
    if(publish)await vans.approve(db,ctx,made.id,{confirmed:'yes',revision:1});return made.id;
  };
  await plan(await f.parcel(),'Van 2 | Riley | 800 | 07:00 | 15:00',true);
  await vans.configure(db,ctx,await plan(await f.parcel(),'Van 1 | Jordan | 1000 | 08:00 | 17:00',false),
    {confirmed:'yes',ruleRevision:0,maximumStops:3,planAt:'23:59',days:['1','2','3','4','5','6','7']});
  const delivery=await f.parcel();
  const routed=await run('vans-1',{job:'plan-van-routes'});
  assert.equal(routed.status,'completed',JSON.stringify(routed));assert.equal(routed.done,1);assert.equal(routed.link,vans.path);
  const route=(await db.query(`SELECT status,automatic FROM stockchief_runtime.agent_van_routes WHERE workspace_id=$1 AND facts->'stops'->0->>'id'=$2`,[ctx.workspaceId,delivery.shipmentId])).rows[0];
  assert.deepEqual(route,{status:'READY',automatic:true});
  // Ask me first on that job: the route waits for a person in Needs you.
  await modes.save(db,ctx,71,{mode:'ask',revision:0});
  await db.query('UPDATE stockchief_runtime.agent_van_route_rules SET planned_for=NULL WHERE workspace_id=$1',[ctx.workspaceId]);await f.parcel();
  const asked=await run('vans-2',{job:'plan-van-routes'});
  assert.equal(asked.status,'waiting_for_person');assert.equal(asked.waiting,1);assert.match(asked.reason,/waits for a person in Needs you/);
  assert.equal(received.at(-1).type,'agent.job.held');
  await modes.save(db,ctx,71,{mode:'inherit',revision:1});

  // The "always needs a person" list is never done: it comes back waiting for a person.
  const pay=await run('pay-1',{job:'pay-supplier'});
  assert.equal(pay.status,'waiting_for_person');assert.match(pay.reason,/Paying suppliers always needs a person/);
  assert.deepEqual([received.at(-1).type,received.at(-1).data.status],['agent.job.held','waiting_for_person']);
  // Pause, Watch only on the job and the first 14 days hold it without running.
  await autopilot.pause(db,ctx,{role:'owner'},'API check');
  const paused=await run('pause-1',{job:'warn-before-expiry'});assert.equal(paused.status,'held');assert.match(paused.reason,/paused/);
  await autopilot.resume(db,ctx,{role:'owner'});
  await modes.save(db,ctx,191,{mode:'watch',revision:0});
  const watched=await run('watch-1',{job:'warn-before-expiry'});assert.equal(watched.status,'held');assert.match(watched.reason,/Watch only/);
  await modes.save(db,ctx,191,{mode:'inherit',revision:1});
  await db.query('UPDATE accounts SET created_at=now()::text WHERE id=$1',[f.owner.accountId]);
  const shadow=await run('shadow-1',{job:'fix-product-data'});assert.equal(shadow.status,'held');assert.match(shadow.reason,/14 days/);
  await db.query("UPDATE accounts SET created_at=(now()-interval '30 days')::text WHERE id=$1",[f.owner.accountId]);
  assert.equal(received.filter(r=>r.type==='agent.job.held').length,5);

  // A saved playbook runs through job 213's own service.
  const playbooks=require('../../src/autopilot/playbooks');
  const book=await playbooks.create(db,ctx,{name:'Morning checks',steps:['catalog-health','warn-before-expiry'],cadence:'manual'});
  const played=await run('playbook-1',{job:'run-playbook',playbook:book});
  assert.equal(played.status,'completed',JSON.stringify(played));assert.equal(played.done,2);
  await submit('playbook-2',{job:'run-playbook',playbook:'missing'}).expect(404);
  await submit('playbook-3',{job:'run-playbook'}).expect(400);

  // Rate limited: 30 starts an hour per token, reviews included.
  const values=Array.from({length:agentJobs.HOURLY_STARTS},()=>crypto.randomUUID());
  await db.query(`INSERT INTO public_api_commands(id,workspace_id,client_id,idempotency_key,command_type,request_hash,result,created_at)
    SELECT 'apicmd_'||k,$1,$2,k,'agent.api_job','synthetic','{}',now()::text FROM unnest($3::text[]) k`,[ctx.workspaceId,client.id,values]);
  const limited=await submit('limited-1',{job:'warn-before-expiry'}).expect(429);
  assert.match(limited.body.error.message,/30 agent jobs in the last hour/);
  await submit('limited-review',{review:'catalog-health'}).expect(429);
  await db.query(`UPDATE public_api_commands SET created_at=(now()-interval '2 hours')::text WHERE client_id=$1 AND request_hash='synthetic'`,[client.id]);

  // A plan change between queue and run pauses the job; it sends nothing.
  const {body:queued}=await submit('downgrade-1',{job:'warn-before-expiry'}).expect(202);
  await subscribe('pro');
  assert.equal((await work()).status,'PAUSED');
  await subscribe('enterprise');
  await db.query("UPDATE stockchief_runtime.jobs SET status='CANCELLED' WHERE id=$1",[queued.jobId]);
  // A token revoked between queue and run fails the job and says so by webhook.
  const {body:revoked}=await submit('revoked-1',{job:'warn-before-expiry'}).expect(202);
  await clients.revoke(db,ctx.workspaceId,client.id,ctx.actorId);
  assert.equal((await work()).status,'COMPLETED');await deliver();
  assert.deepEqual([received.at(-1).type,received.at(-1).data.jobId],['agent.job.failed',revoked.jobId]);
  assert.match(received.at(-1).data.reason,/active owner-issued API token/);
  await status(revoked.jobId).expect(401);
  assert.equal(new Set(received.map(r=>r.id)).size,received.length,'one webhook per job');
  assert.equal(await f.balance(),20,'nothing here moves stock');
});
