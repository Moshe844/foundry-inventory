'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('source history preserves skipped-row protection, nullable row filters and identical files in separate inventories',{timeout:180000},async t=>{
 const {db,ctx}=await require('../helpers/postgres-shipping-fixture').fixture(t),imports=require('../../src/imports/postgres-service'),history=require('../../src/imports/postgres-source-history');
 const other=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Other source owner',businessName:'Independent source history',email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),otherCtx={workspaceId:other.workspaceId,actorId:other.userId};
 const text='Product,SKU,Cost,Price\nSource one,HISTORY-1,2,5\nSource two,HISTORY-2,3,6\nSource three,HISTORY-3,4,7',plans=[];
 for(const scope of [ctx,otherCtx]){const plan=await imports.analyse(db,scope,{text,allowModel:false});assert.equal(plan.recordsValid,3);await imports.approve(db,scope,plan.id,plan.integrityHash);assert((await imports.execute(db,scope,plan.id)).verified);plans.push(plan);}
 assert.equal(plans[0].sourceHash,plans[1].sourceHash);
 for(const [i,scope]of [ctx,otherCtx].entries()){
  const expected=(await db.query("SELECT row_number,raw FROM import_rows WHERE workspace_id=$1 AND import_id=$2 AND status='IMPORTED' ORDER BY row_number",[scope.workspaceId,plans[i].id])).rows,sort=rows=>rows.sort((a,b)=>Number(a.row_number)-Number(b.row_number));
  await db.transaction(async c=>{await c.query("SET LOCAL plan_cache_mode='force_generic_plan'");assert.deepEqual(sort(await history.read(c,scope.workspaceId,plans[i].sourceHash)),expected);assert.deepEqual(await history.read(c,scope.workspaceId,plans[i].sourceHash,[expected[1].row_number]),[expected[1]]);assert.deepEqual(await history.read(c,scope.workspaceId,plans[i].sourceHash,[]),[]);assert.deepEqual(await history.read(c,scope.workspaceId,'0'.repeat(64)),[]);},{readOnly:true,isolation:'REPEATABLE READ'});
 }
 const repeated=await imports.analyse(db,ctx,{text,allowModel:false}),rows=await imports.rowsFor(db,ctx.workspaceId,repeated.id);assert.equal(repeated.recordsValid,0);assert.equal(rows.length,3);assert(rows.every(r=>r.status==='SKIPPED'&&r.problems.some(p=>p.code==='already_imported')));
 assert.equal((await history.read(db,ctx.workspaceId,plans[0].sourceHash)).length,3,'Skipped rows in a second matching plan are not imported history');
 assert.deepEqual(await history.read({query:()=>{throw Error('Unnecessary history query');}},ctx.workspaceId,null),[]);
});
