'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('QC upgrade preserves prior migration checksums and existing positive and negative balances', {timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 const migrate=require('../../src/db/migrate-postgres').migratePostgres;await migrate(db,{through:'302-agent-promotion-stock.sql'});
 const before=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'QC upgrade owner',businessName:'QC preserved stock',email:randomUUID()+'@example.test',password:'Upgrade!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Preserved stock',baseCode:'QC-UPGRADE',trackingMode:'quantity'}),locations=require('../../src/domain/postgres-location-service');
 const a=await locations.createLocation(db,ctx,{name:'Positive old position',kind:'warehouse'}),b=await locations.createLocation(db,ctx,{name:'Negative old book balance',kind:'warehouse'});
 await db.query('INSERT INTO balances(workspace_id,sku_id,location_id,on_hand,updated_at) VALUES($1,$2,$3,8,now()::text),($1,$2,$4,-2,now()::text)',[ctx.workspaceId,item.skuIds[0],a.id,b.id]);
 await migrate(db,{through:'303-agent-quality-holds.sql'});const after=(await db.query('SELECT name,checksum FROM stockchief_postgres_migrations ORDER BY name')).rows;assert.equal(after.length,before.length+1);assert.deepEqual(after.filter(r=>r.name!=='303-agent-quality-holds.sql'),before);
 assert.deepEqual((await db.query('SELECT on_hand::int,quality_held::int FROM balances WHERE workspace_id=$1 ORDER BY on_hand',[ctx.workspaceId])).rows,[{on_hand:-2,quality_held:0},{on_hand:8,quality_held:0}]);
 await migrate(db,{through:'303-agent-quality-holds.sql'});assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.agent_quality_holds')).rows[0].n,0);
});
