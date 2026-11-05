'use strict';
// Execution identities are a rebuildable preparation index, not source rows,
// catalogue bindings, stock history, verification receipts or idempotency keys.
async function releaseCompleted(database,ctx,planId,{batchSize=5000}={}){
 if(!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>10000)throw new TypeError('Import cache cleanup needs a bounded batch.');
 return database.transaction(async client=>{
  const plan=(await client.query(`SELECT p.id FROM import_plans p WHERE p.workspace_id=$1 AND p.id=$2 AND p.status='SUCCEEDED'
   AND EXISTS(SELECT 1 FROM import_executions e JOIN import_verifications v ON v.workspace_id=e.workspace_id AND v.execution_id=e.id AND v.import_id=e.import_id
    WHERE e.workspace_id=p.workspace_id AND e.import_id=p.id AND e.status='SUCCEEDED' AND e.committed_at IS NOT NULL AND v.verified=1)
   AND NOT EXISTS(SELECT 1 FROM import_executions e WHERE e.workspace_id=p.workspace_id AND e.import_id=p.id AND e.status='EXECUTING')
   FOR UPDATE OF p SKIP LOCKED`,[ctx.workspaceId,planId])).rows[0];
  if(!plan)return {removed:0,done:false,eligible:false};
  const removed=Number((await client.query(`WITH removed AS (
   DELETE FROM import_execution_identities e WHERE e.workspace_id=$1 AND e.import_id=$2 AND e.row_id IN (
    SELECT row_id FROM import_execution_identities WHERE workspace_id=$1 AND import_id=$2 ORDER BY row_number,row_id LIMIT $3)
   RETURNING e.row_id) SELECT count(*)::int n FROM removed`,[ctx.workspaceId,planId,batchSize])).rows[0].n);
  const done=removed<batchSize;
  if(done)await client.query("UPDATE import_plans SET execution_identity_hash=NULL WHERE workspace_id=$1 AND id=$2 AND status='SUCCEEDED'",[ctx.workspaceId,planId]);
  return {removed,done,eligible:true};
 },{isolation:'READ COMMITTED',retrySafe:true,statementTimeoutMs:10000,lockTimeoutMs:1000});
}
async function finish(database,ctx,planId){
 let removed=0;for(let n=0;n<=1000;n++){
  const result=await releaseCompleted(database,ctx,planId);removed+=result.removed;
  if(result.done||!result.eligible)return {state:result.done?'RELEASED':'DEFERRED',removed};
 }
 return {state:'DEFERRED',removed};
}
module.exports={releaseCompleted,finish};
