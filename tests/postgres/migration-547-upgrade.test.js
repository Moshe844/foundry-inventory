'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
// Publishing applies 546-548 to a production database that is at 545, where import
// rows store quantity as a whole number. 547 must restore a rounded decimal row
// from the row's own parsed quantity and leave every other row as it was.
test('upgrading a 545 database restores rounded decimal import rows and keeps the rest',{timeout:240000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{ctx}=f,db=require('../../src/db/postgres').openPostgres(f.cluster.connectionString,{max:3});
 t.after(()=>db.close());
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,status,source) VALUES('migration-547',$1,'enterprise','COMP','ISOLATED_TEST') ON CONFLICT(account_id) DO NOTHING",[f.owner.accountId]);
 const catalog=require('../../src/domain/postgres-catalog-service');
 await db.transaction(c=>catalog.createImportedItemsInTransaction(c,ctx,[{name:'Cable by the metre',trackingMode:'quantity',variants:[{code:'UPGRADE-METRE',options:[{name:'Size',value:'1'}]}]},{name:'Boxed fitting',trackingMode:'quantity',variants:[{code:'UPGRADE-BOX',options:[{name:'Size',value:'1'}]}]}]),{isolation:'READ COMMITTED'});
 const metre=(await db.query("SELECT item_id FROM skus WHERE workspace_id=$1 AND code='UPGRADE-METRE'",[ctx.workspaceId])).rows[0].item_id;
 await db.transaction(c=>require('../../src/domain/stock-quantity').save(c,ctx,metre,{unitLabel:'m',quantityPrecision:3,quantityIncrement:'0.001'}));
 const location=(await db.query('SELECT name FROM locations WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.location.id])).rows[0].name;
 const imports=require('../../src/imports/postgres-service');
 const csv=['SKU,Location,Quantity,Unit cost','UPGRADE-METRE,'+location+',2.25,4.00','UPGRADE-BOX,'+location+',3,1.50'].join('\n');
 const plan=await imports.analyse(db,ctx,{buffer:Buffer.from(csv),filename:'upgrade.csv',importMode:'add',allowModel:false});
 await imports.approve(db,ctx,plan.id,plan.integrityHash);await imports.execute(db,ctx,plan.id);
 const rows=async()=>Object.fromEntries((await db.query("SELECT r.parsed::jsonb->>'sku' AS sku,s.code,r.quantity::text AS quantity FROM import_rows r LEFT JOIN skus s ON s.id=r.sku_id WHERE r.import_id=$1",[plan.id])).rows.map(r=>[r.code,r.quantity]));
 assert.deepEqual(await rows(),{'UPGRADE-METRE':'2.25','UPGRADE-BOX':'3'});
 // Production today (545): whole-number column, 547 not yet applied.
 await db.query("ALTER TABLE import_rows ALTER COLUMN quantity TYPE bigint USING round(quantity)::bigint");
 await db.query("DELETE FROM stockchief_postgres_migrations WHERE name IN ('547-import-row-decimal-quantity.sql')");
 assert.deepEqual(await rows(),{'UPGRADE-METRE':'2','UPGRADE-BOX':'3'});
 const applied=await require('../../src/db/migrate-postgres').migratePostgres(db);
 assert.deepEqual(applied,['547-import-row-decimal-quantity.sql']);
 assert.deepEqual(await rows(),{'UPGRADE-METRE':'2.25','UPGRADE-BOX':'3'});
 assert.equal((await db.query("SELECT data_type FROM information_schema.columns WHERE table_name='import_rows' AND column_name='quantity'")).rows[0].data_type,'numeric');
 // Stock and books were never touched by the migration.
 const stock=(await db.query("SELECT s.code,sum(b.on_hand)::text AS on_hand FROM balances b JOIN skus s ON s.id=b.sku_id WHERE b.workspace_id=$1 AND s.code LIKE 'UPGRADE-%' GROUP BY s.code ORDER BY s.code",[ctx.workspaceId])).rows;
 assert.deepEqual(stock.map(r=>[r.code,Number(r.on_hand)]),[['UPGRADE-BOX',3],['UPGRADE-METRE',2.25]]);
});
