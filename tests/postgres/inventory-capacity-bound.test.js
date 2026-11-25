'use strict';
// The plan-limit check keeps an upper bound per account so growth within the plan is
// admitted without recounting the whole catalogue (which made big imports slow down batch
// after batch). The bound may be loose but must never fall below the real count, and the
// limit must still hold exactly at the boundary, including under concurrent growth.
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');

test('catalogue growth within the plan reads no existing SKUs, and the limit stays exact',{timeout:240000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString,{max:12});
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const at=new Date().toISOString();
 await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('a','bound@example.test','Bound','fixture',$1)",[at]);
 for(const w of ['w','w2']){
  await db.query("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES($1,$1,'a',$2)",[w,at]);
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,'a','Owner','owner',$3)",['u'+w,w,at]);
  await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES($1,$2,$1,'quantity',1,$3,$3)",['i'+w,w,at]);
 }
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES('sub','a','starter','planver_starter_1','ACTIVE')");
 const limit=n=>db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('cap','a','active_skus',$1,'Test contract') ON CONFLICT(id) DO UPDATE SET limit_units=EXCLUDED.limit_units",[n]);
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('products','a','products',NULL,'Test contract')");
 await limit(2000);
 const exact=async()=>Number((await db.query(`SELECT count(*) n FROM skus s JOIN items i ON i.id=s.item_id JOIN workspaces w ON w.id=s.workspace_id
  WHERE w.owner_account_id='a' AND w.deletion_requested_at IS NULL AND s.is_active=1 AND i.is_active=1`)).rows[0].n);
 // No row means no bound: the next growth recounts, which is always safe.
 const bound=async()=>{const row=(await db.query("SELECT upper_bound FROM stockchief_runtime.inventory_capacity_bounds WHERE account_id='a' AND meter='active_skus'")).rows[0];return row?Number(row.upper_bound):Infinity;};
 const safe=async label=>{const b=await bound(),e=await exact();assert(b>=e,`${label}: bound ${b} fell below the real count ${e}`);return {bound:b,exact:e};};
 let serial=0;
 // Adds n SKUs in one statement (under the given product) and reports how many SKU rows it read.
 const grow=(n,w='w',item='i'+w)=>db.transaction(async c=>{
  const prefix='k'+(++serial)+'-';
  await c.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) SELECT $1||g,$2,$3,$1||g,1,$4 FROM generate_series(1,$5::int) g`,[prefix,w,item,at,n]);
  const read=(await c.query("SELECT coalesce(seq_tup_read,0)+coalesce(idx_tup_fetch,0) AS n FROM pg_stat_xact_user_tables WHERE relid='skus'::regclass")).rows[0];
  return Number(read?.n||0);
 },{retrySafe:true});
 const refused=promise=>assert.rejects(promise,/plan limit/);
 // The same 500-SKU batch under a fresh product, so only catalogue-wide work can differ.
 const batch=async()=>{const item='fresh-'+(++serial);
  await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES($1,'w',$1,'quantity',1,$2,$2)",[item,at]);
  return grow(500,'w',item);};

 await grow(600);await safe('first growth counts once');
 await grow(500,'w2');assert.equal(await bound(),1100);await safe('growth within the plan');
 await limit(50000);
 const small=await batch();await grow(20000,'w2');const filler='k'+serial+'-',large=await batch();
 assert(large-small<2000,`a 500-SKU batch read ${small} SKU rows beside 1,600 SKUs but ${large} beside 22,100`);
 await safe('growth within a larger plan');
 await db.query("DELETE FROM skus WHERE item_id LIKE 'fresh-%' OR id LIKE $1",[filler+'%']);
 await db.query("DELETE FROM items WHERE id LIKE 'fresh-%'");await limit(2000);
 assert.equal(await exact(),1100);

 await db.query("UPDATE skus SET is_active=0 WHERE id LIKE 'k1-%' AND id<'k1-4'");
 const archived=await safe('archiving leaves the bound high');assert(archived.bound>archived.exact);

 // Fill to the limit exactly: the loose bound forces one exact recount, which admits it.
 await grow(2000-await exact());assert.equal(await exact(),2000);await safe('filled to the limit');
 await refused(grow(1));assert.equal(await exact(),2000);

 // Deactivating a product drops its variants; reactivating them is growth and is checked.
 await db.query("UPDATE items SET is_active=0 WHERE id='iw2'");await safe('product deactivated');
 await grow(10);
 await refused(db.query("UPDATE items SET is_active=1 WHERE id='iw2'"));
 await db.query("UPDATE skus SET is_active=0 WHERE id IN (SELECT id FROM skus WHERE workspace_id='w' AND is_active=1 ORDER BY id LIMIT 10)");
 await db.query("UPDATE items SET is_active=1 WHERE id='iw2'");await safe('product reactivated');

 // A deleted inventory drops out; restoring it brings records back that the bound never saw.
 await db.query("UPDATE workspaces SET deletion_requested_at=$1 WHERE id='w2'",[at]);
 await grow(400);await safe('growth while another inventory is deleted');
 await assert.rejects(db.query("UPDATE workspaces SET deletion_requested_at=NULL WHERE id='w2'"),/Restoring or transferring/);
 await limit(5000);await db.query("UPDATE workspaces SET deletion_requested_at=NULL WHERE id='w2'");
 assert.equal(await bound(),Infinity,'restoring discards the bound');
 await grow(1);await safe('first growth after a restore recounts');

 // Growth while the plan has no limit, then a limit again, must not admit on a stale bound.
 await limit(null);await grow(3000);assert.equal(await bound(),Infinity);
 await limit(3000);await refused(grow(1));await safe('limit restored below the catalogue');

 // A rolled-back batch leaves the bound where it was.
 await limit(20000);await grow(1);const kept=await bound();
 await assert.rejects(db.transaction(async c=>{await c.query(`INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) SELECT 'rb-'||g,'w','iw','rb-'||g,1,$1 FROM generate_series(1,50) g`,[at]);throw new Error('stop');}),/stop/);
 assert.equal(await bound(),kept);await safe('after a rollback');

 // Concurrent single-SKU growth cannot overshoot the boundary.
 const room=5;await limit(await exact()+room);
 const results=await Promise.allSettled(Array.from({length:12},(_,n)=>grow(1,n%2?'w':'w2')));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,room);
 assert(results.filter(r=>r.status==='rejected').every(r=>/plan limit/.test(r.reason.message)));
 assert.equal(await exact(),Number((await db.query("SELECT limit_units FROM commercial_entitlement_overrides WHERE id='cap'")).rows[0].limit_units));
 await safe('after concurrent growth');

 // Products use the same bound for their own limit.
 await db.query("UPDATE commercial_entitlement_overrides SET limit_units=$1 WHERE id='products'",[Number((await db.query("SELECT count(*) n FROM items")).rows[0].n)+3]);
 await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) SELECT 'p'||g,'w','p'||g,'quantity',1,$1,$1 FROM generate_series(1,3) g",[at]);
 await assert.rejects(db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES('p4','w','p4','quantity',1,$1,$1)",[at]),/Products exceed/);
 const products=(await db.query("SELECT upper_bound FROM stockchief_runtime.inventory_capacity_bounds WHERE account_id='a' AND meter='products'")).rows[0];
 assert(Number(products.upper_bound)>=Number((await db.query("SELECT count(*) n FROM items WHERE is_active=1")).rows[0].n));
});
