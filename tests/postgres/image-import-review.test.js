'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('image reading has a saved review, reversible code corrections and an approval guard',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);t.after(async()=>{await db.close();await cluster.stop();});
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Image review',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Inspection room',kind:'warehouse'});
 const imports=require('../../src/imports/postgres-service'),progress=require('../../src/imports/postgres-progress'),source=require('../helpers/scanned-table-pdf').scannedTableImage();
 const plan=await imports.analyse(db,ctx,{buffer:source,filename:'count.png',allowModel:false});assert.equal(plan.sourceKind,'image');assert.equal(plan.recordsDetected,2);
 assert.equal((await progress.get(db,ctx.workspaceId,plan.id)).state,'NEEDS_INPUT');
 await assert.rejects(imports.approve(db,ctx,plan.id,plan.integrityHash),/Review the image/);
 const rows=await imports.rowsFor(db,ctx.workspaceId,plan.id,{limit:10}),r=rows[0];
 await imports.revise(db,ctx,plan.id,{expectedHash:plan.integrityHash,codeOverrides:{[r.rowNumber]:'VERIFIED-LAMP-10'},confirmImageReading:true});
 const reviewed=await imports.get(db,ctx.workspaceId,plan.id);assert.equal(reviewed.transformations.imageReadingConfirmed,true);assert.equal(reviewed.transformations.imageReadingConfirmedBy,ctx.actorId);
 const corrected=(await imports.rowsFor(db,ctx.workspaceId,plan.id,{limit:10}))[0];assert.equal(corrected.parsed.code,'VERIFIED-LAMP-10');assert.deepEqual(corrected.raw,r.raw,'original OCR source evidence is preserved');
 assert.equal((await imports.approve(db,ctx,plan.id,reviewed.integrityHash)).approvalStatus,'APPROVED');
 assert.equal((await db.query('SELECT count(*)::int n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'reading, correcting and approving a preview never import stock');
});
