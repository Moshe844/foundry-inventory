'use strict';process.env.NODE_ENV='test';const test=require('node:test');
test('Home stock counts retain exact archived, empty and fractional-unit semantics using shared SKU totals',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,catalog=require('../../src/domain/postgres-catalog-service');
 const assert=require('node:assert/strict'),index=(await db.query("SELECT i.indisprimary,i.indisunique,i.indnkeyatts,i.indnatts,c.relpersistence FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid WHERE i.indrelid='stockchief_runtime.sku_stock_totals'::regclass AND i.indisprimary")).rows[0];assert.deepEqual(index,{indisprimary:true,indisunique:true,indnkeyatts:2,indnatts:3,relpersistence:'p'},'Covering the read must preserve the logged table and the same unique key');
 await catalog.createItem(db,ctx,{name:'Empty Home test item',baseCode:'HOME-EMPTY',trackingMode:'quantity'});
 const measured=await catalog.createItem(db,ctx,{name:'Measured Home test item',baseCode:'HOME-KG',trackingMode:'quantity'});await require('../../src/domain/stock-quantity').save(db,ctx,measured.itemId,{unitLabel:'kg',quantityPrecision:3,quantityIncrement:'0.001'});
 await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:measured.skuIds[0],locationId:f.location.id,quantity:'3.75',idempotencyKey:'home-brief-kg'});
 t.diagnostic(JSON.stringify(await require('../helpers/home-brief-stock-checks').check(db,ctx)));
 await db.query('UPDATE skus SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,f.item.skuIds[0]]);t.diagnostic(JSON.stringify(await require('../helpers/home-brief-stock-checks').check(db,ctx)));
});
