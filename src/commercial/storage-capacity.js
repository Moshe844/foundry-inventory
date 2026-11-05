'use strict';
const {ValidationError}=require('../domain/errors');
async function state(db,accountId){const row=(await db.query(`SELECT coalesce(sum(u.baseline_bytes),0) AS used,coalesce(bool_and(u.baseline_complete),true) AS complete FROM commercial_storage_usage u JOIN workspaces w ON w.id=u.workspace_id WHERE w.owner_account_id=$1`,[accountId])).rows[0];
 if(!row.complete)throw new ValidationError('Stored data is being measured. New file uploads and plan changes will be available once this check finishes; your saved data is preserved.');
 const used=Number(row.used);if(!Number.isSafeInteger(used))throw new ValidationError('Stored data exceeds the measurable account range. Contact support.');return used;}
async function reserved(db,accountId){return amount(Number((await db.query('SELECT coalesce(sum(r.bytes),0) AS bytes FROM commercial_storage_reservations r JOIN workspaces w ON w.id=r.workspace_id WHERE w.owner_account_id=$1',[accountId])).rows[0].bytes));}
async function lockAdmission(db,accountId){await db.query('INSERT INTO commercial_storage_admissions(account_id) VALUES($1) ON CONFLICT DO NOTHING',[accountId]);await db.query('SELECT account_id FROM commercial_storage_admissions WHERE account_id=$1 FOR UPDATE',[accountId]);}
function amount(value){if(!Number.isSafeInteger(value)||value<0)throw new ValidationError('The file storage estimate is invalid.');return value;}
async function check(db,workspaceId,bytes){amount(bytes);const ent=require('./entitlements'),scope=await ent.ownerScopeForWorkspace(db,workspaceId),meter=await ent.meterState(db,scope,'storage_bytes');
 if(meter.hardLimit!==null&&(meter.capacityUsed||0)+bytes>meter.hardLimit)throw new ent.EntitlementError('This file or import needs more stored-data capacity than your plan has available. Free storage or upgrade, then try again.',{...meter,meter:'storage_bytes',additional:bytes});return {scope,meter};}
async function reserve(db,workspaceId,key,bytes,{finished=false}={}){
 amount(bytes);if(typeof key!=='string'||!key||key.length>200)throw new ValidationError('A stable storage admission key is required.');
 const ent=require('./entitlements'),scope=await ent.ownerScopeForWorkspace(db,workspaceId);await lockAdmission(db,scope.accountId);
 const prior=(await db.query('SELECT bytes FROM commercial_storage_reservations WHERE workspace_id=$1 AND reservation_key=$2',[workspaceId,key])).rows[0];
 const previous=Number(prior?.bytes||0);if(prior&&previous>=bytes)return {reserved:previous,replayed:true};
 const meter=await ent.meterState(db,scope,'storage_bytes');
 if(meter.hardLimit!==null&&(meter.capacityUsed||0)+bytes-previous>meter.hardLimit)throw new ent.EntitlementError('This file or import needs more stored-data capacity than your plan has available. Free storage or upgrade, then try again.',{...meter,meter:'storage_bytes',additional:bytes-previous});
 await db.query(`INSERT INTO commercial_storage_reservations(workspace_id,reservation_key,bytes,finished_xid) VALUES($1,$2,$3,CASE WHEN $4 THEN pg_current_xact_id() ELSE NULL END)
 ON CONFLICT(workspace_id,reservation_key) DO UPDATE SET bytes=EXCLUDED.bytes,finished_xid=EXCLUDED.finished_xid`,[workspaceId,key,bytes,finished]);return {reserved:bytes};
}
async function finish(db,workspaceId,key){await db.query('UPDATE commercial_storage_reservations SET finished_xid=pg_current_xact_id() WHERE workspace_id=$1 AND reservation_key=$2',[workspaceId,key]);}
function previewBytes(sourceBytes,rows){return amount(Math.max(0,Number(sourceBytes))*4+Math.max(0,Number(rows))*4096+16384);}
function importBytes(plan){return amount(Math.max(0,Number(plan.recordsValid))*16384);}
async function measurement(db,workspaceId,relation=null){
 return db.transaction(async c=>{
  const instant=(await c.query('SELECT pg_current_snapshot()::text AS snapshot,transaction_timestamp() AS at')).rows[0];
  const registry=(await c.query(`SELECT u.relation::text AS relation,r.bytes_expression FROM commercial_storage_usage u JOIN commercial_storage_tables r USING(relation) WHERE u.workspace_id=$1 AND ($2::text IS NULL OR u.relation=$2::regclass) ORDER BY u.relation`,[workspaceId,relation])).rows;
  // A cursor scans each relation once, keeps the same exact logical-byte
  // expression and snapshot, and yields between small batches. A monolithic
  // SUM lets quota maintenance occupy CPU/I/O continuously for millions of
  // historical records while customers are trying to use the application.
  await c.query('SET LOCAL max_parallel_workers_per_gather=0');
  const rows=[];for(const entry of registry){
   await c.query(`DECLARE stockchief_storage_rows NO SCROLL CURSOR FOR SELECT ${entry.bytes_expression} AS bytes FROM ${entry.relation} t WHERE t.workspace_id=$1`,[workspaceId]);
   let bytes=0n;for(;;){const batch=(await c.query('FETCH FORWARD 1000 FROM stockchief_storage_rows')).rows;
    for(const row of batch)bytes+=BigInt(row.bytes||0);
    if(batch.length<1000)break;
    await new Promise(resolve=>setTimeout(resolve,50));
   }
   await c.query('CLOSE stockchief_storage_rows');rows.push({relation:entry.relation,bytes:bytes.toString()});
  }
  return {...instant,rows};
 },{isolation:'REPEATABLE READ',readOnly:true,jit:false});
}
async function publish(db,workspaceId,snapshot,{complete=false}={}){
 return db.transaction(async c=>{
  const owner=(await c.query('SELECT owner_account_id FROM workspaces WHERE id=$1',[workspaceId])).rows[0];if(!owner)return {deleted:true};
  await lockAdmission(c,owner.owner_account_id);
  await c.query(`UPDATE commercial_storage_usage u SET baseline_bytes=m.bytes,delta_bytes=0,baseline_delta=0,baseline_complete=true,measured_at=$3
   FROM jsonb_to_recordset($2::jsonb) AS m(relation text,bytes bigint) WHERE u.workspace_id=$1 AND u.relation=m.relation::regclass AND u.measured_at<=$3`,[workspaceId,JSON.stringify(snapshot.rows),snapshot.at]);
  // A finishing transaction with an older xid can commit after this snapshot.
  // Visibility, rather than a timestamp or maximum xid, protects its allowance.
  if(complete)await c.query('DELETE FROM commercial_storage_reservations WHERE workspace_id=$1 AND finished_xid IS NOT NULL AND pg_visible_in_snapshot(finished_xid,$2::pg_snapshot)',[workspaceId,snapshot.snapshot]);
  return {measured:true,relations:snapshot.rows.length};
 },{isolation:'READ COMMITTED'});
}
async function baseline(db,workspaceId,relation){return publish(db,workspaceId,await measurement(db,workspaceId,relation));}
async function refresh(db,workspaceId){return publish(db,workspaceId,await measurement(db,workspaceId),{complete:true});}
async function schedule(db,{now=Date.now()}={}){
 const rows=(await db.query(`SELECT u.workspace_id,w.owner_account_id,w.deletion_requested_at FROM commercial_storage_usage u JOIN workspaces w ON w.id=u.workspace_id
 WHERE NOT EXISTS(SELECT 1 FROM platform_account_access a WHERE a.account_id=w.owner_account_id AND a.disabled_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.jobs j WHERE (j.workspace_id=w.id OR j.kind='commercial.storage-baseline' AND j.payload->>'workspaceId'=w.id) AND j.kind IN('commercial.storage-baseline','import.execute-approved','import.analyse-source') AND j.status IN('PENDING','RUNNING','RETRY'))
 GROUP BY u.workspace_id,w.owner_account_id,w.deletion_requested_at HAVING bool_or(NOT u.baseline_complete) OR min(u.measured_at)<to_timestamp($1/1000.0)-interval '1 hour'
 ORDER BY min(u.measured_at),u.workspace_id LIMIT 5`,[now])).rows;
 for(const row of rows)await require('../operations/postgres-job-queue').enqueue(db,{workspaceId:row.deletion_requested_at?null:row.workspace_id,kind:'commercial.storage-baseline',idempotencyKey:`storage-refresh:${row.workspace_id}:${Math.floor(now/60000)}`,payload:{workspaceId:row.workspace_id,accountId:row.owner_account_id},maxAttempts:5,priority:1});return rows.length;
}
module.exports={state,reserved,check,reserve,finish,previewBytes,importBytes,baseline,refresh,schedule};
