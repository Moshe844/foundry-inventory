'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('location evidence exposes complete active state and receiving-location eligibility from canonical activity checks',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Location owner',businessName:'Location scope',email:randomUUID()+'@example.test',password:'Scope!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},locations=require('../../src/domain/postgres-location-service');
 const active=await locations.createLocation(db,ctx,{name:'Receiving warehouse',kind:'warehouse'}),inactive=await locations.createLocation(db,ctx,{name:'Archived warehouse',kind:'warehouse'});await locations.setLocationActive(db,ctx,inactive.id,false);
 const read=await require('../../src/assistant/postgres-service').lookup(db,ctx,{view:'locations'});
 assert.equal(read.rows.length,2,'Recorded live failure: generic location evidence silently excludes inactive locations');const rows=new Map(read.rows.map(r=>[r.name,r]));
 assert.equal(rows.get(active.name).active,true);assert.equal(rows.get(active.name).receivingLocationEligible,true);assert.equal(rows.get(inactive.name).active,false);assert.equal(rows.get(inactive.name).receivingLocationEligible,false);assert.equal(read.scope.includesInactive,true);assert.equal(read.scope.eligibilityBasis,'location_activity_only');
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Receiving check',baseCode:'LOCATION-CHECK',trackingMode:'quantity'}),engine=require('../../src/domain/postgres-inventory-engine');
 await engine.receive(db,ctx,{skuId:item.skuIds[0],locationId:active.id,quantity:1,idempotencyKey:randomUUID()});
 await assert.rejects(engine.receive(db,ctx,{skuId:item.skuIds[0],locationId:inactive.id,quantity:1,idempotencyKey:randomUUID()}),/archived/);
 assert.equal(Number((await db.query('SELECT coalesce(sum(on_hand),0) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),1);
 t.diagnostic(JSON.stringify({completeActivityScope:true,eligibilityCheckedAgainstCanonicalEngine:true,noNewExecutionAuthority:true,paidCalls:0}));
});
