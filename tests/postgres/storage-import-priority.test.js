'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const until=async check=>{for(const end=Date.now()+5000;Date.now()<end;){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('The storage priority condition was not reached');};
test('storage audits give active imports priority and release their old snapshot before retrying',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,storage=require('../../src/commercial/storage-capacity'),jobs=require('../../src/operations/postgres-job-queue');
 await db.query("INSERT INTO suppliers(id,workspace_id,name,status,currency,created_at,updated_at) SELECT 'storage-priority-'||n,$1,'Supplier café '||n,'active','USD',now(),now() FROM generate_series(1,3000)n",[ctx.workspaceId]);
 const expression=(await db.query("SELECT bytes_expression FROM commercial_storage_tables WHERE relation='suppliers'::regclass")).rows[0].bytes_expression;
 const expected=async()=>(await db.query('SELECT sum('+expression+')::text bytes FROM suppliers t WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].bytes;
 const claim=async(kind='fixture.storage-bulk',owner='storage-priority:bulk')=>{const queued=await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:randomUUID()});const leased=await jobs.claim(db,{owner,kinds:[kind]});assert.equal(leased.id,queued.job.id);return leased;};
 const release=async job=>jobs.complete(db,job.id,job.leaseToken,{verified:true});
 let fetches=0,activeSeen=0,fullCursorPlan=false,onFirstFetch=null,auditPid=null;
 const observed={...db,query:async(sql,values)=>{const result=await db.query(sql,values);if(sql.includes("lease_owner LIKE '%:bulk'")&&result.rows.length)activeSeen++;return result;},transaction:(operation,options)=>db.transaction(async c=>{auditPid=Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);return operation({query:async(sql,values)=>{if(sql==='SET LOCAL cursor_tuple_fraction=1.0')fullCursorPlan=true;const result=await c.query(sql,values);if(sql.startsWith('FETCH FORWARD')){fetches++;if(fetches===1&&onFirstFetch)await onFirstFetch();}return result;}});},options)};
 await t.test('a reading-lane source import delays the audit before its first fetch',async()=>{
  const before=await expected(),job=await claim('import.analyse-source','storage-priority:reading');fetches=0;activeSeen=0;
  const audit=storage.baseline(observed,ctx.workspaceId,'suppliers',{yieldToImports:true,bulkPollMs:20});
  try{await until(()=>activeSeen>0);assert.equal(fetches,0);assert.equal((await db.query('SELECT 1 n')).rows[0].n,1);}finally{await release(job);}
  assert.equal((await audit).measured,true);assert(fetches>=4);assert(fullCursorPlan);assert.equal((await db.query("SELECT baseline_bytes::text bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation='suppliers'::regclass",[ctx.workspaceId])).rows[0].bytes,before);
 });
 await t.test('an import that starts during an audit releases xmin and retries from a fresh exact snapshot',async()=>{
  const before=await expected();let job;fetches=0;activeSeen=0;onFirstFetch=async()=>{job=await claim();};
  const inspector=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:1});
  const audit=storage.baseline(observed,ctx.workspaceId,'suppliers',{yieldToImports:true,bulkPollMs:20});
  try{await assert.rejects(audit,error=>error.code==='storage_audit_yielded'&&error.retryable===true&&error.retryAfterMs===5000);assert.equal(fetches,1);
   const activity=(await inspector.query('SELECT backend_xmin,xact_start FROM pg_stat_activity WHERE pid=$1',[auditPid])).rows[0];assert.equal(activity.backend_xmin,null);assert.equal(activity.xact_start,null);
   assert.equal((await db.query("SELECT baseline_bytes::text bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation='suppliers'::regclass",[ctx.workspaceId])).rows[0].bytes,before);
   await db.query("UPDATE suppliers SET name=name||'-after-snapshot' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  }finally{if(job)await release(job);onFirstFetch=null;await inspector.close();}
  assert.notEqual(await expected(),before);fetches=0;assert.equal((await storage.baseline(observed,ctx.workspaceId,'suppliers',{yieldToImports:true,bulkPollMs:20})).measured,true);
  assert.equal((await db.query("SELECT baseline_bytes::text bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation='suppliers'::regclass",[ctx.workspaceId])).rows[0].bytes,await expected());
 });
 await t.test('a one-connection reader can yield before opening its snapshot without waiting on itself',async()=>{
  const single=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:1}),job=await claim();let done=false;
  try{const audit=storage.baseline(single,ctx.workspaceId,'suppliers',{yieldToImports:true,bulkPollMs:20}).then(value=>{done=true;return value;});await new Promise(r=>setTimeout(r,40));assert.equal(done,false);await release(job);assert.equal((await audit).measured,true);}finally{await release(job);await single.close();}
 });
 await t.test('expired bulk leases do not hold audits and runtime handlers enable import yielding',async()=>{
  const job=await claim();await db.query('UPDATE stockchief_runtime.jobs SET lease_expires_at=0 WHERE id=$1',[job.id]);assert.equal((await storage.baseline(db,ctx.workspaceId,'suppliers',{yieldToImports:true,bulkPollMs:20})).measured,true);await jobs.recoverExpired(db);
  let options;const mock=t.mock.method(storage,'baseline',async(...args)=>{options=args[3];return {measured:true};});try{await require('../../src/operations/postgres-runtime-handlers').create()['commercial.storage-baseline']({workspaceId:ctx.workspaceId,payload:{relation:'suppliers'}},db);assert.equal(options.yieldToImports,true);}finally{mock.mock.restore();}
 });
});
