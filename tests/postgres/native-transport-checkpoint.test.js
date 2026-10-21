'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('atomic native transport checkpoints preserve exact delivery, lease, actor, scope and durable request caps',{timeout:150000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Transport fixture',businessName:'Unfamiliar transport fixture',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store');
 let writes=0,transactions=0;const measured={...db,query:async(...args)=>{writes++;return db.query(...args);},transaction:(...args)=>{transactions++;return db.transaction(...args);}};
 async function fresh(){const goal=await store.claim(db,ctx,(await store.create(db,ctx,randomUUID()+' investigate current records.')).id),gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
  const attach=()=>require('../../scripts/environment-agent-demo/session').createSession({database:measured,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});const session=attach();await session.load();return{goal,gateway,session,attach};}
 const f=await fresh(),access=await f.gateway.authorize({catalogue:false}),packet={status:200,body:'Exact receipt\n'.repeat(3000),contentType:'text/event-stream',outcome:{terminal:false,tool:true,usageSettled:true}};
 const before=await store.get(db,ctx,f.goal.id);writes=0;transactions=0;
 await f.session.checkpoint({browserUrl:'http://127.0.0.1/current',codex:{threadId:'native-thread',files:{original:'unchanged'}}});
 assert.deepEqual(await f.session.codexRequest(access),{request:1});await f.session.codexPending('first-response',access);await f.session.codexDelivered('first-response',packet,packet.outcome);
 assert.equal(writes,4,'Four transport boundaries use four wire statements');assert.equal(transactions,0,'No separate begin/read/update/commit round trips');
 const typedReport={version:1,status:'needs_user',question:'Which saved location should receive these units?',missingInformation:['Receiving location']};
 writes=0;transactions=0;await f.session.recordReport(typedReport);
 assert.equal(writes,1,'The typed handoff persists in one scoped statement');assert.equal(transactions,0);
 assert.deepEqual((await store.get(db,ctx,f.goal.id)).checkpoint.harness.pendingReport,typedReport);
 await f.session.recordReport({status:'completed',answer:'Untrusted incomplete envelope'});
 assert.deepEqual((await store.get(db,ctx,f.goal.id)).checkpoint.harness.pendingReport,typedReport,'Invalid protocol data cannot replace the typed report');
 const done=await store.get(db,ctx,f.goal.id);assert.deepEqual(done.checkpoint.conversationState,before.checkpoint.conversationState);assert.equal(done.tool_calls,before.tool_calls);assert.equal(done.status,'RUNNING');assert.equal(done.run_token,f.goal.run_token);assert.equal(done.checkpoint.harness.codexRequests,1);
 assert.deepEqual(await f.session.codexReplay('first-response',access),packet);await f.session.checkpoint({codex:{threadId:'same-thread',files:{original:'still preserved'}}});
 assert.equal((await store.get(db,ctx,f.goal.id)).checkpoint.harness.native.browserUrl,'http://127.0.0.1/current');
 await assert.rejects(f.session.codexDelivered('wrong-hash',packet,packet.outcome),/SEQUENCE_MISMATCH/);
 await f.session.codexPending('pending-response',access);await assert.rejects(f.session.codexPending('another-response',access),/RECONCILIATION_REQUIRED/);await assert.rejects(f.session.codexReplay('unmatched',access),/RECONCILIATION_REQUIRED/);
 const helper=f.session.helperDelivery();await helper.codexPending('helper-response',access);await helper.codexDelivered('helper-response',packet);assert.deepEqual(await helper.codexReplay('helper-response',access),packet);await assert.rejects(helper.codexDelivered('different',packet),/SEQUENCE_MISMATCH/);
 const nativeBefore=(await store.get(db,ctx,f.goal.id)).checkpoint.harness.codexDelivery;assert.equal(nativeBefore.state,'PENDING','Settling helper does not settle native uncertainty');
 await f.session.codexDelivered('pending-response',packet,packet.outcome);
 const unchanged=await store.get(db,ctx,f.goal.id);await db.query("UPDATE users SET role='member',permissions='{}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 for(const act of [()=>f.session.checkpoint({mustNotSave:true}),()=>f.session.recordReport({...typedReport,question:'Revoked handoff must not save'}),()=>f.session.codexRequest(access),()=>f.session.codexPending('revoked',access),()=>helper.codexPending('revoked-helper',access)])await assert.rejects(act(),/AUTHORITY_CHANGED/);
 assert.deepEqual((await store.get(db,ctx,f.goal.id)).checkpoint,unchanged.checkpoint,'A stale admission cannot bypass fresh actor verification');
 await db.query("UPDATE users SET role='owner' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 const g=await fresh(),other=g.attach();await other.load();const a=await g.gateway.authorize({catalogue:false});
 const concurrent=await Promise.allSettled(Array.from({length:30},(_,i)=>(i%2?g.session:other).codexRequest(a)));
 assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,24);assert(concurrent.filter(r=>r.status==='rejected').every(r=>r.reason.message==='DURABLE_MODEL_REQUEST_LIMIT'));assert.equal((await store.get(db,ctx,g.goal.id)).checkpoint.harness.codexRequests,24);
 await store.cancel(db,ctx,g.goal.id);await assert.rejects(g.session.checkpoint({cancelledMustNotSave:true}),/LEASE_LOST/);assert.equal((await store.get(db,ctx,g.goal.id)).status,'CANCELLED');
 const h=await fresh();await db.query("UPDATE stockchief_runtime.assistant_goals SET lease_until=now()-interval '1 second' WHERE id=$1",[h.goal.id]);await assert.rejects(h.session.checkpoint({expiredMustNotSave:true}),/LEASE_LOST/);
 const x=await fresh(),identity={actor:access.actor,stamp:require('node:crypto').createHash('sha256').update(JSON.stringify({permissions:access.actor.permissions,role:access.actor.role})).digest('hex')};
 assert.equal(await require('../../scripts/environment-agent-demo/native-transport-checkpoint').persist(db,{ctx:{...ctx,workspaceId:'another-business'},goalId:x.goal.id,runToken:x.goal.run_token,identity,operation:'native',data:{native:{foreignMustNotSave:true}}}),null);
 // jsonb's whitespace is larger than compact JSON. Preserve the existing
 // exact 8 MiB bound via the old validator, rather than silently lowering it.
 const nearLimit={dense:Array(400000).fill(1),padding:'x'.repeat(7*1024*1024)};assert(Buffer.byteLength(JSON.stringify(nearLimit))<8*1024*1024);await x.session.checkpoint(nearLimit);assert.equal((await store.get(db,ctx,x.goal.id)).checkpoint.harness.native.dense.length,400000);
 await assert.rejects(x.session.checkpoint({oversized:'x'.repeat(8*1024*1024)}),/SESSION_SIZE_LIMIT/);assert.equal((await store.get(db,ctx,x.goal.id)).checkpoint.harness.native.oversized,undefined);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
 t.diagnostic(JSON.stringify({paidCalls:0,transportStatements:4,concurrentRequestCap:24,revocationAndCancellationPreserved:true,exactSizeLimitPreserved:true}));
});
