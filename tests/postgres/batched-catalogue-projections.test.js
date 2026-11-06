'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('catalogue statements batch search and exact SKU rollups without losing concurrent parent deltas',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('catalogue-batch-fixture',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const definitions=Array.from({length:100},(_,p)=>({name:'Batch projection '+p,trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({code:'BATCH-PROJECTION-'+p+'-'+v}))})),created=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions)),ids=created.flatMap(i=>i.skus.map(s=>s.skuId)),parents=created.map(i=>i.itemId);
 async function verify(){
  const bad=(await db.query(`SELECT r.item_id FROM item_catalog_rollups r WHERE r.workspace_id=$1 AND r.item_id=ANY($2::text[]) AND
   (r.sku_count<>(SELECT count(*) FROM skus s WHERE s.workspace_id=r.workspace_id AND s.item_id=r.item_id)
    OR r.first_sku_id IS DISTINCT FROM(SELECT id FROM skus s WHERE s.workspace_id=r.workspace_id AND s.item_id=r.item_id ORDER BY position,id LIMIT 1)
    OR r.first_sku_code IS DISTINCT FROM(SELECT code FROM skus s WHERE s.workspace_id=r.workspace_id AND s.item_id=r.item_id ORDER BY position,id LIMIT 1))`,[ctx.workspaceId,parents])).rows;assert.deepEqual(bad,[]);
  const documents=(await db.query(`SELECT s.id FROM skus s JOIN items i ON i.workspace_id=s.workspace_id AND i.id=s.item_id
   LEFT JOIN search_documents d ON d.workspace_id=s.workspace_id AND d.entity_type='sku' AND d.entity_id=s.id
   WHERE s.workspace_id=$1 AND s.item_id=ANY($2::text[]) AND(d.entity_id IS NULL
    OR d.title IS DISTINCT FROM i.name||' '||coalesce(s.variant_label,'')
    OR d.identifiers IS DISTINCT FROM s.code||' '||coalesce(s.barcode,''))`,[ctx.workspaceId,parents])).rows;assert.deepEqual(documents,[]);
 }
 await verify();
 await db.query("UPDATE items SET name=name||' renamed',description='Updated batch description',updated_at=now() WHERE workspace_id=$1 AND id=ANY($2::text[])",[ctx.workspaceId,parents]);
 await db.query("UPDATE skus SET code=code||'-V2',barcode='barcode-'||id,position=-position WHERE workspace_id=$1 AND id=ANY($2::text[])",[ctx.workspaceId,ids]);await verify();
 await db.query(`INSERT INTO supplier_items(id,workspace_id,supplier_id,sku_id,supplier_sku,supplier_description,created_at,updated_at)
  SELECT 'batch-si-'||n,$1,'fixture-supplier',sku,'SUPPLIER-'||n,'Description '||n,now(),now()
  FROM unnest($2::text[]) WITH ORDINALITY AS v(sku,n)`,[ctx.workspaceId,ids]);
 assert.equal((await db.query("SELECT count(*)::int n FROM search_documents WHERE workspace_id=$1 AND entity_type='supplier_item' AND entity_id LIKE 'batch-si-%'",[ctx.workspaceId])).rows[0].n,1000);
 await db.query("UPDATE supplier_items SET supplier_description='Changed supplier description',supplier_sku='UPDATED-'||id WHERE workspace_id=$1 AND id LIKE 'batch-si-%'",[ctx.workspaceId]);
 assert.equal((await db.query("SELECT count(*)::int n FROM search_documents WHERE workspace_id=$1 AND entity_type='supplier_item' AND entity_id LIKE 'batch-si-%' AND title='Changed supplier description' AND identifiers LIKE 'UPDATED-%'",[ctx.workspaceId])).rows[0].n,1000);
 await db.query("DELETE FROM supplier_items WHERE workspace_id=$1 AND id LIKE 'batch-si-%'",[ctx.workspaceId]);assert.equal((await db.query("SELECT count(*)::int n FROM search_documents WHERE workspace_id=$1 AND entity_type='supplier_item' AND entity_id LIKE 'batch-si-%'",[ctx.workspaceId])).rows[0].n,0);
 let release,signal;const hold=new Promise(r=>release=r),inserted=new Promise(r=>signal=r),parent=parents[0];
 const one=db.transaction(async c=>{await c.query("INSERT INTO skus(id,workspace_id,item_id,code,variant_label,position,is_active,created_at) VALUES('batch-concurrent-a',$1,$2,'CONCURRENT-A','A',1000,1,now())",[ctx.workspaceId,parent]);signal();await hold;},{isolation:'READ COMMITTED'});
 try{await inserted;const two=db.transaction(c=>c.query("INSERT INTO skus(id,workspace_id,item_id,code,variant_label,position,is_active,created_at) VALUES('batch-concurrent-b',$1,$2,'CONCURRENT-B','B',1001,1,now())",[ctx.workspaceId,parent]),{isolation:'READ COMMITTED'});await new Promise(r=>setTimeout(r,50));release();await Promise.all([one,two]);}finally{release();await one;}
 await verify();assert.equal((await db.query('SELECT sku_count::int n FROM item_catalog_rollups WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,parent])).rows[0].n,12);
 await db.query('DELETE FROM skus WHERE workspace_id=$1 AND id=ANY($2::text[])',[ctx.workspaceId,ids.slice(0,10)]);await verify();
 const oldRowTriggers=(await db.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND (tgtype & 1)=1 AND tgfoid=ANY(ARRAY[
  'stockchief_search_item_trigger()'::regprocedure,'stockchief_search_sku_trigger()'::regprocedure,
  'stockchief_search_supplier_item_trigger()'::regprocedure,'stockchief_sku_rollup_trigger()'::regprocedure])`)).rows;assert.deepEqual(oldRowTriggers,[]);
});
