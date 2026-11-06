'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('new-product execution indexes exclude existing stock and retain variant prices and source order',{timeout:180000},async t=>{
 const {db,ctx,item,location}=await require('../helpers/postgres-shipping-fixture').fixture(t),imports=require('../../src/imports/postgres-service');
 const existing=(await db.query('SELECT code FROM skus WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.skuIds[0]])).rows[0].code;
 await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Second bin',kind:'bin',parentLocationId:location.id});
 const csv=['Product,SKU,Variant Flavor,Location,Quantity,Unit cost,Selling price',`Parcel item,${existing},,Dispatch,2,4,8`,'Coffee,SCOPE-COFFEE-MILD,Mild,Dispatch,2,3,','Coffee,SCOPE-COFFEE-STRONG,Strong,Dispatch,1,3,9','Coffee,SCOPE-COFFEE-MILD,Mild,Second bin,1,3,9'].join('\n');
 const plan=await imports.analyse(db,ctx,{text:csv,filename:'catalogue-index-scope.csv',allowModel:false,importMode:'add',defaultLocationId:location.id});
 assert.equal(plan.recordsInvalid,0,JSON.stringify((await db.query("SELECT row_number,problems FROM import_rows WHERE import_id=$1 AND status='INVALID'",[plan.id])).rows));assert.equal(plan.recordsValid,4);
 const indexed=(await db.query("SELECT c.relname,pg_get_expr(i.indpred,i.indrelid) predicate FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname=ANY($1::text[]) ORDER BY c.relname",[['import_execution_identity_product','import_execution_identity_product_source']])).rows;
 assert.equal(indexed.length,2);assert(indexed.every(i=>i.predicate==='(existing_sku_id IS NULL)'));
 const identities=(await db.query('SELECT count(*)::int total,count(*) FILTER(WHERE existing_sku_id IS NULL)::int catalogue FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2',[ctx.workspaceId,plan.id])).rows[0];assert.deepEqual(identities,{total:4,catalogue:3});
 await imports.approve(db,ctx,plan.id,plan.integrityHash);const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.itemsCreated,1);assert.equal(result.skusCreated,2);assert.equal(result.units,6);
 const coffee=(await db.query("SELECT i.name,s.code,sum(b.on_hand) on_hand,p.amount_minor FROM skus s JOIN items i ON i.id=s.item_id JOIN balances b ON b.sku_id=s.id JOIN sku_prices p ON p.sku_id=s.id WHERE s.workspace_id=$1 AND s.code LIKE 'SCOPE-COFFEE-%' GROUP BY i.name,s.code,p.amount_minor ORDER BY s.code",[ctx.workspaceId])).rows;
 assert.deepEqual(coffee.map(r=>[r.name,r.code,Number(r.on_hand),Number(r.amount_minor)]),[['Coffee','SCOPE-COFFEE-MILD',3,900],['Coffee','SCOPE-COFFEE-STRONG',1,900]]);
 assert((await imports.execute(db,ctx,plan.id)).duplicate);
});
