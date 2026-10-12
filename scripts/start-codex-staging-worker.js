'use strict';
require('../src/config');
async function main(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='staging'||process.env.STOCKCHIEF_CODEX_PILOT!=='1')throw Error('STAGING_PILOT_REQUIRED');
 const address=new URL(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL);
 if(process.env.FOUNDRY_DATABASE_PRIVATE_NETWORK==='true'||address.searchParams.get('sslmode')!=='verify-full')
  throw Error('LOCAL_STAGING_BRIDGE_REQUIRES_VERIFIED_TLS');
 const image=process.env.STOCKCHIEF_CODEX_PILOT_IMAGE;
 // No image pull/install, no paid request, and no automatic approval here.
 const sandbox=await require('./environment-agent-demo/sandbox').createSandbox({image});
 try{await sandbox.certify();}finally{await sandbox.close();}
 const db=require('../src/db/postgres').openPostgres(process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL,{max:5,applicationName:'stockchief-codex-staging-worker'});
 await require('../src/db/migrate-postgres').migratePostgres(db);
 const handler=async job=>require('../src/assistant/postgres-codex-pilot').run(db,{workspaceId:job.workspaceId,actorId:job.payload.actorId},job.payload.goalId);
 handler.externalEffect=true;
 const worker=require('../src/operations/postgres-worker').start(db,{handlers:{'assistant.run-codex-goal':handler},leaseMs:10*60000});
 const stop=async()=>{clearInterval(keepAlive);await worker.stop();await db.close();};
 const keepAlive=setInterval(()=>{},60000);
 process.once('SIGTERM',()=>stop().then(()=>process.exit(0)));process.once('SIGINT',()=>stop().then(()=>process.exit(0)));
 console.log('Codex Staging worker ready. Paid calls remain governed by the PostgreSQL pilot and commercial ledgers.');
}
if(require.main===module)main().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
module.exports={main};
