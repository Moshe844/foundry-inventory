'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('maintenance status uses bounded scoped reads through 50,000 old jobs and retains failure and recovery messages',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,jobs=require('../../src/operations/postgres-job-queue'),progress=require('../../src/operations/postgres-maintenance-progress');
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Unrelated checks',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()});
 await db.query(`INSERT INTO stockchief_runtime.jobs(id,workspace_id,kind,status,available_at,idempotency_key,created_at,updated_at,result)
  SELECT 'old-check-'||n,CASE WHEN n%5=0 THEN $2 ELSE $1 END,
   CASE WHEN n%2=0 THEN 'autopilot.evaluate' ELSE 'system.reconcile-business' END,'COMPLETED',0,'old-check-'||n,
   '2026-01-01'::timestamptz+n*interval '1 second','2026-01-01'::timestamptz+n*interval '1 second',
   jsonb_build_object('status','VERIFIED','detail',repeat('historical detail ',100)) FROM generate_series(1,50000)n`,[ctx.workspaceId,other.workspaceId]);
 const first=await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:'current-planning',priority:40,payload:{processedSkus:1200,unused:'.'.repeat(8000)}}),second=await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'current-reconciliation',priority:41,payload:{processedSkus:2500,unused:'.'.repeat(8000)}});
 await db.query('ANALYZE stockchief_runtime.jobs');const probes=[];
 const snapshot=()=>db.transaction(async c=>progress.read({query:async(sql,values)=>{const result=await c.query(sql,values);if(sql.includes('stockchief_runtime.jobs')){assert(Buffer.byteLength(JSON.stringify(result.rows))<2000,'Status reads must not transfer saved job documents');const plan=(await c.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+sql,values)).rows[0]['QUERY PLAN'][0];assert(plan.Plan['Shared Hit Blocks']+plan.Plan['Shared Read Blocks']<100,'Status reads must not walk completed job history');probes.push(plan.Plan['Shared Hit Blocks']);}return result;}},ctx.workspaceId),{readOnly:true,isolation:'READ COMMITTED'});
 let model=await snapshot();assert(model.active);assert.deepEqual(model.checks.map(v=>v.checked),[1200,2500]);assert(!model.attention);
 await db.query(`INSERT INTO stockchief_runtime.business_reconciliation_runs(id,workspace_id,status,summary)
  VALUES('own-checks',$1,'RUNNING',$3::jsonb),('foreign-checks',$2,'RUNNING','{"checkedRecords":999999}')`,[ctx.workspaceId,other.workspaceId,JSON.stringify({checkedRecords:3500,unused:'.'.repeat(8000)})]);
 await db.query("UPDATE stockchief_runtime.jobs SET payload=payload||'{\"runId\":\"own-checks\"}' WHERE id=$1",[second.job.id]);assert.equal((await snapshot()).checks[1].checked,3500);
 await db.query("UPDATE stockchief_runtime.jobs SET payload=payload||'{\"runId\":\"foreign-checks\"}' WHERE id=$1",[second.job.id]);assert.equal((await snapshot()).checks[1].checked,0,'A foreign inventory checkpoint must not be read');
 await db.query("UPDATE stockchief_runtime.jobs SET payload=payload||'{\"runId\":\"own-checks\"}' WHERE id=$1",[second.job.id]);
 const claimed=await jobs.claim(db,{owner:'status-fixture',kinds:['autopilot.evaluate']});assert.equal(claimed.id,first.job.id);assert.equal((await snapshot()).checks[0].status,'RUNNING');await jobs.fail(db,claimed.id,claimed.leaseToken,Error('Disposable failed check'),{retryable:false});
 model=await snapshot();assert(model.attention);assert.match(model.message,/stopped before completion/);assert.equal(model.checks.length,1);
 await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'autopilot.evaluate',idempotencyKey:'replacement-planning',payload:{processedSkus:5}});
 await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',result=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1",[second.job.id,JSON.stringify({status:'FAILED',unused:'.'.repeat(8000)})]);model=await snapshot();assert(model.attention);assert.match(model.message,/found differences/);assert.equal(model.checks[0].checked,5);
 await db.query("UPDATE stockchief_runtime.jobs SET result='{\"status\":\"VERIFIED\"}',updated_at=clock_timestamp() WHERE id=$1",[second.job.id]);model=await snapshot();assert(!model.attention);assert.equal((await progress.read(db,other.workspaceId)).attention,false);assert.equal((await progress.read(db,'missing-inventory')).active,false);assert.equal(await f.balance(),4);
 assert(probes.length>=10);t.diagnostic(JSON.stringify({historicalJobs:50000,largestReadPages:Math.max(...probes),readOnly:true,stockUnchanged:true}));
});
