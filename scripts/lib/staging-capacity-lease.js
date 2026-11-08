'use strict';
// A local controller measures Render's physical disk. The hosted synthetic
// worker only reads that short-lived proof; no Render credential is copied.
const DATABASE_ID='dpg-damlkhuk1f9s739h5ga0-a',RECOVERY_BYTES=4000000000,TELEMETRY_MARGIN_BYTES=2000000000,MAX_DATABASE_BYTES=50000000000,MAX_LEASE_AGE_MS=90000;
function stopped(message){return Object.assign(new Error(message),{code:'qualification_capacity_paused'});}
function check(lease,{jobId,release,databaseBytes,now=Date.now()}){
 if(!lease||lease.jobId!==jobId||lease.release!==release||lease.databaseId!==DATABASE_ID)
  throw stopped('Synthetic qualification needs its own fresh staging storage measurement.');
 const observed=Date.parse(lease.observedAt);
 if(!Number.isFinite(observed)||observed>now+5000||now-observed>MAX_LEASE_AGE_MS)
  throw stopped('Synthetic qualification paused because its storage monitor expired. Verified import batches remain saved.');
 const {capacityBytes,usedBytes,maximumDatabaseBytes}=lease;
 if(![capacityBytes,usedBytes,maximumDatabaseBytes,databaseBytes].every(Number.isSafeInteger)||capacityBytes<=0||capacityBytes>55*1024**3||usedBytes<0||usedBytes>capacityBytes||maximumDatabaseBytes<=0||maximumDatabaseBytes>MAX_DATABASE_BYTES||databaseBytes<0)
  throw stopped('Synthetic qualification received an invalid storage budget.');
 if(capacityBytes-usedBytes<RECOVERY_BYTES+TELEMETRY_MARGIN_BYTES||databaseBytes>maximumDatabaseBytes)
  throw stopped('Synthetic qualification paused to preserve database recovery space. Verified import batches remain saved.');
 return databaseBytes;
}
function create(db,{jobId,release,now=Date.now}={}){
 if(!/^[a-zA-Z0-9_-]{1,120}$/.test(jobId||'')||!/^[a-f0-9]{40}$/.test(release||''))throw stopped('An exact monitored staging qualification job is required.');
 let nextProbe=0,last;
 return async function capacity({force=false}={}){
  if(!force&&last!==undefined&&now()<nextProbe)return last;
  const row=(await db.query(`SELECT pg_database_size(current_database())::text AS bytes,
   (SELECT payload->'capacityLease' FROM stockchief_runtime.jobs WHERE id=$1
    AND kind='qualification.staging-million' AND status='RUNNING' AND payload->>'release'=$2) AS lease`,[jobId,release])).rows[0];
  last=check(row?.lease,{jobId,release,databaseBytes:Number(row?.bytes),now:now()});nextProbe=now()+10000;return last;
 };
}
module.exports={create,check,DATABASE_ID,RECOVERY_BYTES,TELEMETRY_MARGIN_BYTES,MAX_DATABASE_BYTES,MAX_LEASE_AGE_MS};
