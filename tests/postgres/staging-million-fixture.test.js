'use strict';process.env.NODE_ENV='test';process.env.STOCKCHIEF_REQUIRE_PAID_WORKSPACE='true';
const test=require('node:test'),assert=require('node:assert/strict');
test('hosted scale fixture provisions its exact approved plan before accounting with paid enforcement enabled',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service');await assert.rejects(auth.createBusiness(db,{name:'Unpaid',businessName:'Unpaid fixture',email:'unpaid-fixture@example.test',password:'Fixture!unpaid-strong-password'}),e=>e.code==='entitlement_required');
 const fixture=require('../../scripts/lib/staging-million-fixture'),run='fixture-paid-first',owner=await fixture.provision(db,run);assert(owner.userId);assert.equal(await require('../../src/commercial/entitlements').assertCapability(db,{accountId:owner.accountId,workspaceId:owner.workspaceId},'accounting.core').then(s=>s.enabled),true);
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId};for(const name of require('../../scripts/lib/staging-million-source').warehouses)await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name,kind:'warehouse'});
 assert.deepEqual(await fixture.provision(db,run),owner,'Retry reuses only its exact synthetic inventory');assert.equal((await db.query('SELECT count(*)::int n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,5);
 const sub=await require('../../src/commercial/entitlements').subscriptionFor(db,owner.accountId);assert.equal(sub.plan_id,'pro');assert.equal(sub.plan_version_id,'approved-2026-11-02:pro');assert.equal(sub.status,'COMP');
 await db.query("UPDATE account_subscriptions SET source='OTHER_CONTRACT' WHERE account_id=$1",[owner.accountId]);await assert.rejects(fixture.provision(db,run),/differs/);assert.equal((await require('../../src/commercial/entitlements').subscriptionFor(db,owner.accountId)).source,'OTHER_CONTRACT');
});
