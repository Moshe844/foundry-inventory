'use strict';
const assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

// Real immutable history on both sides of a governed tenant deletion.
async function seed(db,targetWorkspaceId,otherWorkspaceId){
 const rows=[],sources=[],cutover=require('../../src/onboarding/postgres-cutover');
 for(const workspaceId of [targetWorkspaceId,otherWorkspaceId]){
  for(const table of ['catalogue_change_history','security_event_history']){
   const id=randomUUID();
   if(table==='catalogue_change_history')await db.query("INSERT INTO catalogue_change_history(id,workspace_id,item_id,action,before_state,after_state) VALUES($1,$2,'audit-fixture-item','fixture.change','{}','{\"price\":100}')",[id,workspaceId]);
   else await db.query("INSERT INTO security_event_history(id,workspace_id,action,before_state,after_state) VALUES($1,$2,'fixture.access','{}','{\"enabled\":true}')",[id,workspaceId]);
   const before=(await db.query('SELECT * FROM '+table+' WHERE id=$1',[id])).rows[0];
   await assert.rejects(db.query('DELETE FROM '+table+' WHERE id=$1',[id]),/cannot be rewritten/);
   await assert.rejects(db.query("UPDATE "+table+" SET action='rewritten' WHERE id=$1",[id]),/cannot be rewritten/);
   rows.push({table,id,workspaceId,before});
  }
  const actor=(await db.query('SELECT id FROM users WHERE workspace_id=$1 ORDER BY id LIMIT 1',[workspaceId])).rows[0],ctx={workspaceId,actorId:actor.id};
  const manifest={counts:{...Object.fromEntries(Object.keys(cutover.TYPES).map(k=>[k,0])),product:1}};
  const pkg=await cutover.create(db,ctx,{sourceNamespace:'purge-fixture',sourceLabel:'Protected ERP source',snapshotHash:'a'.repeat(64),mode:'SNAPSHOT_DELTA',sourceCursor:'v1',manifest});
  await cutover.stage(db,ctx,pkg.id,{batchKey:'first',records:[{type:'product',key:'source-product',payload:{name:'Protected source product'}}]});
  await cutover.freeze(db,ctx,pkg.id,{sourceStopped:true,finalCursor:'v1',manifest});
  const source=(await db.query('SELECT * FROM migration_records WHERE package_id=$1',[pkg.id])).rows[0];
  await assert.rejects(db.query('DELETE FROM migration_records WHERE id=$1',[source.id]),/source evidence is sealed/);
  sources.push({workspaceId,packageId:pkg.id,before:source});
 }
 return async()=>{
  for(const row of rows){
   const after=(await db.query('SELECT * FROM '+row.table+' WHERE id=$1',[row.id])).rows;
   if(row.workspaceId===targetWorkspaceId)assert.equal(after.length,0,'Approved workspace cascade removes its '+row.table);
   else{
    assert.deepEqual(after,[row.before],'Another inventory keeps its complete '+row.table);
    await assert.rejects(db.query('DELETE FROM '+row.table+' WHERE id=$1',[row.id]),/cannot be rewritten/);
   }
  }
  for(const source of sources){
   const after=(await db.query('SELECT * FROM migration_records WHERE id=$1',[source.before.id])).rows;
   if(source.workspaceId===targetWorkspaceId)assert.equal(after.length,0,'Approved package cascade removes sealed source records');
   else{
    assert.deepEqual(after,[source.before],'Another inventory keeps its exact sealed ERP evidence');
    await assert.rejects(db.query('DELETE FROM migration_records WHERE id=$1',[source.before.id]),/source evidence is sealed/);
   }
  }
 };
}
module.exports={seed};
