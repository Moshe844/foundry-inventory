'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const {createInspectionServer}=require('../../scripts/environment-agent-demo/inspection');
const {createBrowserTools}=require('../../scripts/environment-agent-demo/browser');
const {createGateway}=require('../../scripts/environment-agent-demo/gateway');

test('real UI exploration uses discovered controls; browser cannot write or cross tenants; gateway only prepares',async t=>{
  const cluster=await startCluster();const database=openPostgres(cluster.connectionString);
  const cleanup=[()=>cluster.stop(),()=>database.close()];t.after(async()=>{for(const close of cleanup.reverse())await close();});
  await migratePostgres(database);
  const auth=require('../../src/domain/postgres-auth-service');
  async function business(name){const row=await auth.createBusiness(database,{businessName:name,name:'Fixture owner',
    email:`${randomUUID()}@example.test`,password:`Fixture!${randomUUID()}`});
    return {workspaceId:row.workspaceId,actorId:row.userId,accountId:row.accountId};}
  const ctx=await business('Exploration fixture');const other=await business('PRIVATE CANARY BUSINESS');
  const catalog=require('../../src/domain/postgres-catalog-service');
  // Randomized labels: the executor has no knowledge of either product or path.
  const productName=`Unfamiliar part ${randomUUID().slice(0,8)}`;
  await catalog.createItem(database,ctx,{name:productName,baseCode:'DEMO-ONE',trackingMode:'quantity'});
  await catalog.createItem(database,other,{name:'PRIVATE CANARY PRODUCT',baseCode:'SECRET-OTHER',trackingMode:'quantity'});
  await catalog.createItem(database,other,{name:'PRIVATE VARIANT',baseCode:'SECRET-VARIANT',trackingMode:'quantity',hasVariants:true,
    options:[{name:'Secret option',values:['PRIVATE OPTION CANARY']}]});
  const server=await createInspectionServer({cluster,database,ctx});cleanup.push(()=>server.close());
  const home=await fetch(server.origin+'/');assert.equal(home.status,200);
  await home.text();await server.flushTelemetry();assert.deepEqual(server.telemetryErrors,[]);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM autopilot_limits WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  for(const route of ['/inventory/table','/inventory?q=DEMO-ONE']){
    const page=await fetch(server.origin+route);assert.equal(page.status,200);assert.match(await page.text(),/DEMO-ONE/);
  }
  assert.equal((await database.query('SELECT count(*)::int AS n FROM workspace_onboarding WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  const onboarding=require('../../src/onboarding/postgres-paths');
  await onboarding.choose(database,ctx.workspaceId,'fresh');
  const onboardingBefore=await onboarding.get(database,ctx.workspaceId);
  assert.equal((await fetch(server.origin+'/inventory/table')).status,200);
  assert.deepEqual(await onboarding.get(database,ctx.workspaceId),onboardingBefore);
  const autonomy=require('../../src/autopilot/postgres-service');
  const defaults=await autonomy.getState(server.readonly,ctx.workspaceId);assert.equal(defaults.mode,'SUPERVISED');assert.equal(defaults.canAutomate,false);
  await autonomy.setMode(database,ctx,{role:'owner'},'OBSERVE');
  assert.equal((await autonomy.getState(server.readonly,ctx.workspaceId)).mode,'OBSERVE');
  assert.equal((await database.query('SELECT count(*)::int AS n FROM autopilot_limits WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  assert.equal((await server.readonly.query('SELECT count(*)::int AS n FROM items')).rows[0].n,1);
  assert.equal((await server.readonly.query('SELECT count(*)::int AS n FROM items WHERE workspace_id=$1',[other.workspaceId])).rows[0].n,0);
  assert.equal((await server.readonly.query('SELECT count(*)::int AS n FROM sku_option_values')).rows[0].n,0);
  await assert.rejects(()=>server.readonly.query('UPDATE items SET name=$1 WHERE workspace_id=$2',['bypassed',ctx.workspaceId]),
    error=>['25006','42501'].includes(error.code));
  const denied=await fetch(server.origin+'/',{method:'POST',body:'attempt=write'});assert.equal(denied.status,403);
  const browser=await chromium.launch({headless:true});cleanup.push(()=>browser.close());
  const events=[];const ui=await createBrowserTools(browser,{origin:server.origin,audit:event=>events.push(event)});
  cleanup.push(()=>ui.close());
  const entry=await ui.inspect();assert.ok(entry.text.includes('StockChief'),entry.text.slice(0,400));
  assert.ok(!JSON.stringify(entry).includes('PRIVATE CANARY'));
  const link=entry.controls.find(c=>c.tag==='a'&&/inventory/i.test(c.label));assert.ok(link,JSON.stringify(entry.controls).slice(0,1000));
  const inventory=await ui.act({action:'click',ref:link.ref});
  assert.ok(inventory.text.includes(productName),inventory.text.slice(0,1000));
  const screenshot=await ui.act({action:'screenshot'});
  assert.equal(Buffer.from(screenshot.image.base64,'base64').readUInt32BE(0),0x89504e47);
  assert.ok(events.some(e=>e.kind==='browser_action'&&e.action==='click'));
  const stale=await ui.act({action:'click',ref:link.ref});assert.equal(stale.error.code,'STALE_BROWSER_REFERENCE');
  assert.ok(stale.screen.controls.length);
  // Use a separate external URL to verify the general egress rule, not a task route.
  const external=await ui.page.evaluate(async()=>{const response=await fetch('https://example.test/forbidden').catch(()=>null);return response?.status||0;});
  assert.notEqual(external,200);
  const store=require('../../src/assistant/postgres-goal-store');
  const goal='Create a quantity-tracked product named Governed Demo with SKU DEMO-NEW. Prepare it for my approval.';
  const created=await store.create(database,ctx,goal);const held=await store.claim(database,ctx,created.id);
  const gateway=createGateway({database,ctx,goal,goalId:held.id,runToken:held.run_token,
    provider:{async complete(){throw new Error('No model calls permitted in safety tests.');}}});
  const interfaces=await gateway.interfaces({search:'create'});const create=interfaces.operations.find(c=>c.name==='catalog.create_item');assert.ok(create);
  const contract=await gateway.interfaces({names:[create.name]});assert.ok(contract.operations[0].fields.baseCode);
  const {createSession}=require('../../scripts/environment-agent-demo/session');
  const sessionOptions={database,ctx,goalId:held.id,runToken:held.run_token,candidate:'offline',authorize:gateway.authorize};
  const session=createSession(sessionOptions);
  await session.checkpoint({claudeSessionId:randomUUID(),openaiState:{fixture:true}});
  const steps=[{capability:create.name,arguments:[{name:'search',value:'Governed Demo'},{name:'baseCode',value:'DEMO-NEW'}],dependsOn:[]}];
  const result=await session.execute('business_operations',{steps},callId=>gateway.operate({steps,callId}));
  const resumed=createSession(sessionOptions);
  assert.equal((await resumed.load()).native.openaiState.fixture,true);
  const replay=await resumed.execute('business_operations',{steps},()=>{throw new Error('Duplicate business execution');});
  assert.deepEqual(replay.outcomes,result.outcomes);assert.equal(replay.replayed,true);
  assert.equal(replay.canonicalReceipt.dependencyState,'WAITING_APPROVAL');
  const formattedReplay=await resumed.execute('business_operations',{stepsJson:JSON.stringify(steps,null,2)},()=>{throw new Error('Formatting caused duplicate execution');});
  assert.deepEqual(formattedReplay.outcomes,result.outcomes);assert.equal(formattedReplay.replayed,true);
  assert.equal(result.outcomes[0].result.status,'PREPARED',JSON.stringify(result));
  assert.equal((await database.query('SELECT count(*)::int AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,1);
  assert.equal((await database.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].status,'PENDING');
  await assert.rejects(()=>gateway.operate({steps:[{capability:'sql.execute',arguments:[],dependsOn:[]}]}),/registered/);
  await assert.rejects(()=>resumed.execute('business_operations',{invalid:true},()=>gateway.operate({steps:[]})),/one to eight/);
  assert.equal((await store.get(database,ctx,held.id)).status,'RUNNING');
  await assert.rejects(()=>resumed.execute('environment_browser',{},()=>{throw new Error('Stale control');}),/Stale/);
  assert.equal((await resumed.load()).inflight,null);
  await resumed.finish({answer:'The proposal is prepared.',verified:true});
  assert.equal((await store.get(database,ctx,held.id)).status,'WAITING_APPROVAL','a final claim never turns a pending proposal into completion');
  const waits=require('../../scripts/environment-agent-demo/waits');
  assert.equal((await waits.refresh(database,ctx,held.id)).status,'WAITING_APPROVAL');
  // Trusted test evaluator simulates the required human approval. This is NOT
  // an agent tool, and is not counted as autonomous completion in a benchmark.
  await require('../../src/assistant/postgres-service').executeProposal(database,ctx,result.outcomes[0].result.proposal.id);
  assert.equal((await waits.refresh(database,ctx,held.id)).status,'READY');
  const newLease=await store.claim(database,ctx,held.id);
  assert.ok(newLease);assert.notEqual(newLease.run_token,held.run_token);
  assert.equal((await database.query('SELECT count(*)::int AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,2);
  await store.cancel(database,ctx,held.id);await assert.rejects(()=>gateway.interfaces(),/not held/);
  await assert.rejects(()=>resumed.checkpoint({overwritten:true}),/not held/);
  const interrupted=await store.claim(database,ctx,(await store.create(database,ctx,'Prepare another operation.')).id);
  const interruptedSession=createSession({...sessionOptions,goalId:interrupted.id,runToken:interrupted.run_token,authorize:async()=>{}});
  await assert.rejects(()=>interruptedSession.execute('business_operations',{operation:'unknown'},()=>{throw new Error('Interrupted after possible effect');}),/Interrupted/);
  assert.equal((await store.get(database,ctx,interrupted.id)).status,'BLOCKED');
  await assert.rejects(()=>interruptedSession.execute('business_operations',{operation:'unknown'},()=>{}),/LEASE_LOST/);
  assert.equal((await database.query("SELECT name FROM items WHERE workspace_id=$1 AND base_code='SECRET-OTHER'",[other.workspaceId])).rows[0].name,'PRIVATE CANARY PRODUCT');

  // A cost/transport stop must not leave a lease RUNNING or invent completion.
  const stoppedGoal=await store.claim(database,ctx,(await store.create(database,ctx,'Inspect current stock.')).id);
  const stoppedSession=createSession({...sessionOptions,goalId:stoppedGoal.id,runToken:stoppedGoal.run_token,authorize:async()=>{}});
  await stoppedSession.checkpoint({evidence:'durable prior observation'});
  await stoppedSession.stop({code:'MODEL_COST_STOPPED'});
  const stopped=await store.get(database,ctx,stoppedGoal.id);
  assert.equal(stopped.status,'BLOCKED');assert.equal(stopped.run_token,null);assert.equal(stopped.lease_until,null);
  assert.equal(stopped.checkpoint.harness.native.evidence,'durable prior observation');
  assert.equal(stopped.checkpoint.harness.interruption.code,'MODEL_COST_STOPPED');
  assert.match(stopped.answer,/before final verification/);

  const pendingText='Create a quantity-tracked product named Pending Demo with SKU PENDING-DEMO. Prepare it for approval.';
  const pendingGoal=await store.claim(database,ctx,(await store.create(database,ctx,pendingText)).id);
  const pendingGateway=createGateway({database,ctx,goal:pendingText,goalId:pendingGoal.id,runToken:pendingGoal.run_token,
    provider:{async complete(){throw new Error('No paid calls in safety test');}}});
  const pendingSession=createSession({...sessionOptions,goalId:pendingGoal.id,runToken:pendingGoal.run_token,authorize:pendingGateway.authorize});
  const pendingSteps=[{capability:'catalog.create_item',arguments:[{name:'search',value:'Pending Demo'},{name:'baseCode',value:'PENDING-DEMO'}],dependsOn:[]}];
  const pending=await pendingSession.execute('business_operations',{steps:pendingSteps},callId=>pendingGateway.operate({steps:pendingSteps,callId}));
  await pendingSession.stop({code:'MODEL_COST_STOPPED'});
  assert.equal((await store.get(database,ctx,pendingGoal.id)).status,'WAITING_APPROVAL');
  assert.equal((await database.query('SELECT status FROM stockchief_runtime.assistant_action_proposals WHERE id=$1',[pending.outcomes[0].result.proposal.id])).rows[0].status,'PENDING');
  assert.equal((await database.query("SELECT count(*)::int n FROM items WHERE workspace_id=$1 AND base_code='PENDING-DEMO'",[ctx.workspaceId])).rows[0].n,0);
  await store.cancel(database,ctx,pendingGoal.id);
  await assert.rejects(()=>pendingSession.stop(),/LEASE_LOST/);
  assert.equal((await store.get(database,ctx,pendingGoal.id)).status,'CANCELLED');
});
