'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('batched discovery entitlements equal individual checks and observe plan, override and membership changes',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline entitlement',businessName:'Latency fixture',email:randomUUID()+'@example.test',password:'Fake!'+randomUUID()});
 const scope={accountId:owner.accountId,workspaceId:owner.workspaceId},service=require('../../src/commercial/entitlements');
 const keys=['ask.lookup','ask.prepare_actions','inventory.core','inventory.kits','connections.custom_api'];
 async function compare(){let queries=0;const measured={...db,query:(...args)=>{queries++;return db.query(...args);}};
  const batch=await service.capabilityStates(measured,scope,keys,{now:new Date('2026-10-13T12:00:00Z')});
  assert.equal(queries,1,'Fresh ownership, subscription, overrides and plan are one coherent database snapshot');
  const subscription=await service.subscriptionFor(db,scope.accountId);
  for(const key of keys){assert.deepEqual(batch.get(key),await service.capabilityState(db,scope,key,{now:new Date('2026-10-13T12:00:00Z')}));
   if(subscription)assert.deepEqual(batch.get(key),await service.capabilityState(db,scope,key,{subscription,now:new Date('2026-10-13T12:00:00Z')}),'Matches the existing explicit-subscription admission path');}
 }
 await compare();
 await db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,status,billing_interval,current_period_start,current_period_end,source)
  VALUES($1,$2,'starter','ACTIVE','MONTHLY','2026-10-01','2026-11-01','TEST') ON CONFLICT(account_id) DO UPDATE SET
  plan_id='starter',plan_version_id=NULL,status='ACTIVE'`,[randomUUID(),owner.accountId]);await compare();
 await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason,starts_at)
  VALUES($1,$2,'connections.custom_api',1,'Offline comparison','2026-10-01')`,[randomUUID(),owner.accountId]);await compare();
 await db.query(`INSERT INTO commercial_entitlement_overrides(id,workspace_id,capability,enabled,reason,starts_at)
  VALUES($1,$2,'connections.custom_api',0,'Workspace override','2026-10-01')`,[randomUUID(),owner.workspaceId]);await compare();
 await db.query("UPDATE account_subscriptions SET plan_id='growth',plan_version_id=NULL WHERE account_id=$1",[owner.accountId]);await compare();
 const version=(await db.query("SELECT id FROM commercial_plan_versions WHERE plan_id='growth' ORDER BY created_at DESC LIMIT 1")).rows[0];
 assert(version);await db.query('UPDATE account_subscriptions SET plan_version_id=$2 WHERE account_id=$1',[owner.accountId,version.id]);await compare();
 await db.query("UPDATE account_subscriptions SET status='SUSPENDED' WHERE account_id=$1",[owner.accountId]);await compare();
 for(const [status,field,date] of [['GRACE','grace_ends_at','2026-10-12'],['TRIALING','trial_ends_at','2026-10-12'],['CANCELLED','current_period_end','2026-10-14']]){
  assert(['grace_ends_at','trial_ends_at','current_period_end'].includes(field));
  await db.query(`UPDATE account_subscriptions SET status=$2,${field}=$3 WHERE account_id=$1`,[scope.accountId,status,date]);await compare();
  const actual=await service.capabilityState(db,scope,'ask.lookup',{now:new Date('2026-10-13T12:00:00Z')});
  assert.equal(actual.access.canOperate,status==='CANCELLED');if(status!=='CANCELLED')assert.equal(actual.enabled,false);
  const expected=await service.capabilityState(db,scope,'ask.lookup',{subscription:await service.subscriptionFor(db,scope.accountId),now:new Date('2026-10-13T12:00:00Z'),allowReadOnly:true});
  assert.deepEqual(await service.capabilityState(db,scope,'ask.lookup',{now:new Date('2026-10-13T12:00:00Z'),allowReadOnly:true}),expected);
 }
 await db.query("UPDATE account_subscriptions SET status='ACTIVE',plan_id='starter' WHERE account_id=$1",[scope.accountId]);await compare();
 assert.equal((await service.capabilityState(db,scope,'connections.custom_api',{now:new Date('2026-10-13T12:00:00Z')})).enabled,false);
 await db.query("UPDATE commercial_entitlement_overrides SET ends_at='2026-10-12' WHERE workspace_id=$1",[scope.workspaceId]);await compare();
 assert.equal((await service.capabilityState(db,scope,'connections.custom_api',{now:new Date('2026-10-13T12:00:00Z')})).enabled,true,'Expired workspace denial falls back to the still-current account grant');
 await db.query("UPDATE commercial_entitlement_overrides SET ends_at='2026-10-12' WHERE account_id=$1",[scope.accountId]);await compare();
 assert.equal((await service.capabilityState(db,scope,'connections.custom_api',{now:new Date('2026-10-13T12:00:00Z')})).enabled,false,'A revoked grant is not cached');
 const oldRequired=process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;
 try{await db.query('DELETE FROM account_subscriptions WHERE account_id=$1',[scope.accountId]);
  process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';assert.equal((await service.capabilityState(db,scope,'ask.lookup')).enabled,false);
  process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='false';assert.equal((await service.capabilityState(db,scope,'ask.lookup')).source,'development');
 }finally{if(oldRequired===undefined)delete process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE;else process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE=oldRequired;}
 assert.deepEqual(await service.capabilityStates(db,scope,[]),new Map());
 await assert.rejects(service.capabilityState(db,{workspaceId:scope.workspaceId},'ask.lookup'),/commercial account/);
 await assert.rejects(service.capabilityStates(db,{...scope,accountId:randomUUID()},keys),/another commercial account/);
 await assert.rejects(service.capabilityStates(db,{...scope,accountId:randomUUID()},[]),/another commercial account/);
});
