'use strict';

async function readReceipts(db,scope,sourceHash,{lock=true}={}){
  if(lock)await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    ['document-source-usage:'+scope.workspaceId+':'+sourceHash]);
  const {rows}=await db.query(`SELECT idempotency_key,status FROM commercial_usage_events WHERE account_id=$1 AND workspace_id=$2
    AND meter='agent_documents' AND status IN('COMMITTED','RESERVED') AND units>=1
    AND COALESCE(detail->>'sourceHash',CASE WHEN left(right(idempotency_key,65),1)=':' THEN right(idempotency_key,64) END)=$3
    ORDER BY occurred_at,id`,
    [scope.accountId,scope.workspaceId,sourceHash]);
  return rows;
}
module.exports={readReceipts};
