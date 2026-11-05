'use strict';
const assert=require('node:assert/strict');
async function check(db,ctx){
 const storage=require('../../src/commercial/storage-capacity'),jobs=require('../../src/operations/postgres-job-queue');
 const relation='accounting_journal_lines',before=(await db.query("SELECT baseline_bytes::text bytes,measured_at::text at FROM commercial_storage_usage WHERE workspace_id=$1 AND relation=$2::regclass",[ctx.workspaceId,relation])).rows[0];
 const rows=Number((await db.query('SELECT count(*) n FROM accounting_journal_lines WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);assert(rows>=150000);
 let fetches=0,job,pid;
 const observed={...db,transaction:(operation,options)=>db.transaction(async c=>{pid=Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid);return operation({query:async(sql,values)=>{
  const result=await c.query(sql,values);if(sql.startsWith('FETCH FORWARD')&&++fetches===1){
   const kind='fixture.storage-midscan';await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:'large-storage-midscan'});job=await jobs.claim(db,{owner:'large-storage-midscan:bulk',kinds:[kind]});assert(job);
   await new Promise(resolve=>setTimeout(resolve,25));
  }return result;
 }});},options)};
 // Hold a separate observer so the rolled-back audit connection cannot be
 // reused by this activity query and acquire a new snapshot under observation.
 await db.transaction(async observer=>{
  try{await assert.rejects(storage.baseline(observed,ctx.workspaceId,relation,{yieldToImports:true,bulkPollMs:20}),e=>e.code==='storage_audit_yielded'&&e.retryable===true&&e.retryAfterMs===5000);
   assert.equal(fetches,1);const activity=(await observer.query('SELECT backend_xmin,xact_start FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];assert.equal(activity.backend_xmin,null);assert.equal(activity.xact_start,null);
   assert.deepEqual((await observer.query("SELECT baseline_bytes::text bytes,measured_at::text at FROM commercial_storage_usage WHERE workspace_id=$1 AND relation=$2::regclass",[ctx.workspaceId,relation])).rows[0],before);
  }finally{if(job)await jobs.complete(db,job.id,job.leaseToken,{verified:true});}
 },{isolation:'READ COMMITTED',readOnly:true});
 const expression=(await db.query('SELECT bytes_expression FROM commercial_storage_tables WHERE relation=$1::regclass',[relation])).rows[0].bytes_expression;
 const expected=(await db.query('SELECT sum('+expression+')::text bytes FROM accounting_journal_lines t WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].bytes;
 assert.equal((await storage.baseline(db,ctx.workspaceId,relation,{yieldToImports:true,bulkPollMs:20})).measured,true);
 assert.equal((await db.query('SELECT baseline_bytes::text bytes FROM commercial_storage_usage WHERE workspace_id=$1 AND relation=$2::regclass',[ctx.workspaceId,relation])).rows[0].bytes,expected);
 return {storageRows:rows,oldSnapshotReleased:true,partialBytesUnpublished:true,freshRetryExact:true,paidCalls:0};
}
module.exports={check};
