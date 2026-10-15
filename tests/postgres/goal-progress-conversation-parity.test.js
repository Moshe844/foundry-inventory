'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('lightweight progress preserves the complete public conversation across all lifecycle phases without exposing private evidence',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Reviewer',businessName:'Progress parity',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const store=require('../../src/assistant/postgres-goal-store'),conversation=require('../../src/assistant/agent-conversation');
 const cases=[
  {status:'BLOCKED',harness:{interruption:{code:'SHARED_SPENDING_CEILING'},completionSource:'partial_verified_receipt'}},
  {status:'BLOCKED',harness:{interruption:{code:'SHARED_SPENDING_CEILING'},completionSource:'partial_observation_report'}},
  {status:'BLOCKED',harness:{interruption:{code:'SHARED_SPENDING_CEILING'}}},
  {status:'BLOCKED',harness:{interruption:{code:'DISCONNECTED'}}},
  {status:'BLOCKED',harness:{}},
  {status:'WAITING_USER',harness:{userQuestion:{id:'question-one',question:'Which delivery address should I use?',missingInformation:['Customer delivery address']}}},
  {status:'WAITING_APPROVAL',harness:{}},
  {status:'WAITING_EVENT',harness:{},navigation:{id:'navigation-one',label:'Open record',state:'PENDING'}},
  {status:'WAITING_EVENT',harness:{}},
  {status:'RUNNING',harness:{},lifecycleStage:'verification'},
  {status:'READY',harness:{}},{status:'COMPLETED',harness:{}},{status:'CANCELLED',harness:{}}
 ];
 for(const fixture of cases){const goal=await store.create(db,ctx,'Inspect this disposable goal.');
  const checkpoint={runtime:'codex-staging',harness:{...fixture.harness,evidence:{private:'PRIVATE_EVIDENCE_SENTINEL'},authorityStamp:'PRIVATE_AUTHORITY_SENTINEL'},navigation:fixture.navigation||null,lifecycleStage:fixture.lifecycleStage||null,conversationState:{revision:3,history:[{id:'history-one',role:'user',text:'My original goal.',at:'2026-01-01T00:00:00.000Z'}]}};
  await db.query('UPDATE stockchief_runtime.assistant_goals SET status=$4,answer=$5,checkpoint=$6::jsonb WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3',[ctx.workspaceId,ctx.actorId,goal.id,fixture.status,'The approved operation was executed and verified.',JSON.stringify(checkpoint)]);
  const full=await store.get(db,ctx,goal.id),progress=await store.progress(db,ctx,goal.id);
  assert.deepEqual(conversation.state(progress),conversation.state(full),JSON.stringify(fixture));
  assert(!JSON.stringify(progress).includes('PRIVATE_EVIDENCE_SENTINEL'));assert(!JSON.stringify(progress).includes('PRIVATE_AUTHORITY_SENTINEL'));
  if(fixture.harness.completionSource)assert(conversation.state(progress).message.includes('The approved operation was executed and verified.'));
  assert.equal(await store.progress(db,{...ctx,actorId:'foreign-user'},goal.id),null);
  assert.equal(await store.progress(db,{...ctx,workspaceId:'foreign-workspace'},goal.id),null);
 }
});
