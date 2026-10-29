'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('provider catalogue caching batches round trips while preserving exact, ambiguous, ignored and excluded identities',{timeout:180000},async t=>{
 const {db,ctx,item}=await require('../helpers/postgres-shipping-fixture').fixture(t);
 const at=new Date().toISOString(),connection={id:'cache-connector',workspace_id:ctx.workspaceId,display_name:'Cache source',authorized_by_user_id:ctx.actorId};
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
  VALUES($1,$2,'cache-source','Cache source','fixture_catalog','[]','{}','connected','[]',60,'CONNECTED',$3,$4,$4)`,[connection.id,ctx.workspaceId,ctx.actorId,at]);
 const cache=require('../../src/connections/postgres-catalog-cache').cacheRecords;
 const known=(await db.query('SELECT code FROM skus WHERE id=$1',[item.skuIds[0]])).rows[0].code;
 await db.query(`INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES('ambiguous-a',$1,'Ambiguous name','quantity',1,$2,$2),('ambiguous-b',$1,'Ambiguous name','quantity',1,$2,$2)`,[ctx.workspaceId,at]);
 await db.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) VALUES('ambiguous-sku-a',$1,'ambiguous-a','AMB-A',1,$2),('ambiguous-sku-b',$1,'ambiguous-b','AMB-B',1,$2)`,[ctx.workspaceId,at]);
 const special=[{entityType:'sku',externalId:'known',code:known,displayName:'Known'},
  {entityType:'sku',externalId:'ambiguous',displayName:'Ambiguous',providerData:{itemName:'Ambiguous name'}},
  {entityType:'sku',externalId:'excluded',displayName:'Gift card',providerData:{isGiftCard:true}},
  {entityType:'sku',externalId:'ignored',displayName:'Ignored'}];
 await db.transaction(c=>cache(c,connection,[special.at(-1)]));
 await db.query("UPDATE connection_external_records SET mapping_status='IGNORED' WHERE workspace_id=$1 AND connector_id=$2 AND external_id='ignored'",[ctx.workspaceId,connection.id]);
 const records=[...special,...Array.from({length:3000},(_,i)=>({entityType:'sku',externalId:'unmatched-'+i,code:'SOURCE-'+i,displayName:'Unmatched '+i,providerData:{itemName:'Unmatched '+i}}))];
 let queries=0,results=[],elapsed=performance.now();
 await db.transaction(async c=>{const measured={query:(sql,args)=>{queries++;return c.query(sql,args);}};
  for(let start=0;start<records.length;start+=500)results.push(...await cache(measured,connection,records.slice(start,start+500)));
 });
 assert.deepEqual(results.slice(0,4),['mapped','unmapped','ignored','ignored']);assert(results.slice(4).every(r=>r==='unmapped'));assert(queries<70,`Expected bounded page round trips, got ${queries}`);
 assert.equal(Number((await db.query('SELECT count(*) n FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2',[ctx.workspaceId,connection.id])).rows[0].n),3004);
 assert.equal(Number((await db.query("SELECT count(*) n FROM connection_issues WHERE workspace_id=$1 AND connector_id=$2 AND status='OPEN'",[ctx.workspaceId,connection.id])).rows[0].n),3001);
 assert.equal((await db.query("SELECT foundry_record_id FROM connection_mappings WHERE workspace_id=$1 AND connector_id=$2 AND external_id='known'",[ctx.workspaceId,connection.id])).rows[0].foundry_record_id,item.skuIds[0]);
 await assert.rejects(db.transaction(c=>cache(c,connection,[special[0],special[0]])),/duplicate/);
 t.diagnostic(JSON.stringify({records:records.length,queries,elapsedMs:Math.round(performance.now()-elapsed),actualPostgres:true}));
});
