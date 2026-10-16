'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{Pool}=require('pg');
test('cold inspection schema setup cannot wait on goals while holding the event table against native progress',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString),pool=new Pool({connectionString:cluster.connectionString});let writer,setup,inspector;
 t.after(async()=>{for(const client of [writer,setup])if(client){await client.query('ROLLBACK').catch(()=>{});client.release();}if(inspector)await inspector.close();await pool.end();await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline owner',businessName:'Schema contention',email:require('node:crypto').randomUUID()+'@example.test',password:'Offline!'+require('node:crypto').randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Foreign owner',businessName:'Foreign schema fixture',email:require('node:crypto').randomUUID()+'@example.test',password:'Offline!'+require('node:crypto').randomUUID()});
 const goal=await require('../../src/assistant/postgres-goal-store').create(db,ctx,'Investigate the current business without changing records.');
 writer=await pool.connect();setup=await pool.connect();
 // Reproduce the exact relation-order cycle possible in inspection.js's
 // alphabetical policy batch: events precede goals, progress does the reverse.
 await writer.query("BEGIN; SET LOCAL deadlock_timeout='50ms'; SET LOCAL statement_timeout='5s'");await writer.query('SELECT id FROM stockchief_runtime.assistant_goals WHERE id=$1 FOR UPDATE',[goal.id]);
 await setup.query("BEGIN; SET LOCAL statement_timeout='5s'; LOCK TABLE stockchief_runtime.assistant_goal_events IN ACCESS EXCLUSIVE MODE");
 const ddl=setup.query('LOCK TABLE stockchief_runtime.assistant_goals IN ACCESS EXCLUSIVE MODE').catch(e=>e);
 const progress=await writer.query("INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail) VALUES('old-deadlock',$1,1,'agent_activity','{}')",[goal.id]).catch(e=>e);
 assert.equal(progress.code,'40P01','The old partial lock order must actually deadlock in PostgreSQL');await writer.query('ROLLBACK');await ddl;await setup.query('ROLLBACK');
 let observedBusy;const busy=new Promise(resolve=>{observedBusy=resolve;});let retries=0,mutations=0;
 const measured={...db,transaction:(operation,settings)=>{assert.equal(settings.isolation,'SERIALIZABLE');assert.equal(settings.retrySafe,true);return db.transaction(client=>operation({query:async(sql,args)=>{
  try{return await client.query(sql,args);}catch(e){if(e.code==='55P03'){retries++;observedBusy();}throw e;}
 }}),settings);}};
 await writer.query("BEGIN; SET LOCAL statement_timeout='1s'");await writer.query('SELECT id FROM stockchief_runtime.assistant_goals WHERE id=$1 FOR UPDATE',[goal.id]);
 const names=[{table_schema:'stockchief_runtime',table_name:'assistant_goal_events'},{table_schema:'stockchief_runtime',table_name:'assistant_goals'}];
 const installed=require('../../scripts/environment-agent-demo/inspection-schema').mutate(measured,names,async client=>{mutations++;await client.query('SELECT 1');});
 await busy;assert.equal(mutations,0,'Busy admission must precede every schema mutation');
 await writer.query("INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail) VALUES('first-progress',$1,1,'agent_activity','{}')",[goal.id]);await writer.query('COMMIT');
 await installed;assert.equal(mutations,1);assert(retries>=1);assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1',[goal.id])).rows[0].n,'1');
 // Exercise the actual metadata-driven role/policy installer under the same
 // busy native relation, including its existing SELECT-only RLS privileges.
 const actualBusy=new Promise(resolve=>{observedBusy=resolve;});
 await writer.query("BEGIN; SET LOCAL statement_timeout='1s'");await writer.query('SELECT id FROM stockchief_runtime.assistant_goals WHERE id=$1 FOR UPDATE',[goal.id]);
 const starting=require('../../scripts/environment-agent-demo/inspection').inspectionDatabase(cluster,measured,ctx);
 await actualBusy;assert.equal(Number((await db.query("SELECT count(*) AS n FROM pg_roles WHERE rolname LIKE 'demo_read_%'")).rows[0].n),0,'A rejected busy setup creates no partial role');
 await writer.query("INSERT INTO stockchief_runtime.assistant_goal_events(id,goal_id,sequence,kind,detail) VALUES('second-progress',$1,2,'agent_activity','{}')",[goal.id]);await writer.query('COMMIT');
 inspector=await starting;assert.deepEqual((await inspector.query('SELECT id FROM workspaces')).rows.map(r=>r.id),[ctx.workspaceId]);
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_goal_events WHERE goal_id=$1',[goal.id])).rows[0].n,'2');
 await assert.rejects(inspector.query("UPDATE workspaces SET name='Forbidden' WHERE id=$1",[ctx.workspaceId]),e=>e.code==='25006'||e.code==='42501');
 let attempts=0;await assert.rejects(require('../../scripts/environment-agent-demo/inspection-schema').mutate({transaction:async()=>{attempts++;throw Object.assign(new Error('busy'),{code:'55P03'});}},names,()=>{}),e=>e.code==='55P03');assert.equal(attempts,12,'Schema contention retries are bounded');
 attempts=0;await assert.rejects(require('../../scripts/environment-agent-demo/inspection-schema').mutate({transaction:async()=>{attempts++;throw Object.assign(new Error('permission denied'),{code:'42501'});}},names,()=>{}),e=>e.code==='42501');assert.equal(attempts,1,'Authorization failures never retry');
 t.diagnostic(JSON.stringify({oldLockCycle:'40P01',partialLockWaitingRemoved:true,financialIsolation:'SERIALIZABLE',businessChanges:0,modelCalls:0}));
});
