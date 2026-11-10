'use strict';

const config=require('./config');
const { openPostgres }=require('./db/postgres');
const { migratePostgres }=require('./db/migrate-postgres');
const { validateProductionEnvironment }=require('./operations/postgres-production-environment');

async function startPostgresWeb(options={}){
  const { createPostgresApp }=require('./postgres-app');
  const connectionString=options.connectionString||process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  if(!connectionString)throw new Error('FOUNDRY_DATABASE_URL is required for the PostgreSQL web process.');
  validateProductionEnvironment(options);
  const database=options.database||openPostgres(connectionString,{applicationName:'stockchief-postgres-web'});
  await migratePostgres(database);
  // A busy request pool must not make Render mistake the live process for a
  // crashed service. Probes retain a bounded, separate database connection.
  const probeDatabase=options.probeDatabase||(options.database?database:openPostgres(connectionString,{max:1,connectionTimeoutMillis:2000,applicationName:'stockchief-postgres-probes'}));
  // Records the server's pauses and what caused them (see web-stall-monitor.js).
  const stalls=require('./operations/web-stall-monitor').start(database,{source:'web'});
  const app=createPostgresApp({database,probeDatabase,requestTracker:stalls.track,env:options.env||config.env,
    sessionSecret:options.sessionSecret||config.sessionSecret,
    connectionPublicOrigin:options.publicOrigin||config.connections.publicOrigin});
  const port=options.port===undefined?config.port:options.port;
  const server=await new Promise((resolve,reject)=>{
    const listening=app.listen(port,options.host||'0.0.0.0',()=>resolve(listening));
    listening.once('error',reject);
  });
  console.log(`StockChief PostgreSQL web listening on port ${server.address().port}`);
  const stopCrashMonitor=options.installSignalHandlers===false?null:require('./operations/crash-monitor').install({
    release:config.operations.releaseRef,stop:()=>server.close(),record:async event=>{
      const monitoring=require('./operations/postgres-monitoring'),alert=await monitoring.raise(database,{severity:'ERROR',kind:event.kind,
        fingerprint:'web-crash:'+event.fingerprint,title:'StockChief web process stopped unexpectedly',
        detail:'Unhandled '+event.origin+'; incident '+event.fingerprint+'. The process exits for the hosting supervisor to restart it. Review private service logs.'});
      if(config.operations.alertWebhookUrl)await monitoring.deliver(database,null,alert.id);
    }});
  const capacity=options.capacityMonitor===false?null:require('./operations/postgres-capacity').start(database,
    {role:'web',onError:error=>console.error('[stockchief] web capacity telemetry failed:',error.code||error.message)});
  let closing=false;
  const close=async(signal='shutdown',exit=false)=>{
    if(closing)return;closing=true;if(stopCrashMonitor)stopCrashMonitor();
    console.log(`[stockchief] ${signal}; stopping PostgreSQL web.`);
    await new Promise((resolve)=>server.close(resolve));
    if(capacity)await capacity.stop();await stalls.stop();await app.locals.sessionStore.close();await database.close();if(probeDatabase!==database&&!options.probeDatabase)await probeDatabase.close();
    if(exit)process.exit(0);
  };
  if(options.installSignalHandlers!==false){
    const handle=(signal)=>{close(signal,true).catch((error)=>{console.error(error);process.exit(1);});};
    process.on('SIGINT',()=>handle('SIGINT'));
    process.on('SIGTERM',()=>handle('SIGTERM'));
  }
  return {database,app,server,close};
}

async function main(){
  try{
    if((process.env.STOCKCHIEF_RUNTIME_ENV==='staging'||process.env.STOCKCHIEF_WEB_RECOVERY_PROXY==='1')&&process.env.STOCKCHIEF_WEB_BACKEND!=='1'){
      const guardian=await require('./operations/web-restart-guardian').start({entrypoint:__filename,port:config.port,logger:event=>console.error(JSON.stringify(event))});
      let closing=false;const stop=()=>{if(closing)return;closing=true;guardian.close().then(()=>process.exit(0),()=>process.exit(1));};process.on('SIGTERM',stop);process.on('SIGINT',stop);
    }else{const running=await startPostgresWeb(process.env.STOCKCHIEF_WEB_BACKEND==='1'?{port:0,host:'127.0.0.1'}:{});if(process.env.STOCKCHIEF_WEB_BACKEND==='1'&&process.send)process.send({type:'stockchief.web.ready',port:running.server.address().port});}
  }
  catch(error){console.error(error);process.exitCode=1;}
}

if(require.main===module)main();

module.exports={startPostgresWeb,validateProductionEnvironment,main};
