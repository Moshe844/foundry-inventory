'use strict';
const {ValidationError}=require('../domain/errors');
async function state(db,accountId){const row=(await db.query(`SELECT coalesce(sum(greatest(0,u.baseline_bytes+u.delta_bytes-u.baseline_delta)),0) AS used,coalesce(bool_and(u.baseline_complete),true) AS complete FROM commercial_storage_usage u JOIN workspaces w ON w.id=u.workspace_id WHERE w.owner_account_id=$1`,[accountId])).rows[0];
 if(!row.complete)throw new ValidationError('Stored data is being measured. Plan changes will be available once this check finishes; your saved data is preserved.');
 const used=Number(row.used);if(!Number.isSafeInteger(used))throw new ValidationError('Stored data exceeds the measurable account range. Contact support.');return used;}
async function baseline(db,workspaceId,relation){
 // Read the old rows and delta at the SAME MVCC point. Applying the baseline
 // later subtracts that exact delta, preserving every intervening mutation.
 const snapshot=await db.transaction(async c=>{const row=(await c.query('SELECT u.*,r.bytes_expression,r.relation::text AS table_name FROM commercial_storage_usage u JOIN commercial_storage_tables r USING(relation) WHERE u.workspace_id=$1 AND u.relation=$2::regclass',[workspaceId,relation])).rows[0];
  if(!row||row.baseline_complete)return null;
  // Both identifier/expression originate in the immutable DB-owned registry.
  const measured=(await c.query(`SELECT coalesce(sum(${row.bytes_expression}),0)::text AS bytes FROM ${row.table_name} t WHERE t.workspace_id=$1`,[workspaceId])).rows[0];return {bytes:measured.bytes,delta:row.delta_bytes};
 },{isolation:'REPEATABLE READ',readOnly:true});
 if(!snapshot)return {alreadyMeasured:true};
 const result=await db.query('UPDATE commercial_storage_usage SET baseline_bytes=$3,baseline_delta=$4,baseline_complete=true WHERE workspace_id=$1 AND relation=$2::regclass AND baseline_complete=false',[workspaceId,relation,snapshot.bytes,snapshot.delta]);return {measured:result.rowCount===1};
}
async function schedule(db){const rows=(await db.query(`SELECT u.workspace_id,u.relation::text AS relation,w.owner_account_id,w.deletion_requested_at FROM commercial_storage_usage u JOIN workspaces w ON w.id=u.workspace_id WHERE NOT u.baseline_complete AND NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE j.kind='commercial.storage-baseline' AND j.idempotency_key='storage-baseline:'||u.workspace_id||':'||u.relation::text) ORDER BY u.workspace_id,u.relation LIMIT 5`)).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:row.deletion_requested_at?null:row.workspace_id,kind:'commercial.storage-baseline',idempotencyKey:`storage-baseline:${row.workspace_id}:${row.relation}`,payload:{workspaceId:row.workspace_id,accountId:row.owner_account_id,relation:row.relation},maxAttempts:5});return rows.length;}
module.exports={state,baseline,schedule};
