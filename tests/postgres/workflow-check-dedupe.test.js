'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

// A due workflow item gets one waiting check, not a new one every minute while
// the worker is busy. Staging piled up thousands of duplicates this way.
test('a due workflow item keeps one waiting check while the worker is behind',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  const owner=require('../../src/operations/postgres-workflow-ownership');
  const past=new Date(Date.now()-60*60000).toISOString();
  await db.query(`INSERT INTO work_items(id,workspace_id,category,source,source_evidence,affected_entities,recommended_action,
    confidence,approval_requirement,execution_status,verification_status,idempotency_key,outcome,created_at,due_at)
    VALUES('wi_dedupe_test',$1,'business_follow_through',$2,'[]','{}',$3,'high','NONE','EXECUTING','PENDING','dedupe-test','{}',$4,$4)`,
  [ctx.workspaceId,owner.SOURCE,JSON.stringify({type:'customer_order',recordId:'none'}),past]);
  const waiting=async()=>Number((await db.query(`SELECT count(*) FROM stockchief_runtime.jobs WHERE workspace_id=$1
    AND kind='workflow.follow-through' AND status IN ('PENDING','RUNNING','RETRY') AND payload->>'workId'='wi_dedupe_test'`,[ctx.workspaceId])).rows[0].count);
  const now=Date.now();
  await db.transaction(c=>owner.scheduleDue(c,now));
  assert.equal(await waiting(),1,'the due item is queued once');
  // Three more scheduler passes in later minutes, with the check still waiting.
  for(const minutes of [1,2,3])await db.transaction(c=>owner.scheduleDue(c,now+minutes*60000));
  assert.equal(await waiting(),1,'a waiting check is not duplicated in later minutes');
  // Once the check has finished, the next due pass queues a new one.
  await db.query(`UPDATE stockchief_runtime.jobs SET status='COMPLETED',completed_at=now() WHERE workspace_id=$1 AND kind='workflow.follow-through'`,[ctx.workspaceId]);
  await db.transaction(c=>owner.scheduleDue(c,now+4*60000));
  assert.equal(await waiting(),1,'a finished check makes room for the next one');
});

test('migration 479 cancels identical waiting checks and keeps the oldest',{timeout:240000},async t=>{
  const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx}=f;
  const queue=require('../../src/operations/postgres-job-queue');
  for(const minute of [1,2,3])await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:'workflow.follow-through',
    idempotencyKey:'workflow-check:wi_dupes:due-'+minute,payload:{workId:'wi_dupes'},priority:45,maxAttempts:5});
  await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:'workflow.follow-through',idempotencyKey:'workflow-check:wi_other:due-1',payload:{workId:'wi_other'},priority:45,maxAttempts:5});
  const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,'../../src/db/postgres-migrations/479-workflow-check-duplicates.sql'),'utf8');
  await db.query(sql);
  const rows=(await db.query(`SELECT payload->>'workId' work,status,idempotency_key FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='workflow.follow-through' AND payload->>'workId' IN ('wi_dupes','wi_other') ORDER BY idempotency_key`,[ctx.workspaceId])).rows;
  assert.deepEqual(rows.map(r=>[r.work,r.status]),[['wi_dupes','PENDING'],['wi_dupes','CANCELLED'],['wi_dupes','CANCELLED'],['wi_other','PENDING']]);
  assert.equal(rows[0].idempotency_key,'workflow-check:wi_dupes:due-1','the oldest check stays');
  await db.query(sql);
  assert.equal((await db.query(`SELECT count(*) FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND status='PENDING' AND payload->>'workId' IN ('wi_dupes','wi_other')`,[ctx.workspaceId])).rows[0].count,'2','running it again changes nothing');
});

test('supplier claim scheduling keeps one active scan and cleans up only unstarted duplicate roots',{timeout:240000},async t=>{
  const {db,ctx}=await require('../helpers/agent-workflow-fixture').fixture(t);
  const claims=require('../../src/purchasing/agent-supplier-claims');
  const queue=require('../../src/operations/postgres-job-queue');
  const kind='agent.supplier-claims';
  const schedule=cycle=>db.transaction(c=>claims.schedule(c,ctx.workspaceId,cycle),{isolation:'SERIALIZABLE',retrySafe:true});
  const [first,second]=await Promise.all([schedule('a'),schedule('b')]);
  assert.equal(Number(first.created)+Number(second.created),1);
  const root=(first.job||second.job).id;
  const insert=async (cycle,extra={})=>(await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind,
    idempotencyKey:cycle,payload:{cycleId:cycle,...extra}})).job.id;
  const duplicate=await insert('other-root');
  const continuation=await insert('another-page',{afterId:'hold:example'});
  const started=await insert('started');
  await db.query("UPDATE stockchief_runtime.jobs SET status='RETRY',attempt_count=1 WHERE id=$1",[started]);
  const sql=require('node:fs').readFileSync(require('node:path').join(__dirname,
    '../../src/db/postgres-migrations/490-supplier-claim-scan-deduplication.sql'),'utf8');
  await db.query(sql);
  for(const id of [root,duplicate])assert.equal((await queue.get(db,id,ctx.workspaceId)).status,'CANCELLED');
  assert.equal((await queue.get(db,continuation,ctx.workspaceId)).status,'PENDING');
  assert.equal((await queue.get(db,started,ctx.workspaceId)).status,'RETRY');
  assert.equal((await schedule('c')).created,false);
  await db.query(sql);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM stockchief_runtime.job_events WHERE job_id=ANY($1::text[]) AND event_type='DUPLICATE_CANCELLED'",[[root,duplicate]])).rows[0].n,2);
  await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED' WHERE id=ANY($1::text[])",[[continuation,started]]);
  assert.equal((await schedule('next-cycle')).created,true);
});
