'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('batched discovery entitlements equal individual checks and observe plan, override and membership changes',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Offline entitlement',businessName:'Latency fixture',email:randomUUID()+'@example.test',password:'Fake!'+randomUUID()});
 const scope={accountId:owner.accountId,workspaceId:owner.workspaceId},service=require('../../src/commercial/entitlements');
 const keys=['ask.lookup','ask.prepare_actions','inventory.core','inventory.kits','connections.custom_api'];
 async function compare(){let queries=0;const measured={...db,query:(...args)=>{queries++;return db.query(...args);}};
  const batch=await service.capabilityStates(measured,scope,keys,{now:'2026-10-13T12:00:00Z'});
  assert(queries<=4,'Query count is bounded independently of catalogue size');
  for(const key of keys)assert.deepEqual(batch.get(key),await service.capabilityState(db,scope,key,{now:'2026-10-13T12:00:00Z'}));
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
 await assert.rejects(service.capabilityStates(db,{...scope,accountId:randomUUID()},keys),/another commercial account/);
});
