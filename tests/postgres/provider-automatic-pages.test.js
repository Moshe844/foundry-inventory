'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('automatic provider import pages pending identities, preserves complete families and resumes without replay',{timeout:240000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const at=new Date().toISOString(),id='automatic-pages';
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,provides,config,authorized_by_user_id,created_at,updated_at)
  VALUES($1,$2,$1,'Paged source','bigcommerce','connected','[]','{"autoImportCatalog":true}',$3,$4,$4)`,[id,ctx.workspaceId,ctx.actorId,at]);
 const scope=await require('../../src/commercial/entitlements').ownerScopeForWorkspace(db,ctx.workspaceId);
 for(const meter of ['products','active_skus'])await db.query(`INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason)
  VALUES($1,$2,$3,5000,'Provider pagination fixture')`,['pages-'+meter,scope.accountId,meter]);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];
 // Cross the 500-identity boundary; the last family has a sibling beyond it.
 const records=Array.from({length:1002},(_,i)=>({entityType:'sku',externalId:String(i).padStart(5,'0'),code:'AUTO-'+i,displayName:'Product '+i,
  parentExternalId:i>=499&&i<=501?'cross-page-family':null,providerData:{itemName:i>=499&&i<=501?'Cross page family':'Product '+i,
   selectedOptions:i>=499&&i<=501?[{name:'Size',value:String(i)}]:[],priceMoney:{amount:i,currency:'USD'}}}));
 const cache=require('../../src/connections/postgres-catalog-cache').cacheRecords;
 await db.transaction(async c=>{for(let start=0;start<records.length;start+=500)await cache(c,connection,records.slice(start,start+500));
  await c.query(`INSERT INTO connection_external_records(id,workspace_id,connector_id,entity_type,external_id,display_name,provider_data,mapping_status,selected,last_seen_at,created_at,updated_at)
   SELECT 'ignored-'||n,$1,$2,'sku','ignored-'||n,'Old nonphysical record','{"virtual":true}','EXCLUDED',1,$3,$3,$3 FROM generate_series(1,5000)n`,[ctx.workspaceId,id,at]);
 });
 let maxExternalRows=0,reads=0;
 const measure=async(client,sql,args)=>{const result=await client.query(sql,args);
  if(/^SELECT e\.\*/.test(sql)){reads++;maxExternalRows=Math.max(maxExternalRows,result.rows.length);}
  return result;};
 const measured={query:(sql,args)=>measure(db,sql,args),transaction:(fn,options)=>db.transaction(c=>fn({query:(sql,args)=>measure(c,sql,args)}),options)};
 const service=require('../../src/connections/postgres-catalog-import');
 const first=await service.importAutomatic(measured,ctx,id);
 assert.equal(first.products,1002);assert.equal(first.prices,1002);assert.equal(first.openingUnits,0);
 assert.equal(reads,2,'Only two selected pages are read, with the complete family in the first');assert.equal(maxExternalRows,502,'Unrelated cached records must never be loaded by an automatic batch');
 const family=(await db.query(`SELECT count(DISTINCT s.item_id)::int items,count(*)::int variants FROM connection_mappings m JOIN skus s ON s.id=m.foundry_record_id
  WHERE m.workspace_id=$1 AND m.connector_id=$2 AND m.external_id IN ('00499','00500','00501')`,[ctx.workspaceId,id])).rows[0];
 assert.deepEqual(family,{items:1,variants:3});
 assert.equal((await service.importAutomatic(measured,ctx,id)).products,0);
 assert.equal((await db.query("SELECT count(*)::int n FROM movements WHERE workspace_id=$1 AND reference='Provider opening stock'",[ctx.workspaceId])).rows[0].n,0);
 await db.query(`UPDATE workspace_connectors SET config='{}' WHERE id=$1`,[id]);
 assert.equal((await service.importAutomatic(measured,ctx,id)).skipped,'catalogue_import_not_enabled');
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other owner',businessName:'Other tenant',email:'other-pages@example.test',password:'Other-pages-test!12345'});
 await assert.rejects(service.importAutomatic(db,{workspaceId:other.workspaceId,actorId:other.userId},id),/not in this business/);
});
