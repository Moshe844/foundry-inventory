'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('Platform owner controls revoke and restore real authority; canonical deletion is reviewed, isolated and reusable',{timeout:180000},async t=>{
 const oldEnvironment=process.env.STOCKCHIEF_RUNTIME_ENV;process.env.STOCKCHIEF_RUNTIME_ENV='staging';
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{process.env.STOCKCHIEF_RUNTIME_ENV=oldEnvironment;await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),access=require('../../src/domain/postgres-account-access'),deletion=require('../../src/domain/postgres-developer-accounts'),queue=require('../../src/operations/postgres-job-queue'),mfa=require('../../src/platform-owner/auth');
 const password='OwnerAccess!'+randomUUID(),actors={};
 for(const name of ['owner','customer','other']){const actor=await auth.createBusiness(db,{name,businessName:name+' business',email:randomUUID()+'@example.test',password,timeZone:'America/New_York'});actors[name]=actor;await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,source) VALUES($1,$2,'growth','COMP','CUSTOM','OFFLINE_TEST')",[randomUUID(),actor.accountId]);}
 await db.query("INSERT INTO platform_console_operators(account_id,role,granted_by) VALUES($1,'OWNER','ISOLATED_TEST')",[actors.owner.accountId]);
 const pending=await mfa.start(db,{email:actors.owner.email,password,ip:'isolated-test'}),challenge=await mfa.challenge(db,pending.challenge);assert((await mfa.verify(db,pending.challenge,mfa.codeAt(mfa.unseal(challenge.sealed_secret),Math.floor(Date.now()/30000)),pending.passwordVersion)).accountId);
 await assert.rejects(()=>access.review(db,actors.other.accountId,actors.customer.accountId),/platform owner/);assert.equal((await access.review(db,actors.owner.accountId,actors.owner.accountId)).canManage,false);
 const action=(kind,revision,key=randomUUID())=>({action:kind,revision,reason:'Isolated account-control verification.',confirmed:'yes',confirmEmail:actors.customer.email,requestKey:key});
 const pause=action('disable',0);const result=await access.change(db,actors.owner.accountId,actors.customer.accountId,pause);assert.equal(result.disabled,true);assert.equal((await access.change(db,actors.owner.accountId,actors.customer.accountId,pause)).replayed,true);
 await assert.rejects(()=>auth.authenticate(db,actors.customer.email,password),/access has been disabled/);assert.equal(await auth.resolveForAccount(db,actors.customer.accountId,actors.customer.workspaceId),null);
 await assert.rejects(()=>access.change(db,actors.owner.accountId,actors.customer.accountId,action('restore',0)),/account changed/);
 const operational=await require('../../src/commercial/entitlements').operationalAccessForWorkspace(db,actors.customer.workspaceId);assert.equal(operational.access.canOperate,false);assert.equal(operational.access.canRead,false);
 const blocked=await queue.enqueue(db,{workspaceId:actors.customer.workspaceId,kind:'test.account-access',idempotencyKey:'blocked',payload:{}}),allowed=await queue.enqueue(db,{workspaceId:actors.other.workspaceId,kind:'test.account-access',idempotencyKey:'allowed',payload:{}});
 assert.equal((await queue.claim(db,{owner:'owner-access-test',kinds:['test.account-access']})).id,allowed.job.id,'Disabled business jobs remain queued while another customer keeps working');
 assert.equal((await queue.get(db,blocked.job.id,actors.customer.workspaceId)).status,'PENDING');
 await access.change(db,actors.owner.accountId,actors.customer.accountId,action('restore',1));assert((await auth.authenticate(db,actors.customer.email,password)).id);assert((await auth.resolveForAccount(db,actors.customer.accountId,actors.customer.workspaceId)).workspace);
 assert.equal((await db.query('SELECT status FROM account_subscriptions WHERE account_id=$1',[actors.customer.accountId])).rows[0].status,'COMP','Access controls never rewrite billing');
 assert.equal((await queue.claim(db,{owner:'owner-access-test',kinds:['test.account-access']})).id,blocked.job.id);
 // Complete the controlled jobs before a deletion review can be accepted.
 await db.query("UPDATE stockchief_runtime.jobs SET status='COMPLETED',lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE kind='test.account-access'");
 const first=await deletion.review(db,actors.owner.accountId,actors.customer.email,{platformOwner:true});assert(first.blockers.some(s=>s.includes('Disable account access first')));
 await access.change(db,actors.owner.accountId,actors.customer.accountId,action('disable',2));
 const review=await deletion.review(db,actors.owner.accountId,actors.customer.email,{platformOwner:true});assert.equal(review.canDelete,true,review.blockers.join(' '));
 // Exercise production authorization against DISPOSABLE PostgreSQL, never a live account.
 process.env.STOCKCHIEF_RUNTIME_ENV='production';await assert.rejects(()=>deletion.review(db,actors.owner.accountId,actors.customer.email),/Staging only/);
 const input={email:actors.customer.email,confirmEmail:actors.customer.email,password,confirmed:'yes',reviewHash:review.reviewHash,reason:'Dispose of this isolated account and verify signup can use its email again.',requestKey:randomUUID()};
 const requested=await deletion.queue(db,actors.owner.accountId,input,{platformOwner:true});assert.equal((await deletion.queue(db,actors.owner.accountId,input,{platformOwner:true})).requestId,requested.requestId);
 const handlers=require('../../src/operations/postgres-runtime-handlers').create();
 const completed=await queue.processOne(db,{'developer.account-delete':handlers['developer.account-delete']},{owner:'actual-deletion-worker',leaseMs:180000});assert.equal(completed.status,'COMPLETED');assert.equal(completed.result.signInAccountRemoved,true);assert.equal((await db.query('SELECT 1 FROM accounts WHERE id=$1',[actors.customer.accountId])).rows.length,0);assert.equal((await db.query('SELECT 1 FROM workspaces WHERE id=$1',[actors.other.workspaceId])).rows.length,1);
 const again=await auth.createBusiness(db,{name:'New account',businessName:'New business',email:actors.customer.email,password,timeZone:'America/New_York'});assert.notEqual(again.accountId,actors.customer.accountId);assert.equal((await deletion.execute(db,requested.requestId)).replayed,true);
 t.diagnostic(JSON.stringify({actualPostgreSQL:true,accountAccessEnforced:true,billingUnchanged:true,otherTenantContinues:true,canonicalDeletion:true,emailCanRegisterAgain:true,productionBranchTestedInDisposableDatabase:true,liveAccountsChanged:0,paidCalls:0}));
});
