'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');
const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');
const entitlements=require('../../src/commercial/entitlements');
const imports=require('../../src/imports/postgres-service');
test('account-wide inventory capacity, plan versions, overrides and concurrent admission',{timeout:180000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString,{max:5});
 t.after(async()=>{await db.close();cluster.stop();});await migratePostgres(db);
 const at=new Date().toISOString();
 await db.query("INSERT INTO accounts(id,email,name,password_hash,created_at) VALUES('a','capacity@example.test','Capacity','fixture',$1)",[at]);
 for(const w of ['w','w2']){
  await db.query("INSERT INTO workspaces(id,name,owner_account_id,created_at) VALUES($1,$1,'a',$2)",[w,at]);
  await db.query("INSERT INTO users(id,workspace_id,account_id,name,role,created_at) VALUES($1,$2,'a','Owner','owner',$3)",['u'+w,w,at]);
  await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES($1,$2,$1,'quantity',1,$3,$3)",['i'+w,w,at]);
 }
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES('sub','a','starter','planver_starter_1','ACTIVE')");
 for(const [plan,skus,rows] of [['starter',500,1000],['growth',25000,100000],['pro',250000,1000000],['enterprise',2000000,5000000]]){
  await db.query('UPDATE account_subscriptions SET plan_id=$1,plan_version_id=$2 WHERE id=\'sub\'',[plan,`planver_${plan}_1`]);
  assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).hardLimit,skus);
  assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'import_rows')).hardLimit,rows);
 }
 await db.query("UPDATE account_subscriptions SET plan_id='starter',plan_version_id='planver_starter_1' WHERE id='sub'");
 // Small explicit contract limit exercises exactly the same trigger as every tier.
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('cap','a','active_skus',3,'Test contract')");
 const insert=(id,w='w')=>db.transaction(c=>c.query("INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) VALUES($1,$2,$3,$1,1,$4)",[id,w,'i'+w,at]),{retrySafe:true});
 await insert('s1');await insert('s2','w2');
 const results=await Promise.allSettled([insert('s3'),insert('s4','w2')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/plan limit/);
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).used,3);
 await db.query("UPDATE items SET is_active=0 WHERE id='iw2'");
 const remaining=Number((await db.query("SELECT count(*) n FROM skus WHERE workspace_id='w'")).rows[0].n);
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).used,remaining);
 await insert('replacement');
 await assert.rejects(db.query("UPDATE items SET is_active=1 WHERE id='iw2'"),/plan limit/);
 await db.query("DELETE FROM skus WHERE id='replacement'");
 await db.query("UPDATE items SET is_active=1 WHERE id='iw2'");
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).used,3);
 await db.query("DELETE FROM items WHERE id='iw2'");
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).used,remaining);
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'products')).used,1);
 await db.query("UPDATE workspaces SET deletion_requested_at=$1 WHERE id='w'",[at]);
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w2'},'active_skus')).used,0);
 await assert.rejects(insert('while-deleting'),/Restore this inventory/);
 await db.query("UPDATE commercial_entitlement_overrides SET limit_units=0 WHERE id='cap'");
 await assert.rejects(db.query("UPDATE workspaces SET deletion_requested_at=NULL WHERE id='w'"),/Restoring or transferring/);
 await db.query("UPDATE commercial_entitlement_overrides SET limit_units=3 WHERE id='cap'");
 await db.query("UPDATE workspaces SET deletion_requested_at=NULL WHERE id='w'");
 await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,capability,enabled,reason) VALUES('imports','a','imports.spreadsheet',1,'Test old plan version with explicit import grant')");
 await assert.rejects(imports.analyse(db,{workspaceId:'w',actorId:'uw'},{text:'SKU,Name,Quantity\n'+Array.from({length:1001},(_,i)=>`K${i},Product ${i},1`).join('\n'),allowModel:false}),/1,000 rows per import/);
 assert.equal(Number((await db.query('SELECT count(*) n FROM import_plans')).rows[0].n),0);
 const plan=await imports.analyse(db,{workspaceId:'w',actorId:'uw'},{text:'SKU,Name,Quantity,Location\nV1,Family,1,Room\nV2,Family,1,Room\nV3,Family,1,Room',allowModel:false});
 await assert.rejects(imports.approve(db,{workspaceId:'w',actorId:'uw'},plan.id,plan.integrityHash),/Active SKUs.*plan limit/);
 assert.equal((await imports.get(db,'w',plan.id)).approvalStatus,'AWAITING_APPROVAL');
 await db.query("UPDATE commercial_entitlement_overrides SET limit_units=1 WHERE id='cap'");
 await assert.rejects(insert('after-downgrade'),/plan limit/);
 // Existing data remains readable and archive/deletion can reduce an over-limit account.
 await db.query("UPDATE skus SET is_active=0 WHERE workspace_id='w'");
 assert.equal((await entitlements.meterState(db,{accountId:'a',workspaceId:'w'},'active_skus')).used,0);
});
