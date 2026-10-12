'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const recorded=require('../fixtures/environment-agent-context-loss/recorded.json');
const base='../../scripts/environment-agent-demo/';
const goals=require('../../src/assistant/postgres-goal-store'),{createSession}=require(base+'session');
test('actual failed observations survive PostgreSQL lease loss, reconnection and outcome classification',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster();let db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Trace replay',businessName:'Offline observed evidence',
  email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};let providerCalls=0;
 const provider={complete:async()=>{providerCalls++;throw Error('OFFLINE_PROVIDER_FORBIDDEN');}};
 const attach=held=>{const gateway=require(base+'gateway').createGateway({database:db,ctx,goal:held.original_request,goalId:held.id,runToken:held.run_token,provider});
  return createSession({database:db,ctx,goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:gateway.authorize});};
 for(const sample of recorded.cases)await t.test(sample.task,async()=>{
  let held=await goals.claim(db,ctx,(await goals.create(db,ctx,sample.goal)).id),session=attach(held);
  const ids=new Map();let step=0;
  for(const event of sample.events.filter(e=>e.kind==='agent_tool_started')){
   step++;const entry=Object.values(sample.evidence).find(e=>e.id.endsWith(':'+step));
   const input=event.name==='environment_evidence'?{...event.input,id:ids.get(event.input.id)}:event.input;
   const value=await session.execute(event.name,input,async id=>{
    if(event.name==='environment_evidence')return session.evidence(input);
    ids.set(entry.id,id);return JSON.parse(entry.text);
   });
   if(entry)assert.deepEqual(value,JSON.parse(entry.text));
  }
  // Interrupt after recorded investigation, before final reporting. Reconnect
  // and claim a fresh lease without copying any process-local working memory.
  await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second' WHERE id=$1",[held.id]);
  await db.close();db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  await require(base+'waits').recover(db,ctx,held.id);held=await goals.claim(db,ctx,held.id);assert(held);session=attach(held);
  const memory=await session.workingMemory(),h=await session.load();
  assert.equal(h.progress.finalReason,'REPEATED_UNCHANGED_EVIDENCE');
  for(const entry of Object.values(sample.evidence)){
   const stored=h.evidence[ids.get(entry.id)];assert(stored);assert.equal(stored.truncated,false);
   assert.deepEqual(JSON.parse(stored.text),JSON.parse(entry.text));
   const screen=JSON.parse(entry.text);
   if(entry.name==='environment_browser'&&screen.text?.includes('Handling requirement:'))
    assert(memory.browser.pages.some(p=>p.text===screen.text));
  }
  const index=await session.evidence({id:'@index'});assert(index.records.length);
  assert.equal((await session.modelControl()).final,true);
  await session.finish({answer:sample.answer,verified:false});
  const final=await goals.get(db,ctx,held.id);assert.equal(final.status,'BLOCKED');
  assert.equal(final.checkpoint.harness.failure.code,'REPEATED_UNCHANGED_EVIDENCE');assert.equal(final.checkpoint.harness.userQuestion,null);
  await assert.rejects(()=>session.evidence({id:ids.values().next().value}),/not held|LEASE/,'completed lease cannot be used to read evidence');
 });
 await t.test('large recorded payload survives database serialization; wrong actor cannot retrieve it',async()=>{
  const held=await goals.claim(db,ctx,(await goals.create(db,ctx,'Review captured observations without effects.')).id),session=attach(held);
  const output={observations:recorded.cases.flatMap(c=>Object.values(c.evidence).map(e=>JSON.parse(e.text)))};
  let id;await session.execute('environment_dataset',{},async key=>{id=key;return output;});
  const fresh=attach(held),saved=await fresh.load();assert(saved.evidence[id].text.length>128000);assert(!saved.evidence[id].truncated);
  assert.deepEqual(JSON.parse(saved.evidence[id].text),output);
  const wrong=createSession({database:db,ctx:{...ctx,actorId:'wrong-actor'},goalId:held.id,runToken:held.run_token,candidate:'openai',authorize:async()=>({})});
  await assert.rejects(()=>wrong.evidence({id}),/LEASE/);await goals.cancel(db,ctx,held.id);
 });
 await t.test('real missing-information question is durable and resumes only after a user reply',async()=>{
  let held=await goals.claim(db,ctx,(await goals.create(db,ctx,'Receive my counted stock at the location I will specify.')).id),session=attach(held);
  await session.finish({answer:JSON.stringify({status:'needs_user',question:'Which receiving location?',missingInformation:'No receiving location supplied.'})});
  let g=await goals.get(db,ctx,held.id);assert.equal(g.status,'WAITING_USER');assert.equal(g.answer,'Which receiving location?');
  assert(g.checkpoint.harness.userQuestion);assert.equal(g.checkpoint.harness.failure,null);
  g=await goals.reply(db,ctx,g.id,'The main warehouse.');assert.equal(g.status,'READY');await goals.cancel(db,ctx,g.id);
 });
 assert.equal(providerCalls,0);
});
