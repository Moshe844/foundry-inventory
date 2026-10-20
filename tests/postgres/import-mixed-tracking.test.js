'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('mixed tracked stock uses row evidence without losing source requirements',{timeout:180000},async t=>{
  const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
  t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
  const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Mixed source',email:randomUUID()+'@example.test',password:randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},imports=require('../../src/imports/postgres-service');
  const preview=text=>imports.analyse(db,ctx,{text,filename:'Unfamiliar source.csv',allowModel:false});
  const header='SKU,Product,Quantity,Location,Serial,Serial Tracked,Lot,Lot Tracked\n';
  const p=await preview(header+'DEV-9,Reader,1,Cabinet,ID-9,Yes,,No\nCHEM-7,Solvent,5,Cabinet,,No,LOT-7,Yes\nSP-8,Bracket,0,Cabinet,,No,,No');
  assert.equal(p.recordsInvalid,0);const rows=await imports.rowsFor(db,ctx.workspaceId,p.id);
  assert.deepEqual(rows.map(r=>[r.parsed.trackingMode,r.parsed.serial,r.parsed.lotCode]),[['serial','ID-9',null],['lot',null,'LOT-7'],['quantity',null,null]]);
  assert.equal((await require('../../src/imports/tracking-review').read(db,ctx.workspaceId,p)).state,'complete');
  const missing=await preview(header+'DEV-1,Missing serial,1,Cabinet,,Yes,,No\nCHEM-2,Missing lot,3,Cabinet,,No,,Yes\nDUAL-3,Conflicting identifiers,1,Cabinet,ID-3,Yes,LOT-3,Yes');
  assert.equal(missing.recordsInvalid,3);const errors=(await imports.rowsFor(db,ctx.workspaceId,missing.id)).map(r=>r.problems.map(p=>p.code));
  assert(errors[0].includes('missing_serial'));assert(errors[1].includes('missing_lot'));assert(errors[2].includes('invalid_tracking_flag'));
  const ambiguous=await preview('SKU,Product,Quantity,Location,Serial,Lot\nUN-1,Unidentified,2,Cabinet,,');
  assert.equal(ambiguous.recordsInvalid,1);assert((await imports.rowsFor(db,ctx.workspaceId,ambiguous.id))[0].problems.some(p=>p.code==='missing_tracking_identifier'));
  const lone=await preview('SKU,Product,Quantity,Location,Serial\nSN-1,Missing,1,Cabinet,\nSN-2,Present,1,Cabinet,VALUE-2');
  assert.equal(lone.recordsInvalid,1);assert((await imports.rowsFor(db,ctx.workspaceId,lone.id))[0].problems.some(p=>p.code==='missing_serial'));
  assert.equal((await db.query('SELECT count(*)::int n FROM skus WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  await assert.rejects(imports.execute(db,ctx,p.id),/Approve/);
});
