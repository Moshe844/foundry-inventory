'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');

test('reconciliation checkpoints retain a late mismatch across retries and complete every invariant without changing the books',
  {timeout:180000},async t=>{
  const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
  const reconciliation=require('../../src/operations/postgres-reconciliation');
  const at=new Date().toISOString();
  await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,position,is_active,created_at)
    SELECT 'check-'||lpad(n::text,6,'0'),$1,$2,'CHECK-'||n,n+100,1,$3 FROM generate_series(1,751)n`,
    [ctx.workspaceId,f.item.itemId,at]);
  await db.query(`INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at)
    VALUES($1,'check-000751',$2,2,$3)`,[ctx.workspaceId,f.location.id,at]);
  const before=await f.balance();
  let state=await db.transaction(client=>reconciliation.runBatch(client,ctx.workspaceId));
  assert.equal(state.partial,true);assert.equal(state.checkedRecords,250);
  const runId=state.id;
  await assert.rejects(db.transaction(async client=>{
    await reconciliation.runBatch(client,ctx.workspaceId,{runId});throw new Error('simulated worker interruption');
  }),/simulated worker interruption/);
  assert.equal((await db.query('SELECT summary FROM stockchief_runtime.business_reconciliation_runs WHERE id=$1',[runId])).rows[0].summary.checkedRecords,250);
  let count=state.checkedRecords,batches=1;
  while(state.partial){state=await db.transaction(client=>reconciliation.runBatch(client,ctx.workspaceId,{runId}));
    assert(state.checkedRecords>=count,'Committed reconciliation progress moved backwards');
    count=state.checkedRecords;assert(++batches<20);
  }
  assert.equal(state.status,'FAILED');assert.equal(state.checks.length,5);
  assert.equal(state.checks.find(c=>c.key==='inventory.balance_equals_movements').rows[0].sku_id,'check-000751');
  assert.equal(Number((await db.query('SELECT suspended FROM workspace_autopilot WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].suspended),1);
  assert.equal(await f.balance(),before,'A read-only check changed stock');
  const replay=await db.transaction(client=>reconciliation.runBatch(client,ctx.workspaceId,{runId}));
  assert.equal(replay.partial,false);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.business_reconciliation_checks WHERE run_id=$1',[runId])).rows[0].n,5,'Replay duplicated checks');
  const other=await require('../../src/domain/postgres-auth-service').createWorkspace(db,f.owner.accountId,{name:'Isolated reconciliation'});
  await assert.rejects(reconciliation.runBatch(db,other.workspaceId,{runId}),/not found/i);
  const queue=require('../../src/operations/postgres-job-queue');
  const handlers=require('../../src/operations/postgres-runtime-handlers').create();
  await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'queued-proof'});
  const first=await queue.processOne(db,{'system.reconcile-business':handlers['system.reconcile-business']},{owner:'reconciliation-first'});
  assert.equal(first.result.partial,true);
  const interrupted=await queue.processOne(db,{'system.reconcile-business':async()=>{throw Object.assign(new Error('synthetic terminal interruption'),{retryable:false});}},{owner:'reconciliation-interrupted'});
  assert.equal(interrupted.status,'DEAD');
  const retained=(await db.query('SELECT * FROM stockchief_runtime.business_reconciliation_runs WHERE id=$1',[first.result.id])).rows[0];
  assert.equal(retained.status,'FAILED');assert.equal(retained.summary.incomplete,true);
  assert.equal(retained.summary.checkedRecords,250);
  await queue.retryDead(db,interrupted.id,ctx.workspaceId,{by:'isolated-test'});
  let final;
  while((final=await queue.processOne(db,{'system.reconcile-business':handlers['system.reconcile-business']},{owner:'reconciliation-resumed'}))){
    assert.equal(final.status,'COMPLETED');if(!final.result.partial)break;
  }
  assert.equal(final.result.status,'FAILED');assert.equal(final.result.checks.length,5);
  assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.business_reconciliation_checks WHERE run_id=$1',[first.result.id])).rows[0].n,5);
  assert.equal(await f.balance(),before);
  t.diagnostic(JSON.stringify({batches,checkedRecords:count,lateMismatchFound:true,stockUnchanged:true,paidCalls:0}));
});
