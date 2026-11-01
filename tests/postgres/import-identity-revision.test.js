'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('preview revisions retain unchanged identities and replace changed, invalid and recovered rows',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,imports=require('../../src/imports/postgres-service');
 let plan=await imports.analyse(db,ctx,{text:'Name,SKU,Qty,Cost\nRevision item,REV-A,3,2\nStable item,REV-B,4,2',allowModel:false,defaultLocationId:f.location.id});
 const identities=()=>db.query('SELECT row_number,product_key,variant_key,xmin::text AS version FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_number',[ctx.workspaceId,plan.id]);
 const before=(await identities()).rows;assert.equal(before.length,2);
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,importMode:'add'});assert.deepEqual((await identities()).rows,before,'stock intent alone must not rewrite catalogue identity indexes');
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,quantityOverrides:{2:'99999999999'}});assert.equal(plan.recordsInvalid,1);assert.deepEqual((await identities()).rows,[before[1]],'invalid rows must lose their executable identity');
 const created=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Revision item',baseCode:'REV-A',trackingMode:'quantity'});
 plan=await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,quantityOverrides:{2:'5'}});assert.equal(plan.recordsInvalid,0);const repaired=(await identities()).rows;assert.equal(repaired.length,2);assert.deepEqual(repaired[1],before[1]);assert.notEqual(repaired[0].product_key,before[0].product_key);
 await imports.approve(db,ctx,plan.id,plan.integrityHash);const result=await imports.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.units,9);
 assert.equal((await db.query("SELECT count(*)::int n FROM skus WHERE workspace_id=$1 AND code='REV-A'",[ctx.workspaceId])).rows[0].n,1);
 assert.equal(Number((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1 AND sku_id=$2',[ctx.workspaceId,created.skuIds[0]])).rows[0].n),5);assert((await imports.execute(db,ctx,plan.id)).duplicate);
});
