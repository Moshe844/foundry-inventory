'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// A very large inventory is removed in many short committed batches. This drives
// the real owner-console deletion with tiny batches, stops it part way, proves the
// guard is re-checked on every batch, then resumes it after its approval window.
test('owner-console deletion removes an inventory in committed batches, resumes after an interruption and never touches another owner',{timeout:300000},async t=>{
 const oldEnvironment=process.env.STOCKCHIEF_RUNTIME_ENV;process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{process.env.STOCKCHIEF_RUNTIME_ENV=oldEnvironment;await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),access=require('../../src/domain/postgres-account-access'),deletion=require('../../src/domain/postgres-developer-accounts'),queue=require('../../src/operations/postgres-job-queue'),mfa=require('../../src/platform-owner/auth');
 const catalog=require('../../src/domain/postgres-catalog-service'),engine=require('../../src/domain/postgres-inventory-engine'),places=require('../../src/domain/postgres-location-service');
 const password='OwnerAccess!'+randomUUID(),actors={};
 for(const name of ['owner','customer','other']){const actor=await auth.createBusiness(db,{name,businessName:name+' business',email:randomUUID()+'@example.test',password,timeZone:'America/New_York'});actors[name]=actor;await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_TEST')",[randomUUID(),actor.accountId]);}
 await db.query("INSERT INTO platform_console_operators(account_id,role,granted_by) VALUES($1,'OWNER','ISOLATED_TEST')",[actors.owner.accountId]);
 const pending=await mfa.start(db,{email:actors.owner.email,password,ip:'isolated-test'}),challenge=await mfa.challenge(db,pending.challenge);assert((await mfa.verify(db,pending.challenge,mfa.codeAt(mfa.unseal(challenge.sealed_secret),Math.floor(Date.now()/30000)),pending.passwordVersion)).accountId);
 // Two businesses with the same kind of records: products, SKUs, stock and history.
 const stocked=async(actor,count)=>{const ctx={workspaceId:actor.workspaceId,actorId:actor.userId},place=await places.createLocation(db,ctx,{name:'Shelf',kind:'warehouse'});
  for(let i=0;i<count;i++){const item=await catalog.createItem(db,ctx,{name:'Product '+i,baseCode:'P'+i+'-'+randomUUID().slice(0,6),trackingMode:'quantity'});await engine.receive(db,ctx,{skuId:item.skuIds[0],locationId:place.id,quantity:i+1,idempotencyKey:'stock-'+i});}};
 await stocked(actors.customer,24);await stocked(actors.other,6);
 const counts=async workspaceId=>(await db.query(`SELECT (SELECT count(*)::int FROM items WHERE workspace_id=$1) items,(SELECT count(*)::int FROM skus WHERE workspace_id=$1) skus,
  (SELECT count(*)::int FROM movements WHERE workspace_id=$1) movements,(SELECT coalesce(sum(on_hand),0)::int FROM balances WHERE workspace_id=$1) units`,[workspaceId])).rows[0];
 const otherBefore=await counts(actors.other.workspaceId),customerBefore=await counts(actors.customer.workspaceId);
 assert.deepEqual([customerBefore.items,customerBefore.units],[24,300]);
 const action=(kind,revision)=>({action:kind,revision,reason:'Isolated batched deletion verification.',confirmed:'yes',confirmEmail:actors.customer.email,requestKey:randomUUID()});
 await access.change(db,actors.owner.accountId,actors.customer.accountId,action('disable',0));
 const review=await deletion.review(db,actors.owner.accountId,actors.customer.email,{platformOwner:true});assert.equal(review.canDelete,true,review.blockers.join(' '));
 process.env.STOCKCHIEF_RUNTIME_ENV='production';
 const requested=await deletion.queue(db,actors.owner.accountId,{email:actors.customer.email,confirmEmail:actors.customer.email,password,confirmed:'yes',reviewHash:review.reviewHash,reason:'Remove a large isolated inventory in batches.',requestKey:randomUUID()},{platformOwner:true});

 // 1. Stop the removal after a few committed batches, as a worker restart would.
 const seen=[];let stopAfter=6;
 const tiny={batchRows:3,onBatch:async b=>{seen.push(b);if(b.rows&&--stopAfter===0)throw Object.assign(new Error('worker stopped'),{code:'test_interrupt'});}};
 await assert.rejects(deletion.execute(db,requested.requestId,{purge:tiny}),/worker stopped/);
 const part=await counts(actors.customer.workspaceId),request=(await db.query('SELECT status,execution_started_at,expires_at FROM developer_account_deletions WHERE id=$1',[requested.requestId])).rows[0];
 assert.equal(request.status,'EXECUTING');assert(request.execution_started_at);
 assert((await db.query('SELECT deletion_requested_at FROM workspaces WHERE id=$1',[actors.customer.workspaceId])).rows[0].deletion_requested_at,'The inventory is closed while its rows are removed');
 assert(seen.filter(b=>b.rows).length>=6,'Rows were removed by several committed batches');
 assert.deepEqual(await counts(actors.other.workspaceId),otherBefore,'Another owner is untouched part way through');
 assert((await db.query('SELECT 1 FROM accounts WHERE id=$1',[actors.customer.accountId])).rows.length,'The sign-in account is removed only at the end');
 // Work for the closed inventory cannot be claimed against partly removed records.
 const closed=await queue.enqueue(db,{workspaceId:actors.customer.workspaceId,kind:'test.closed-inventory',idempotencyKey:'closed',payload:{}});
 assert.equal(await queue.claim(db,{owner:'closed-inventory-test',kinds:['test.closed-inventory']}),null);assert.equal((await queue.get(db,closed.job.id,actors.customer.workspaceId)).status,'PENDING');

 // 2. Every batch re-checks the database guard: restoring access stops removal.
 let flipped=false;const restore=()=>db.query('UPDATE platform_account_access SET disabled_at=NULL WHERE account_id=$1',[actors.customer.accountId]);
 await assert.rejects(deletion.execute(db,requested.requestId,{purge:{batchRows:3,onBatch:async x=>{if(x.rows&&!flipped){flipped=true;await restore();}}}}),/no longer authorized/);
 assert(flipped);const kept=await counts(actors.customer.workspaceId);
 await assert.rejects(deletion.execute(db,requested.requestId,{purge:{batchRows:3}}),/no longer authorized|retention period/);
 assert.deepEqual(await counts(actors.customer.workspaceId),kept,'No batch runs without the guard');
 await db.query('UPDATE platform_account_access SET disabled_at=now() WHERE account_id=$1',[actors.customer.accountId]);

 // 3. Resume after the approval window: a removal started in time may finish.
 await db.query("UPDATE developer_account_deletions SET execution_started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[requested.requestId]);
 const done=[],handlers=require('../../src/operations/postgres-runtime-handlers').create();
 const result=await deletion.execute(db,requested.requestId,{purge:{batchRows:3,onBatch:b=>{if(b.done)done.push(b);}}});
 assert.equal(result.signInAccountRemoved,true);assert(done.some(b=>b.batches>1),'Larger tables were removed in more than one batch');
 assert.deepEqual(await counts(actors.customer.workspaceId),{items:0,skus:0,movements:0,units:0});
 assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id=$1',[actors.customer.workspaceId])).rows.length,0);
 assert.equal((await db.query('SELECT 1 FROM accounts WHERE id=$1',[actors.customer.accountId])).rows.length,0);
 assert.deepEqual(await counts(actors.other.workspaceId),otherBefore,'Another owner keeps every record');
 assert.equal((await deletion.execute(db,requested.requestId)).replayed,true);
 const replay=await queue.processOne(db,{'developer.account-delete':handlers['developer.account-delete']},{owner:'replay-worker',leaseMs:60000});assert.equal(replay.status,'COMPLETED');assert.equal(replay.result.replayed,true);

 // 4. An approval that expired before removal started is still refused.
 process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 await access.change(db,actors.owner.accountId,actors.other.accountId,{...action('disable',0),confirmEmail:actors.other.email});
 const late=await deletion.review(db,actors.owner.accountId,actors.other.email,{platformOwner:true});assert.equal(late.canDelete,true,late.blockers.join(' '));
 process.env.STOCKCHIEF_RUNTIME_ENV='production';
 const stale=await deletion.queue(db,actors.owner.accountId,{email:actors.other.email,confirmEmail:actors.other.email,password,confirmed:'yes',reviewHash:late.reviewHash,reason:'Expired approval must not start.',requestKey:randomUUID()},{platformOwner:true});
 await db.query("UPDATE developer_account_deletions SET expires_at=now()-interval '1 minute' WHERE id=$1",[stale.requestId]);
 await assert.rejects(deletion.execute(db,stale.requestId),/expired/);
 assert.deepEqual(await counts(actors.other.workspaceId),otherBefore,'An expired approval removes nothing');
 assert.equal((await db.query('SELECT status,execution_started_at FROM developer_account_deletions WHERE id=$1',[stale.requestId])).rows[0].status,'QUEUED');
 t.diagnostic(JSON.stringify({actualPostgreSQL:true,committedBatches:seen.filter(b=>b.rows).length,interruptedAndResumed:true,guardEveryBatch:true,otherOwnerUntouched:true,expiredApprovalRefused:true}));
});
