'use strict';
const budget=require('./staging-capacity-lease');
function sample(series,now){
 if(!Array.isArray(series)||series.length!==1||series[0].unit!=='bytes'||!series[0].labels?.some(l=>l.field==='resource'&&l.value===budget.DATABASE_ID))throw Error('Expected staging database byte telemetry.');
 const points=(series[0].values||[]).filter(p=>Number.isSafeInteger(p.value)&&p.value>=0&&Date.parse(p.timestamp)<=now+5000&&Date.parse(p.timestamp)>=now-budget.MAX_LEASE_AGE_MS).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp));
 if(!points.length)throw Error('No fresh staging disk telemetry.');return points[0];
}
async function measure(apiKey,{fetcher=fetch,now=Date.now()}={}){
 if(!apiKey)throw Error('Provide the existing Render API credential to the local monitor.');
 const query=new URLSearchParams({resource:budget.DATABASE_ID,resolutionSeconds:'60',startTime:new Date(now-180000).toISOString()});
 const [used,capacity]=await Promise.all(['disk-usage','disk-capacity'].map(async kind=>{
  const response=await fetcher('https://api.render.com/v1/metrics/'+kind+'?'+query,{headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error('Staging storage telemetry returned HTTP '+response.status);return sample(await response.json(),now);
 }));
 return {databaseId:budget.DATABASE_ID,observedAt:new Date(Math.min(Date.parse(used.timestamp),Date.parse(capacity.timestamp))).toISOString(),usedBytes:used.value,capacityBytes:capacity.value,maximumDatabaseBytes:budget.MAX_DATABASE_BYTES};
}
async function renew(db,jobId,release,measurement){
 const lease={...measurement,jobId,release};
 const bytes=Number((await db.query('SELECT pg_database_size(current_database())::text bytes')).rows[0].bytes);budget.check(lease,{jobId,release,databaseBytes:bytes});
 const updated=await db.query(`UPDATE stockchief_runtime.jobs j SET payload=jsonb_set(j.payload,'{capacityLease}',$3::jsonb),updated_at=now()
  WHERE j.id=$1 AND j.kind='qualification.staging-million' AND j.payload->>'release'=$2 AND j.status IN('PENDING','RETRY','RUNNING')
  AND EXISTS(SELECT 1 FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=j.workspace_id
   AND w.name LIKE 'Synthetic ERP release%' AND a.email LIKE '%@example.test') RETURNING j.status`,[jobId,release,JSON.stringify(lease)]);
 return {renewed:updated.rowCount===1,databaseBytes:bytes,lease};
}
module.exports={sample,measure,renew};
