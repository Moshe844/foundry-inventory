'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('stock expiry remains bounded with 50,000 pending variants before planner statistics catch up',{timeout:240000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Expiry scale fixture',email:randomUUID()+'@example.test',password:'Expiry!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('expiry-scale-subscription',$1,'enterprise','COMP','ISOLATED_TEST')",[owner.accountId]);
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Any option',baseCode:'EXPIRY-BASE',trackingMode:'quantity'});
 await db.query(`INSERT INTO items(id,workspace_id,name,base_code,tracking_mode,created_at,updated_at)
  SELECT 'expiry-product-'||n,$1,'Expiry product '||n,'EXPIRY-P-'||n,'quantity',now(),now() FROM generate_series(1,4999)n`,[ctx.workspaceId]);
 // Use the same bounded catalogue writes as a real import; this fixture is
 // measuring recommendation expiry, not a single 50,000-row catalogue write.
 for(let start=1;start<50000;start+=500)await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,created_at)
  SELECT 'expiry-variant-'||n,$1,CASE WHEN n<10 THEN $2 ELSE 'expiry-product-'||(n/10) END,'EXPIRY-'||n,now() FROM generate_series($3::int,$4::int)n`,[ctx.workspaceId,item.itemId,start,Math.min(start+499,49999)]);
 for(const mode of ['force_generic_plan','force_custom_plan']){
  const rollback=Error('End isolated expiry scenario');await assert.rejects(db.transaction(async c=>{
   await c.query('SET LOCAL plan_cache_mode='+mode);t.diagnostic(JSON.stringify({mode,...await require('../helpers/replenishment-expiry-checks').check(c,ctx)}));throw rollback;
  }),e=>e===rollback);
 }
});
