'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('stock unit guards inspect only changed product keys at 50000 SKUs and retain exact units, scope and product locks',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('bounded-units',$1,'enterprise','COMP','ISOLATED_TEST')",[f.owner.accountId]);
 const ids=[];
 for(let start=0;start<5000;start+=100){const definitions=Array.from({length:100},(_,i)=>({name:'Precision family '+(start+i),trackingMode:'quantity',variants:Array.from({length:10},(_,v)=>({code:'PRECISION-'+(start+i)+'-'+v}))}));
  const created=await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,definitions),{isolation:'READ COMMITTED'});ids.push(...created.flatMap(p=>p.skus.map(s=>s.skuId)));}
 assert.equal(ids.length,50000);await db.query('ANALYZE skus; ANALYZE items');
 const old=fs.readFileSync(path.join(__dirname,'../../src/db/postgres-migrations/185-batched-stock-unit-guards.sql'),'utf8').match(/CREATE FUNCTION stockchief_batch_stock_precision_guard\(\)[\s\S]*?\$\$;/)[0].replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
 const scanCounts=async c=>Object.fromEntries((await c.query("SELECT relname,seq_scan FROM pg_stat_xact_user_tables WHERE schemaname='public' AND relname IN('items','skus')")).rows.map(r=>[r.relname,Number(r.seq_scan)]));
 const result={},rollback=Error('discard diagnostic stock');
 for(const variant of ['before','after']){
  await assert.rejects(db.transaction(async c=>{
   if(variant==='before')await c.query(old);
   await c.query("SET LOCAL plan_cache_mode='force_generic_plan'");
   // Exercise the actual trigger without unrelated projections obscuring its
   // scan counters. The temporary source has the same columns and table name.
   await c.query('CREATE TEMP TABLE balances (LIKE public.balances INCLUDING DEFAULTS) ON COMMIT DROP');
   await c.query('CREATE TRIGGER precision_probe AFTER INSERT ON pg_temp.balances REFERENCING NEW TABLE AS stock_measure_rows FOR EACH STATEMENT EXECUTE FUNCTION stockchief_batch_stock_precision_guard()');
   const before=await scanCounts(c),at=performance.now();
   await c.query('INSERT INTO pg_temp.balances(workspace_id,sku_id,location_id,on_hand,updated_at) SELECT $1,id,$3,2,$4 FROM unnest($2::text[]) id',[ctx.workspaceId,ids.slice(0,2000),f.location.id,new Date().toISOString()]);
   const ms=performance.now()-at,after=await scanCounts(c);result[variant]={ms,seqScans:{items:after.items-before.items,skus:after.skus-before.skus}};
   if(variant==='after'){
    assert.deepEqual(result.after.seqScans,{items:0,skus:0},'A stock batch must not scan any business catalogue');
    const itemId=(await c.query('SELECT item_id FROM skus WHERE id=$1',[ids[0]])).rows[0].item_id;
    await assert.rejects(db.transaction(other=>other.query('SELECT id FROM items WHERE id=$1 FOR UPDATE NOWAIT',[itemId]),{isolation:'READ COMMITTED'}),e=>e.code==='55P03','Unit definitions remain locked through commit');
    for(const value of [{workspace:ctx.workspaceId,sku:ids[0],quantity:1.25,secondary:null},{workspace:'foreign-workspace',sku:ids[0],quantity:1,secondary:null},{workspace:ctx.workspaceId,sku:'missing-sku',quantity:1,secondary:null},{workspace:ctx.workspaceId,sku:ids[0],quantity:1,secondary:1}]){
     await c.query('SAVEPOINT invalid_unit');
     await assert.rejects(c.query('INSERT INTO pg_temp.balances(workspace_id,sku_id,location_id,on_hand,secondary_on_hand,updated_at) VALUES($1,$2,$3,$4,$5,$6)',[value.workspace,value.sku,f.location.id,value.quantity,value.secondary,new Date().toISOString()]),e=>e.code==='validation_error'||e.code==='23514');
     await c.query('ROLLBACK TO SAVEPOINT invalid_unit');
    }
    assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.balances')).rows[0].n,2000);
   }
   throw rollback;
  },{isolation:'READ COMMITTED'}),e=>e===rollback);
 }
 t.diagnostic(JSON.stringify({catalogueSkus:50000,changedRows:2000,...result,paidCalls:0}));
});
