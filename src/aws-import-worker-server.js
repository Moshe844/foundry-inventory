'use strict';

const {configuration}=require('./imports/aws-config');
const {dedicatedHandlers,listen}=require('./imports/aws-worker');

async function start() {
  const config=configuration();
  if(!config)throw new Error('The AWS import backend must be explicitly enabled.');
  const {connectionString,ca}=require('./imports/aws-database-connection').connection();
  const db=require('./db/postgres').openPostgres(connectionString,{max:5,...(ca?{ca}:{}),privateNetwork:false,requireTls:true,applicationName:'stockchief-aws-import-worker'});
  let runtime,receiver,stopping;
  const transport=require('./imports/aws-transport').configured();
  const stop=()=>stopping||=(async()=>{await receiver?.stop();await runtime?.stop();transport.destroy();await db.close();})();
  try{
    // Only the controlled release process applies migrations. A worker cannot
    // launch a concurrent schema upgrade while customers are using the site.
    const applied=await db.query("SELECT 1 FROM stockchief_postgres_migrations WHERE name='539-aws-import-transport.sql'");
    if(!applied.rowCount)throw new Error('Apply the reviewed AWS import migration before enabling the dedicated worker.');
    const handlers=dedicatedHandlers(require('./operations/postgres-runtime-handlers').create());
    const log=error=>console.error(JSON.stringify({event:'import_worker_error',code:error.code||error.name}));
    process.env.STOCKCHIEF_IMPORT_COPY='true';
    runtime=require('./operations/postgres-worker').start(db,{handlers,intervalMs:5000,leaseMs:120000,concurrency:1,onError:log});
    receiver=listen(transport,runtime,{onError:log});
    console.log(JSON.stringify({event:'import_worker_ready',region:config.region,slots:1}));
    return {stop};
  }catch(error){await stop();throw error;}
}

if(require.main===module){
  let runtime;
  const stopping=async()=>{try{await runtime?.stop();}finally{process.exit(0);}};
  process.on('SIGINT',stopping);process.on('SIGTERM',stopping);
  start().then(value=>{runtime=value;}).catch(error=>{console.error(JSON.stringify({event:'import_worker_start_failed',code:error.code||error.name,message:error.message}));process.exitCode=1;});
}
module.exports={start};
