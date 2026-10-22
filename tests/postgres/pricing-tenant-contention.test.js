'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('a bulk price import and another inventory price change commit without a cross-tenant serialization cycle',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),catalog=require('../../src/domain/postgres-catalog-service'),prices=require('../../src/pricing/postgres-service'),contexts=[];
 for(let n=0;n<2;n++){const o=await auth.createBusiness(db,{name:'Price reviewer',businessName:'Independent inventory '+n,email:randomUUID()+'@example.test',password:randomUUID()+'!A'});contexts.push({workspaceId:o.workspaceId,actorId:o.userId});}
 contexts.sort((a,b)=>a.workspaceId.localeCompare(b.workspaceId));const [a,b]=contexts,tag=randomUUID().slice(0,8),seed=[];
 for(const [n,ctx]of contexts.entries()){
  const item=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,[{name:'Existing family '+tag,trackingMode:'quantity',variants:Array.from({length:900},(_,i)=>({code:tag+'-'+n+'-'+i}))}]));
  const ids=item[0].skus.map(s=>s.skuId).sort();seed.push(ids);
  for(let i=0;i<ids.length;i+=300)await db.transaction(c=>prices.setPricesInTransaction(c,ctx,ids.slice(i,i+300).map(skuId=>({skuId,currency:'USD',amountMinor:1100}))));
 }
 await db.query('ANALYZE sku_prices');await db.query('ANALYZE skus');
 let reach,release;const reached=new Promise(r=>reach=r),held=new Promise(r=>release=r);let lockShape;
 const importing=db.transaction(async client=>{
  const items=await catalog.createImportedItemsInTransaction(client,a,[{name:'New family '+tag,trackingMode:'quantity',variants:Array.from({length:600},(_,i)=>({code:tag+'-new-'+i}))}]);
  const guarded={query:async(sql,values)=>{
   if(/INSERT INTO sku_prices\(/.test(sql)){
    lockShape=(await client.query("SELECT locktype,count(*)::int n FROM pg_locks WHERE pid=pg_backend_pid() AND relation='sku_prices'::regclass AND mode='SIReadLock' GROUP BY locktype")).rows;reach();await held;
   }
   return client.query(sql,values);
  }};
  return prices.setPricesInTransaction(guarded,a,items[0].skus.map(s=>({skuId:s.skuId,currency:'USD',amountMinor:1250})),{initialize:true});
 },{isolation:'SERIALIZABLE'}).then(value=>({ok:true,value}),error=>({ok:false,code:error.code,message:error.message}));
 await reached;
 const other=await db.transaction(async c=>{
  // A tenant-filtered report can still use a sequential plan. Its broad
  // predicate must not combine with a broad price read in the other tenant.
  await c.query('SET LOCAL enable_indexscan=off; SET LOCAL enable_bitmapscan=off');
  await c.query('SELECT count(*) FROM skus WHERE workspace_id=$1',[b.workspaceId]);
  await c.query('SET LOCAL enable_indexscan=on; SET LOCAL enable_bitmapscan=on');
  return prices.setPricesInTransaction(c,b,[{skuId:seed[1][450],currency:'USD',amountMinor:1350}]);
 },{isolation:'SERIALIZABLE'}).then(value=>({ok:true,value}),error=>({ok:false,code:error.code,message:error.message}));
 release();const imported=await importing;
 t.diagnostic(JSON.stringify({importCommitted:imported.ok,otherCommitted:other.ok,importError:imported.code,otherError:other.code,priceReadLocks:lockShape}));
 assert(imported.ok&&other.ok,'Independent inventories must both commit: '+JSON.stringify({imported,other}));
 assert.equal(imported.value.length,600);assert.equal((await prices.currentPrice(db,b.workspaceId,seed[1][450])).amount_minor,1350);
 assert.equal(Number((await db.query('SELECT count(*) n FROM sku_prices WHERE workspace_id=$1 AND amount_minor=1250',[a.workspaceId])).rows[0].n),600);
 await assert.rejects(db.transaction(c=>prices.setPricesInTransaction(c,a,[{skuId:seed[0][0],currency:'USD',amountMinor:0}],{initialize:true})),/unpublished variants/);
});
