'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
// A very large inventory is removed in many short committed batches. This drives
// the real owner-console deletion with tiny batches, stops it part way, proves the
// guard is re-checked on every batch, then resumes it after its approval window.
test('owner-console deletion removes an inventory in committed batches, resumes after an interruption and never touches another owner',{timeout:300000},async t=>{
 const oldEnvironment=process.env.STOCKCHIEF_RUNTIME_ENV,oldAdmins=process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS;process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{process.env.STOCKCHIEF_RUNTIME_ENV=oldEnvironment;if(oldAdmins===undefined)delete process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS;else process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS=oldAdmins;await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),access=require('../../src/domain/postgres-account-access'),deletion=require('../../src/domain/postgres-developer-accounts'),queue=require('../../src/operations/postgres-job-queue'),mfa=require('../../src/platform-owner/auth');
 const catalog=require('../../src/domain/postgres-catalog-service'),engine=require('../../src/domain/postgres-inventory-engine'),places=require('../../src/domain/postgres-location-service');
 const password='OwnerAccess!'+randomUUID(),actors={};
 for(const name of ['owner','customer','other','disabled']){const actor=await auth.createBusiness(db,{name,businessName:name+' business',email:randomUUID()+'@example.test',password,timeZone:'America/New_York'});actors[name]=actor;await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_TEST')",[randomUUID(),actor.accountId]);}
 // The owner is admitted by the configured administrator list only, as on the live
 // service. Their first MFA sign-in stores the Owner record that account access,
 // deletion and the database guard rely on.
 process.env.STOCKCHIEF_COMMERCIAL_ADMIN_EMAILS=[actors.owner.email,actors.disabled.email].join(',');
 await assert.rejects(access.assertOwner(db,actors.owner.accountId),/platform owner/,'No stored Owner record before the MFA sign-in');
 const pending=await mfa.start(db,{email:actors.owner.email,password,ip:'isolated-test'}),challenge=await mfa.challenge(db,pending.challenge);assert((await mfa.verify(db,pending.challenge,mfa.codeAt(mfa.unseal(challenge.sealed_secret),Math.floor(Date.now()/30000)),pending.passwordVersion)).accountId);
 assert.deepEqual((await db.query('SELECT role,active FROM platform_console_operators WHERE account_id=$1',[actors.owner.accountId])).rows,[{role:'OWNER',active:true}]);
 assert.equal((await db.query("SELECT count(*)::int n FROM commercial_change_audit WHERE subject_type='platform_console_operator' AND subject_id=$1 AND action='owner_record_stored'",[actors.owner.accountId])).rows[0].n,1);
 await access.assertOwner(db,actors.owner.accountId);
 // An explicitly disabled operator stays disabled even when listed as an administrator.
 await db.query("INSERT INTO platform_console_operators(account_id,role,active,granted_by) VALUES($1,'OWNER',false,'ISOLATED_TEST')",[actors.disabled.accountId]);
 await assert.rejects(mfa.start(db,{email:actors.disabled.email,password,ip:'isolated-test'}),/Unable to sign in/);
 assert.equal((await db.query('SELECT active FROM platform_console_operators WHERE account_id=$1',[actors.disabled.accountId])).rows[0].active,false);
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
 // Emails sent to the account leave delivery receipts that refer to its jobs; they
 // must not block removing those jobs. Another account's receipt is kept.
 const mailed=async actor=>{const job=(await queue.enqueue(db,{kind:'test.account-email',idempotencyKey:'mail-'+actor.accountId,payload:{accountId:actor.accountId}})).job;
  await db.query("INSERT INTO commercial_email_deliveries(job_id,payload_sha256,provider_id,accepted_attempt,accepted_at) VALUES($1,'isolated',$2,1,now())",[job.id,'provider-'+job.id]);return job.id;};
 const customerMail=await mailed(actors.customer),otherMail=await mailed(actors.other);
 await db.query("UPDATE developer_account_deletions SET execution_started_at=now()-interval '3 hours',expires_at=now()-interval '2 hours' WHERE id=$1",[requested.requestId]);
 const done=[],handlers=require('../../src/operations/postgres-runtime-handlers').create(),resume={purge:{batchRows:3,onBatch:b=>{if(b.done)done.push(b);}}};
 // A business record that refers to the account's work stops the final step, which
 // keeps the account; links are read from the catalogue, so a new table counts too.
 await db.query('CREATE TABLE public.isolated_job_reference(id text PRIMARY KEY,workspace_id text,job_id text NOT NULL REFERENCES stockchief_runtime.jobs(id))');
 await db.query("INSERT INTO public.isolated_job_reference VALUES('reference',$1,$2)",[actors.other.workspaceId,customerMail]);
 await assert.rejects(deletion.execute(db,requested.requestId,resume),/another business/);
 assert.equal((await db.query('SELECT count(*)::int n FROM accounts WHERE id=$1',[actors.customer.accountId])).rows[0].n,1,'The account is kept while another business refers to its work');
 assert.equal((await db.query('SELECT count(*)::int n FROM public.isolated_job_reference')).rows[0].n,1,'Another business keeps its record');
 await db.query('DROP TABLE public.isolated_job_reference');
 const result=await deletion.execute(db,requested.requestId,resume);
 assert.equal(result.signInAccountRemoved,true);assert(done.some(b=>b.batches>1),'Larger tables were removed in more than one batch');
 assert.deepEqual(await counts(actors.customer.workspaceId),{items:0,skus:0,movements:0,units:0});
 assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id=$1',[actors.customer.workspaceId])).rows.length,0);
 assert.equal((await db.query('SELECT 1 FROM accounts WHERE id=$1',[actors.customer.accountId])).rows.length,0);
 assert.deepEqual(await counts(actors.other.workspaceId),otherBefore,'Another owner keeps every record');
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.jobs WHERE id=$1',[customerMail])).rows[0].n,0,'The removed account’s email job is gone');
 assert.equal((await db.query('SELECT count(*)::int n FROM commercial_email_deliveries WHERE job_id=$1',[customerMail])).rows[0].n,0,'…with its delivery receipt');
 assert.equal((await db.query('SELECT count(*)::int n FROM commercial_email_deliveries WHERE job_id=$1',[otherMail])).rows[0].n,1,'Another account keeps its delivery receipt');
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
