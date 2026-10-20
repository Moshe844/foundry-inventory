'use strict';
require('../src/config');
async function main(){
 const scopePolicy=require('../src/assistant/codex-pilot-scope'),commercialRollout=scopePolicy.customerAccess();
 if(!commercialRollout&&(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||process.env.STOCKCHIEF_CODEX_PILOT!=='1'))throw Error('STAGING_PILOT_REQUIRED');
 const address=new URL(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);
 if(process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'||address.searchParams.get('sslmode')!=='verify-full')
  throw Error('LOCAL_STAGING_BRIDGE_REQUIRES_VERIFIED_TLS');
 const image=process.env.STOCKCHIEF_CODEX_PILOT_IMAGE;
 // Compile the already-installed browser module before accepting a goal.
 // Its first synchronous import otherwise stalls in-flight admission queries.
 require('playwright');
 // No image pull/install, no paid request, and no automatic approval here.
 const sandboxPool=require('./environment-agent-demo/codex-sandbox-pool').createPool({image});
 const inspectionPool=require('./environment-agent-demo/inspection-pool').createPool();
 let db;
 try{
 await sandboxPool.ready();
 db=require('../src/db/postgres').openPostgres(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL,{max:5,min:5,idleTimeoutMillis:4*60000,applicationName:'stockchief-codex-staging-worker'});
 await Promise.all([require('./environment-agent-demo/source-hash-worker').sourceHash(),
  ...Array.from({length:5},()=>db.query('SELECT 1'))]);
 if(process.env.STOCKCHIEF_CODEX_TIMING==='1'){
  const hash=statement=>require('node:crypto').createHash('sha256').update(String(statement)).digest('hex').slice(0,16);
  const originalQuery=db.query,originalTransaction=db.transaction;
  db.query=async(statement,values)=>{const at=Date.now();try{return await originalQuery(statement,values);}finally{
   if(Date.now()-at>100)console.log(JSON.stringify({kind:'database_query_timing',queryHash:hash(statement),ms:Date.now()-at,pool:db.poolMetrics()}));
  }};
  db.transaction=async(operation,settings)=>{const at=Date.now();let attempts=0,queriesMs=0,maxQueryMs=0;
   try{return await originalTransaction(client=>{attempts++;return operation({query:async(statement,values)=>{
    const queryAt=Date.now();try{return await client.query(statement,values);}finally{const ms=Date.now()-queryAt;queriesMs+=ms;maxQueryMs=Math.max(maxQueryMs,ms);
     if(ms>100)console.log(JSON.stringify({kind:'database_query_timing',queryHash:hash(statement),ms,pool:db.poolMetrics()}));}
   }});},settings);}finally{
    if(Date.now()-at>200)console.log(JSON.stringify({kind:'database_transaction_timing',ms:Date.now()-at,attempts,queriesMs,maxQueryMs,pool:db.poolMetrics()}));
   }
  };
 }
 await require('../src/db/migrate-postgres').migratePostgres(db);
 await require('../src/assistant/codex-staging-readiness').verifyPricing(db);
 // Prepare only configured, authorized pilot identities. No model calls or
 // business writes; fresh permissions still gate every goal and browser read.
 const workspaces=String(process.env.STOCKCHIEF_CODEX_PILOT_WORKSPACES||'').split(',').map(s=>s.trim()).filter(Boolean);
 const workerIdentity=require('node:crypto').randomUUID();
 const markAvailable=()=>db.query("UPDATE stockchief_runtime.codex_pilots SET worker_seen_at=now(),worker_identity=$2 WHERE workspace_id=ANY($1::text[]) OR $3 AND admission_kind='COMMERCIAL'",[workspaces,workerIdentity,commercialRollout]);
 await markAvailable();
 let availability=Promise.resolve();
 const availabilityTimer=setInterval(()=>{availability=availability.then(markAvailable).catch(error=>console.warn('Agent availability update failed:',error.code||'DATABASE_UNAVAILABLE'));},10000);availabilityTimer.unref();
 const warmInspection=async()=>{
 const pilots=(await db.query(`SELECT p.workspace_id,u.id AS actor_id FROM stockchief_runtime.codex_pilot_workspace_access p
  JOIN users u ON u.workspace_id=p.workspace_id JOIN accounts a ON a.id=u.account_id
  WHERE (p.pilot->>'enabled')::boolean AND
   ($4 AND p.pilot->>'admission_kind'='COMMERCIAL' AND a.id=p.owner_account_id AND u.role='owner'
    OR p.funding_workspace_id=ANY($1::text[]) AND lower(a.email)=ANY($2::text[])
    AND (CASE WHEN p.account_inherited THEN a.id=p.owner_account_id AND u.role='owner'
      ELSE (p.pilot->'authorized_actor_ids') ? u.id END) AND ($3 OR p.workspace_id=ANY($1::text[])))
  ORDER BY p.workspace_id,u.id LIMIT 4`,[workspaces,
   require('../src/assistant/codex-pilot-scope').list(process.env.STOCKCHIEF_CODEX_PILOT_EMAILS).map(e=>e.toLowerCase()),
   require('../src/assistant/codex-pilot-scope').accountAccess(),commercialRollout])).rows;
 for(const row of pilots){
  await inspectionPool.warm({database:db,ctx:{workspaceId:row.workspace_id,actorId:row.actor_id},connectionString:address.toString()});
 }
 };
 // Warming is optional: a busy schema must not take the entire worker offline.
 // Tenant authorization, browser isolation and tool checks still run on every
 // real acquire. A failed warm-up grants no renderer and spends nothing.
 try{await warmInspection();}catch(error){
  if(error.code!=='55P03')throw error;
  console.warn('Read-only browser warm-up deferred: SCHEMA_BUSY');
 }
 let warming=Promise.resolve();
 const warmTimer=setInterval(()=>{warming=warming.then(warmInspection).catch(error=>console.warn('Read-only browser warm-up unavailable:',error.code||'INSPECTION_UNAVAILABLE'));},2*60000);warmTimer.unref();
 const handler=async job=>{
  const ctx={workspaceId:job.workspaceId,actorId:job.payload.actorId};
  try{return await require('../src/assistant/postgres-codex-pilot').run(db,ctx,job.payload.goalId,{sandboxPool,inspectionPool});}
  catch(error){
   // A failure before claim must not leave a permanent "Getting started".
   await db.query(`UPDATE stockchief_runtime.assistant_goals SET status='BLOCKED',answer='The agent could not start this request. Your goal is saved; you can continue it here.',
    checkpoint=jsonb_set(checkpoint,'{harness}',COALESCE(checkpoint->'harness','{}'::jsonb)||$4::jsonb),updated_at=now()
    WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 AND status='READY'`,
    [ctx.workspaceId,ctx.actorId,job.payload.goalId,JSON.stringify({candidate:'codex',failure:{code:'WORKER_START_FAILED',requiresUserInput:false}})]).catch(()=>{});
   throw error;
  }
 };
 handler.externalEffect=true;
 const shouldClaim=async()=>Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.codex_pilots WHERE (workspace_id=ANY($1::text[]) OR $2 AND admission_kind='COMMERCIAL')
  AND enabled AND NOT stopped AND approval_reference IS NOT NULL AND ceiling_micro_usd>0
  AND period_ends_at>now() LIMIT 1`,[workspaces,commercialRollout])).rows.length);
 const worker=require('../src/operations/postgres-worker').start(db,{handlers:{'assistant.run-codex-goal':handler},leaseMs:10*60000,shouldClaim});
 const stopNotifications=await require('../src/assistant/postgres-goal-resume').watchDependencies(db,workspaces,()=>worker.wake(),
  {availableWorkspace:require('../src/assistant/codex-pilot-scope').availableWorkspace})
  .catch(error=>{console.warn('Job/dependency notifications unavailable; durable polling and sweeps remain active:',error.code||'NOTIFICATION_UNAVAILABLE');return async()=>{};});
 const stop=async()=>{clearInterval(keepAlive);clearInterval(warmTimer);clearInterval(availabilityTimer);await stopNotifications();await worker.stop();await warming;await availability;
  await db.query("UPDATE stockchief_runtime.codex_pilots SET worker_seen_at=NULL,worker_identity=NULL WHERE (workspace_id=ANY($1::text[]) OR $3 AND admission_kind='COMMERCIAL') AND worker_identity=$2",[workspaces,workerIdentity,commercialRollout]).catch(()=>{});
  await inspectionPool.close();await sandboxPool.close();await db.close();};
 const keepAlive=setInterval(()=>{},60000);
 process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
 console.log('Codex Staging worker ready. Paid calls remain governed by the PostgreSQL pilot and commercial ledgers.');
 }catch(error){await inspectionPool.close();await sandboxPool.close();if(db)await db.close();throw error;}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={main};
