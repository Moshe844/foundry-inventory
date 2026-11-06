'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('bulk cost coverage writes one final position and survives rollback, early constraints and concurrent opposite-side changes',{timeout:180000},async t=>{
 const {db,ctx,item,location}=await require('../helpers/postgres-shipping-fixture').fixture(t),params=[ctx.workspaceId,item.skuIds[0],location.id];
 const position=async c=>(await c.query('SELECT physical_units::text physical,costed_units::text costed,book_cost_minor::text value,missing_units::text missing FROM inventory_cost_coverage_positions WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',params)).rows[0];
 const physical=(c,n)=>c.query('UPDATE balances SET on_hand=$4 WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[...params,n]);
 const cost=(c,n)=>c.query('UPDATE accounting_inventory_cost_balances SET quantity_units=$4::numeric,total_cost_minor=($4::numeric*100)::bigint WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',[...params,n]);
 const defer=c=>c.query("SET LOCAL stockchief.defer_import_coverage='on'"),rollback=Error('deliberate rollback');
 assert.deepEqual(await position(db),{physical:'4',costed:'4',value:'400',missing:'0'});
 await assert.rejects(db.transaction(async c=>{await physical(c,5);assert.equal((await position(c)).physical,'5','Ordinary writers still see immediate coverage');throw rollback;}),e=>e===rollback);
 await db.transaction(async c=>{
  await c.query('CREATE TEMP TABLE coverage_write_probe(sku_id text) ON COMMIT DROP');
  await c.query("CREATE FUNCTION pg_temp.coverage_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO pg_temp.coverage_write_probe VALUES(NEW.sku_id); RETURN NULL; END $$");
  await c.query('CREATE TRIGGER qualification_coverage_probe AFTER INSERT OR UPDATE ON inventory_cost_coverage_positions FOR EACH ROW EXECUTE FUNCTION pg_temp.coverage_probe()');
  await defer(c);await physical(c,6);await physical(c,7);await cost(c,7);
  assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.stockchief_import_coverage')).rows[0].n,1);
  await c.query('SELECT stockchief_flush_import_coverage()');
  assert.equal((await c.query('SELECT count(*)::int n FROM pg_temp.coverage_write_probe')).rows[0].n,1,'The final physical and cost fields cause only one persistent write');
  assert.deepEqual(await position(c),{physical:'7',costed:'7',value:'700',missing:'0'});
  await c.query('DROP TRIGGER qualification_coverage_probe ON inventory_cost_coverage_positions');
 },{isolation:'READ COMMITTED'});
 assert.deepEqual(await position(db),{physical:'7',costed:'7',value:'700',missing:'0'});
 await assert.rejects(db.transaction(async c=>{await defer(c);await physical(c,9);await cost(c,9);await c.query('SELECT stockchief_flush_import_coverage()');throw rollback;},{isolation:'READ COMMITTED'}),e=>e===rollback);
 assert.equal((await position(db)).physical,'7','Failed batches roll back both stock and projection');
 await db.transaction(async c=>{await defer(c);await c.query('SAVEPOINT coverage_save');await physical(c,9);await c.query('ROLLBACK TO SAVEPOINT coverage_save');await physical(c,8);},{isolation:'READ COMMITTED'});
 assert.deepEqual(await position(db),{physical:'8',costed:'7',value:'700',missing:'1'},'A missing explicit flush is covered at commit');
 // Each side preserves the other's latest committed value, rather than
 // overwriting it with a value read before waiting for a projection row.
 for(const direction of ['cost','physical']){
  const ready=Promise.withResolvers(),release=Promise.withResolvers();
  const pending=db.transaction(async c=>{await defer(c);await (direction==='cost'?cost(c,8):physical(c,10));ready.resolve();await release.promise;},{isolation:'READ COMMITTED'});
  try{await ready.promise;await db.transaction(c=>direction==='cost'?physical(c,9):cost(c,10),{isolation:'READ COMMITTED'});}finally{release.resolve();await pending;}
  assert.deepEqual(await position(db),direction==='cost'?{physical:'9',costed:'8',value:'800',missing:'1'}:{physical:'10',costed:'10',value:'1000',missing:'0'});
 }
 await db.transaction(async c=>{await defer(c);await c.query('SET CONSTRAINTS ALL IMMEDIATE');await physical(c,11);assert.equal((await position(c)).physical,'11');await cost(c,11);assert.equal((await position(c)).missing,'0');},{isolation:'READ COMMITTED'});
 assert.equal((await db.query('SELECT count(*)::int n FROM stockchief_runtime.import_coverage_transactions')).rows[0].n,0);
 await db.transaction(async c=>{await defer(c);await c.query('DELETE FROM accounting_inventory_cost_balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',params);},{isolation:'READ COMMITTED'});
 assert.deepEqual(await position(db),{physical:'11',costed:'0',value:'0',missing:'11'});
 await db.transaction(async c=>{await defer(c);await c.query('DELETE FROM balances WHERE workspace_id=$1 AND sku_id=$2 AND location_id=$3',params);},{isolation:'READ COMMITTED'});
 assert.deepEqual(await position(db),{physical:'0',costed:'0',value:'0',missing:'0'});
});
