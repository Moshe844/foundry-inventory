'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
test('an account on the older copy of Growth has custom roles with nothing to accept, and only what its plan now includes',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Older plan',email:randomUUID()+'@example.test',password:'Older-'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},entitlements=require('../../src/commercial/entitlements'),scope=await entitlements.ownerScopeForWorkspace(db,ctx.workspaceId);
 // The copy an account froze on, as migration 178 left it: no custom roles.
 const copy=async plan=>{await db.query(`INSERT INTO commercial_plan_versions(id,plan_id,version_number,status,currency,monthly_amount_minor,annual_amount_minor,entitlements,meters)
   SELECT 'before-approved-2026-11-02:'||$1,$1,max(version_number)+1,'RETIRED','USD',1000,10000,'[{"capability":"sales_orders.core","enabled":1,"configuration":{}}]'::jsonb,'[]'::jsonb FROM commercial_plan_versions WHERE plan_id=$1
   ON CONFLICT(id) DO UPDATE SET entitlements=excluded.entitlements,meters=excluded.meters`,[plan]);};
 await copy('growth');await copy('starter');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,'growth','before-approved-2026-11-02:growth','ACTIVE',now(),now()+interval '1 month')",[randomUUID(),scope.accountId]);
 assert.equal((await entitlements.capabilityState(db,scope,'authority.advanced')).enabled,false,'locked before the change');
 await db.query(fs.readFileSync(path.join(__dirname,'../../src/db/postgres-migrations/195-custom-roles-on-older-plan-copies.sql'),'utf8'));
 assert.equal((await entitlements.capabilityState(db,scope,'authority.advanced')).enabled,true);
 assert.equal((await entitlements.capabilityState(db,scope,'sales_orders.core')).enabled,true,'what the copy already had stays');
 assert.equal((await entitlements.capabilityState(db,scope,'reports.advanced')).enabled,false,'only custom roles were added');
 const gates=await require('../../src/web/presentation/plan-gates').read(db,scope);assert.equal(gates['authority.advanced'].enabled,true);
 const role=await require('../../src/operations/postgres-team-access').saveRole(db,ctx,{name:'Buyer',permissions:['VIEW']});assert(role);
 // Starter's current offer does not include them, so its copy is untouched.
 await db.query('UPDATE account_subscriptions SET plan_id=$1,plan_version_id=$2 WHERE account_id=$3',['starter','before-approved-2026-11-02:starter',scope.accountId]);
 assert.equal((await entitlements.capabilityState(db,scope,'authority.advanced')).enabled,false);
});
