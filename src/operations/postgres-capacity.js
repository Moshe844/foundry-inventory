'use strict';

const monitoring=require('./postgres-monitoring');
const DEFAULTS=Object.freeze({queueDepthWarn:100,queueDepthCritical:500,
 queueWaitWarnMs:60000,queueWaitCriticalMs:300000,
 connectionWarnFraction:.6,connectionCriticalFraction:.8,
 diskWarnFraction:.7,diskCriticalFraction:.85,
 poolWaitingWarn:1,poolWaitingCritical:3,
 memoryWarnFraction:.7,memoryCriticalFraction:.85,
 cpuWarnFraction:.7,cpuCriticalFraction:.85,
 httpMinimumSamples:20,httpP95WarnMs:1000,httpP95CriticalMs:2000,
 httpErrorWarnFraction:.02,httpErrorCriticalFraction:.05,
 jobRetriesWarn:5,jobRetriesCritical:20,deadJobsWarn:1,deadJobsCritical:10});
function finitePositive(value,name){const n=Number(value);if(!Number.isFinite(n)||n<=0)throw Error(`${name} must be positive`);return n;}
async function sample(database,options={}){
 const result=await database.query(`SELECT
  (SELECT COUNT(*)::int FROM stockchief_runtime.jobs WHERE status IN ('PENDING','RETRY')
    AND available_at<=floor(extract(epoch FROM clock_timestamp())*1000)) AS queue_depth,
  (SELECT COALESCE(floor(extract(epoch FROM clock_timestamp()-MIN(created_at))*1000),0)::bigint
    FROM stockchief_runtime.jobs WHERE status IN ('PENDING','RETRY')
    AND available_at<=floor(extract(epoch FROM clock_timestamp())*1000)) AS oldest_queue_wait_ms,
  (SELECT COUNT(*)::int FROM stockchief_runtime.jobs WHERE status='DEAD') AS dead_jobs,
  (SELECT COUNT(*)::int FROM stockchief_runtime.jobs WHERE status='RETRY'
    AND updated_at>=clock_timestamp()-interval '5 minutes') AS job_retries_5m,
  (SELECT COUNT(*)::int FROM commercial_resource_measurements
    WHERE runtime_kind='web' AND started_at>=clock_timestamp()-interval '5 minutes'
    AND operation NOT IN ('GET /readyz','GET /healthz','GET unmatched-or-static')) AS http_samples_5m,
  (SELECT COUNT(*)::int FROM commercial_resource_measurements
    WHERE runtime_kind='web' AND started_at>=clock_timestamp()-interval '5 minutes'
    AND operation NOT IN ('GET /readyz','GET /healthz','GET unmatched-or-static')
    AND (outcome='ABORTED' OR CASE WHEN outcome ~ '^[0-9]{3}$' THEN outcome::int>=500 ELSE false END)) AS http_errors_5m,
  (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY elapsed_microseconds)
    FROM commercial_resource_measurements WHERE runtime_kind='web'
    AND started_at>=clock_timestamp()-interval '5 minutes'
    AND operation NOT IN ('GET /readyz','GET /healthz','GET unmatched-or-static')) AS http_p95_micros_5m,
  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname=current_database()) AS database_connections,
  current_setting('max_connections')::int AS database_connection_limit,
  pg_database_size(current_database())::bigint AS database_bytes`);
 const row=result.rows[0],pool=typeof database.poolMetrics==='function'?database.poolMetrics():null;
 const diskCapacityGb=options.diskCapacityGb??process.env.FOUNDRY_POSTGRES_DISK_GB;
 const diskCapacityBytes=diskCapacityGb?finitePositive(diskCapacityGb,'Postgres disk capacity')*1024**3:null;
 const memoryLimitMb=options.memoryLimitMb??process.env.FOUNDRY_PROCESS_MEMORY_MB;
 const memoryLimitBytes=memoryLimitMb?finitePositive(memoryLimitMb,'Process memory limit')*1024**2:null;
 return {sampledAt:new Date().toISOString(),role:options.role||'worker',
  queueDepth:Number(row.queue_depth),oldestQueueWaitMs:Number(row.oldest_queue_wait_ms),deadJobs:Number(row.dead_jobs),
  jobRetries5m:Number(row.job_retries_5m),httpSamples5m:Number(row.http_samples_5m),
  httpErrors5m:Number(row.http_errors_5m),httpP95Ms:row.http_p95_micros_5m===null?null:Number(row.http_p95_micros_5m)/1000,
  databaseConnections:Number(row.database_connections),databaseConnectionLimit:Number(row.database_connection_limit),
  databaseBytes:Number(row.database_bytes),diskCapacityBytes,pool,
  processMemoryBytes:process.memoryUsage().rss,memoryLimitBytes,cpuFraction:options.cpuFraction??null};
}
function evaluate(snapshot,thresholds=DEFAULTS){
 const alerts=[];const assess=(kind,value,warn,critical,unit)=>{
  if(value>=critical)alerts.push({kind,severity:'ERROR',value,threshold:critical,unit});
  else if(value>=warn)alerts.push({kind,severity:'WARNING',value,threshold:warn,unit});};
 assess('queue_depth',snapshot.queueDepth,thresholds.queueDepthWarn,thresholds.queueDepthCritical,'jobs');
 assess('queue_wait',snapshot.oldestQueueWaitMs,thresholds.queueWaitWarnMs,thresholds.queueWaitCriticalMs,'ms');
 assess('database_connections',snapshot.databaseConnections/snapshot.databaseConnectionLimit,
  thresholds.connectionWarnFraction,thresholds.connectionCriticalFraction,'fraction');
 if(snapshot.diskCapacityBytes)assess('database_disk',snapshot.databaseBytes/snapshot.diskCapacityBytes,
  thresholds.diskWarnFraction,thresholds.diskCriticalFraction,'fraction');
 if(snapshot.pool)assess('pool_waiters',snapshot.pool.waiting,thresholds.poolWaitingWarn,thresholds.poolWaitingCritical,'requests');
 if(snapshot.memoryLimitBytes)assess('process_memory',snapshot.processMemoryBytes/snapshot.memoryLimitBytes,
  thresholds.memoryWarnFraction,thresholds.memoryCriticalFraction,'fraction');
 if(snapshot.cpuFraction!==null&&Number.isFinite(snapshot.cpuFraction))
  assess('process_cpu',snapshot.cpuFraction,thresholds.cpuWarnFraction,thresholds.cpuCriticalFraction,'fraction');
 if(snapshot.httpSamples5m>=thresholds.httpMinimumSamples){
  assess('http_p95',snapshot.httpP95Ms,thresholds.httpP95WarnMs,thresholds.httpP95CriticalMs,'ms');
  assess('http_error_rate',snapshot.httpErrors5m/snapshot.httpSamples5m,
   thresholds.httpErrorWarnFraction,thresholds.httpErrorCriticalFraction,'fraction');
 }
 assess('job_retries',snapshot.jobRetries5m,thresholds.jobRetriesWarn,thresholds.jobRetriesCritical,'jobs/5m');
 assess('dead_jobs',snapshot.deadJobs,thresholds.deadJobsWarn,thresholds.deadJobsCritical,'jobs');
 if(!snapshot.diskCapacityBytes)alerts.push({kind:'disk_capacity_unconfigured',severity:'ERROR',value:null,threshold:null,unit:'bytes'});
 return alerts;
}
async function check(database,options={}){
 const state=await sample(database,options),alerts=evaluate(state,options.thresholds||DEFAULTS);
 for(const item of alerts)await monitoring.raise(database,{severity:item.severity,kind:`capacity.${item.kind}`,
  title:`Commercial capacity: ${item.kind}`,fingerprint:`commercial-capacity:${state.role}:${item.kind}`,
  detail:JSON.stringify({role:state.role,...item,snapshot:state})});
 return {snapshot:state,alerts};
}
function start(database,options={}){
 const intervalMs=options.intervalMs||60000;
 if(!Number.isInteger(intervalMs)||intervalMs<10000)throw Error('Capacity interval must be at least ten seconds.');
 let active=false,stopped=false,pending=null,previousCpu=process.cpuUsage(),previousAt=Date.now();
 const tick=async()=>{if(active||stopped)return;active=true;
  const now=Date.now(),delta=process.cpuUsage(previousCpu),elapsed=now-previousAt;
  previousCpu=process.cpuUsage();previousAt=now;
  const cores=Number(options.cpuCores??process.env.FOUNDRY_PROCESS_CPU_CORES??1);
  const cpuFraction=elapsed>=10000&&Number.isFinite(cores)&&cores>0?
   (delta.user+delta.system)/1000/elapsed/cores:null;
  try{await check(database,{...options,cpuFraction});}catch(error){if(options.onError)options.onError(error);
   else console.error('[stockchief] capacity telemetry failed:',error.code||error.message);}finally{active=false;}};
 pending=tick();const timer=setInterval(()=>{pending=tick();},intervalMs);timer.unref();
 return {stop:async()=>{stopped=true;clearInterval(timer);await pending;}};
}
module.exports={DEFAULTS,sample,evaluate,check,start};
