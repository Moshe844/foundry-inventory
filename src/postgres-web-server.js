'use strict';

const config=require('./config');
const { openPostgres }=require('./db/postgres');
const { migratePostgres }=require('./db/migrate-postgres');
const { createPostgresApp }=require('./postgres-app');
const { validateProductionEnvironment }=require('./operations/postgres-production-environment');

async function startPostgresWeb(options={}){
  const connectionString=options.connectionString||process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  if(!connectionString)throw new Error('FOUNDRY_DATABASE_URL is required for the PostgreSQL web process.');
  validateProductionEnvironment(options);
  const database=options.database||openPostgres(connectionString,{applicationName:'stockchief-postgres-web'});
  await migratePostgres(database);
  const app=createPostgresApp({database,env:options.env||config.env,
    sessionSecret:options.sessionSecret||config.sessionSecret,
    connectionPublicOrigin:options.publicOrigin||config.connections.publicOrigin});
  const port=options.port===undefined?config.port:options.port;
  const server=await new Promise((resolve,reject)=>{
    const listening=app.listen(port,options.host||'0.0.0.0',()=>resolve(listening));
    listening.once('error',reject);
  });
  console.log(`StockChief PostgreSQL web listening on port ${server.address().port}`);
  let closing=false;
  const close=async(signal='shutdown',exit=false)=>{
    if(closing)return;closing=true;
    console.log(`[stockchief] ${signal}; stopping PostgreSQL web.`);
    await new Promise((resolve)=>server.close(resolve));
    await app.locals.sessionStore.close();await database.close();
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
  try{await startPostgresWeb();}
  catch(error){console.error(error);process.exitCode=1;}
}

if(require.main===module)main();

module.exports={startPostgresWeb,validateProductionEnvironment,main};
