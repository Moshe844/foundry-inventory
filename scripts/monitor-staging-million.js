'use strict';
// Local telemetry controller; the actual qualification executes on the existing
// Render worker. No Render credential is placed in its job or environment.
const fs=require('node:fs'),monitor=require('./lib/staging-capacity-monitor');
const arg=name=>{const i=process.argv.indexOf('--'+name);return i<0?null:process.argv[i+1];};
async function main(){
 const release=arg('release'),run=arg('run'),mode=arg('mode'),workspaceId=arg('workspace'),output=arg('output');
 if(!/^[a-f0-9]{40}$/.test(release||'')||!/^[a-z0-9-]{6,60}$/.test(run||'')||!['prepare','million','verify','remeasure'].includes(mode)||!/^wsp_[a-z0-9]+$/.test(workspaceId||'')||!output)throw Error('Choose an exact staging release, synthetic run, mode, inventory and evidence output.');
 if(fs.existsSync(output))throw Error('Preserve the previous qualification evidence; use a new evidence output.');
 const url=require('./lib/staging-database-guard').assertDatabase(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);url.searchParams.set('sslmode','verify-full');
 const db=require('../src/db/postgres').openPostgres(url.href,{max:1,privateNetwork:false,applicationName:'staging-million-capacity-monitor'}),queue=require('../src/operations/postgres-job-queue');let proof;
 const save=()=>fs.writeFileSync(output,JSON.stringify(proof,null,2));
 try{
  const response=await fetch('https://stockchief-staging-web.onrender.com/healthz',{signal:AbortSignal.timeout(15000)});if(!response.ok||(await response.json()).releaseRef!==release)throw Error('Exact healthy staging release required.');
  const measured=await monitor.measure(process.env.RENDER_API_KEY),jobId=require('../src/lib/util').newId('rjob');
  proof={startedAt:new Date().toISOString(),release,run,mode,jobId,hostingChanges:0,paidCalls:0,samples:[]};
  await db.transaction(async c=>{
   await c.query("SELECT pg_advisory_xact_lock(hashtextextended('staging-million-controller',0))");
   if((await c.query("SELECT 1 FROM stockchief_runtime.jobs WHERE kind LIKE 'qualification.%' AND status IN('PENDING','RETRY','RUNNING') LIMIT 1")).rows.length)throw Error('Wait for the existing qualification; do not overlap it.');
   if((await c.query("SELECT 1 FROM import_executions WHERE status='EXECUTING' LIMIT 1")).rows.length)throw Error('Wait for the current import; do not overlap its capacity measurement.');
   const scoped={query:c.query,transaction:fn=>fn(c)};
   await queue.enqueue(scoped,{id:jobId,workspaceId,kind:'qualification.staging-million',payload:{release,run,mode},idempotencyKey:run+':'+mode+':'+release,priority:90,maxAttempts:1});
   if(!(await monitor.renew(scoped,jobId,release,measured)).renewed)throw Error('The synthetic identity or qualification budget changed.');
  },{isolation:'READ COMMITTED'});save();console.log(JSON.stringify({stage:'queued',jobId,mode,run,release}));
  const deadline=Date.now()+2800000;
  while(Date.now()<deadline){
   const job=await queue.get(db,jobId,workspaceId);if(!job)throw Error('The qualification job disappeared.');
   if(!['PENDING','RETRY','RUNNING'].includes(job.status)){Object.assign(proof,{finishedAt:new Date().toISOString(),status:job.status,result:job.result,lastError:job.lastError});save();console.log(JSON.stringify({stage:'finished',jobId,status:job.status,passed:job.result?.passed||false,problem:job.result?.problem||job.lastError}));if(job.status!=='COMPLETED'||!job.result?.passed)process.exitCode=1;return;}
   const current=await monitor.measure(process.env.RENDER_API_KEY),renewed=await monitor.renew(db,jobId,release,current);
   if(!renewed.renewed)continue;
   const row={at:new Date().toISOString(),observedAt:current.observedAt,usedBytes:current.usedBytes,capacityBytes:current.capacityBytes,databaseBytes:renewed.databaseBytes};proof.samples.push(row);save();console.log(JSON.stringify({stage:'capacity',jobId,...row}));
   await new Promise(resolve=>setTimeout(resolve,10000));
  }
  throw Error('The bounded controller deadline expired. The worker will stop when its capacity proof expires.');
 }catch(error){if(proof){proof.monitorError={code:error.code,message:error.message,at:new Date().toISOString()};save();}throw error;}finally{await db.close();}
}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({code:error.code||'capacity_monitor_stopped',message:error.message}));process.exitCode=1;});
module.exports={main};
