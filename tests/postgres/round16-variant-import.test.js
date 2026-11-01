'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('variant spreadsheet preserves free option names, barcodes, category, supplier cost and separate parent code',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service');
 const text='Product,SKU,Option1 Name,Option1 Value,Option2 Name,Option2 Value,Barcode,Cost,Price,Supplier,Category\nLotion,LOT-ROSE-100,Scent,Rose,Size,100ml,0012345678901,4,10,Cosmetic Supply,Cosmetics\nLotion,LOT-PLAIN-500,Scent,Unscented,Size,500ml,0012345678902,8,20,Cosmetic Supply,Cosmetics';
 const plan=await imports.analyse(db,ctx,{text,allowModel:false});assert.equal(plan.recordsInvalid,0);await imports.approve(db,ctx,plan.id,plan.integrityHash);assert((await imports.execute(db,ctx,plan.id)).verified);
 const product=(await db.query("SELECT i.* FROM items i JOIN skus s ON s.workspace_id=i.workspace_id AND s.item_id=i.id WHERE i.workspace_id=$1 AND s.code='LOT-ROSE-100'",[ctx.workspaceId])).rows[0];assert(product.base_code);assert.notEqual(product.base_code,'LOT-ROSE-100');assert.notEqual(product.base_code,'LOT-PLAIN-500');
 const detail=await require('../../src/domain/postgres-catalog-service').getItem(db,ctx.workspaceId,product.id);assert.deepEqual(detail.options.map(o=>o.name),['Scent','Size']);assert.equal(detail.skus.find(s=>s.code==='LOT-ROSE-100').barcode,'0012345678901');
 assert.equal((await require('../../src/domain/postgres-catalog-service').listItems(db,ctx.workspaceId,{category:'Cosmetics',optionFilters:{Scent:'Rose',Size:'100ml'}})).totalCount,1);
 const costs=(await db.query('SELECT s.code,si.last_unit_cost FROM supplier_items si JOIN skus s ON s.id=si.sku_id AND s.workspace_id=si.workspace_id WHERE si.workspace_id=$1 AND s.item_id=$2 ORDER BY s.code',[ctx.workspaceId,product.id])).rows;assert.deepEqual(costs.map(r=>Number(r.last_unit_cost)),[8,4]);
 assert.equal(Number((await db.query('SELECT count(*) n FROM movements WHERE workspace_id=$1 AND item_id=$2',[ctx.workspaceId,product.id])).rows[0].n),0,'Catalogue-only file must not create stock');
});
