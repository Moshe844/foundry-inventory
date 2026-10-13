'use strict';
require('../src/config');
async function main(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||process.env.STOCKCHIEF_CODEX_PILOT!=='1')throw Error('STAGING_PILOT_REQUIRED');
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
 const warmInspection=async()=>{
 const pilots=(await db.query(`SELECT p.workspace_id,u.id AS actor_id FROM stockchief_runtime.codex_pilots p
  JOIN users u ON u.workspace_id=p.workspace_id WHERE p.enabled AND p.workspace_id=ANY($1::text[])
  AND p.authorized_actor_ids ? u.id ORDER BY p.workspace_id,u.id LIMIT 4`,[workspaces])).rows;
 for(const row of pilots){
  const lease=await inspectionPool.acquire({database:db,ctx:{workspaceId:row.workspace_id,actorId:row.actor_id},connectionString:address.toString()});
  await lease.release();
 }
 };await warmInspection();
 let warming=Promise.resolve();
 const warmTimer=setInterval(()=>{warming=warming.then(warmInspection).catch(error=>console.warn('Read-only browser warm-up unavailable:',error.code||'INSPECTION_UNAVAILABLE'));},2*60000);warmTimer.unref();
 const handler=async job=>require('../src/assistant/postgres-codex-pilot').run(db,{workspaceId:job.workspaceId,actorId:job.payload.actorId},job.payload.goalId,{sandboxPool,inspectionPool});
 handler.externalEffect=true;
 const shouldClaim=async()=>Boolean((await db.query(`SELECT 1 FROM stockchief_runtime.codex_pilots WHERE workspace_id=ANY($1::text[])
  AND enabled AND NOT stopped AND approval_reference IS NOT NULL AND ceiling_micro_usd>0
  AND period_ends_at>now() LIMIT 1`,[workspaces])).rows.length);
 const worker=require('../src/operations/postgres-worker').start(db,{handlers:{'assistant.run-codex-goal':handler},leaseMs:10*60000,shouldClaim});
 const stop=async()=>{clearInterval(keepAlive);clearInterval(warmTimer);await worker.stop();await warming;await inspectionPool.close();await sandboxPool.close();await db.close();};
 const keepAlive=setInterval(()=>{},60000);
 process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
 console.log('Codex Staging worker ready. Paid calls remain governed by the PostgreSQL pilot and commercial ledgers.');
 }catch(error){await inspectionPool.close();await sandboxPool.close();if(db)await db.close();throw error;}
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={main};
