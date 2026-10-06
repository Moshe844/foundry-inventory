'use strict';

// Read-only, aggregate staging health snapshot. No customer identifiers,
// credentials, URLs, alert detail, or invoice amounts leave the service.
const {openPostgres}=require('../src/db/postgres');
async function main(){
 const url=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
 if(!url)throw Error('A PostgreSQL database URL is required');
 const db=openPostgres(url,{max:2,applicationName:'stockchief-commercial-health-readonly'});
 try{
  const [warnings,missingCosts,alerts,release,capacity]=await Promise.all([
   db.query(`SELECT code,status,count(*)::int AS count FROM commercial_critical_warnings
    GROUP BY code,status ORDER BY code,status`),
   db.query(`SELECT provider,operation,provider_version,
    COALESCE(detail->>'hostname','') AS hostname,count(*)::int AS count
    FROM commercial_cost_events WHERE amount_minor IS NULL
    GROUP BY provider,operation,provider_version,COALESCE(detail->>'hostname','')
    ORDER BY provider,operation,provider_version,hostname`),
   db.query(`SELECT kind,status,count(*)::int AS count FROM operational_alerts
    WHERE kind LIKE 'capacity.%' OR kind='capacity.certification_probe'
    GROUP BY kind,status ORDER BY kind,status`),
   db.query(`SELECT checkout_enabled,(economics_approved_at IS NOT NULL) AS economics_approved,
    (readiness_approved_at IS NOT NULL) AS readiness_approved
    FROM commercial_release_control WHERE singleton=true`),
   require('../src/operations/postgres-capacity').sample(db,{role:'inspection'}),
  ]);
  console.log(JSON.stringify({kind:'STAGING_COMMERCIAL_AGGREGATE_HEALTH',
   warnings:warnings.rows,missingCosts:missingCosts.rows,capacityAlerts:alerts.rows,
   release:release.rows[0],capacity:{queueDepth:capacity.queueDepth,
    oldestQueueWaitMs:capacity.oldestQueueWaitMs,deadJobs:capacity.deadJobs,
    databaseConnections:capacity.databaseConnections,databaseConnectionLimit:capacity.databaseConnectionLimit,
    databaseBytes:capacity.databaseBytes,diskCapacityBytes:capacity.diskCapacityBytes,
    pool:capacity.pool,processMemoryBytes:capacity.processMemoryBytes,
    memoryLimitBytes:capacity.memoryLimitBytes}}));
 }finally{await db.close();}
}
main().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
