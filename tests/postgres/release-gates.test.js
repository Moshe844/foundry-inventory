'use strict';

const path=require('node:path');
const { execFile }=require('node:child_process');
const test=require('node:test');
const assert=require('node:assert/strict');
const { startCluster }=require('../helpers/postgres-cluster');
const { openPostgres }=require('../../src/db/postgres');
const { startPostgresWeb }=require('../../src/postgres-web-server');
const checkpoints=require('../../src/operations/postgres-checkpoints');

function run(script,args,env){
  return new Promise((resolve,reject)=>execFile(process.execPath,[path.resolve(__dirname,'../..',script),...args],
    {env:{...process.env,...env},windowsHide:true,timeout:120000,maxBuffer:1024*1024},
    (error,stdout,stderr)=>error?reject(Object.assign(error,{stdout,stderr})):resolve({stdout,stderr})));
}

test('PostgreSQL worker throughput and HTTP soak persist release evidence in the shared database',
  {timeout:180000},async(context)=>{
    const cluster=await startCluster();
    const runtime=await startPostgresWeb({connectionString:cluster.connectionString,env:'test',port:0,host:'127.0.0.1',
      sessionSecret:'postgres-release-gates-secret',installSignalHandlers:false});
    const database=openPostgres(cluster.connectionString,{applicationName:'stockchief-release-gates-assertions'});
    context.after(async()=>{await database.close();await runtime.close('test');cluster.stop();});
    const env={FOUNDRY_DATABASE_URL:cluster.connectionString,NODE_ENV:'test'};
    const worker=await run('scripts/worker-throughput-postgres.js',['--jobs','100','--concurrency','4',
      '--minimum-per-second','1'],env);
    assert.match(worker.stdout,/"engine": "postgresql"/);
    const base=`http://127.0.0.1:${runtime.server.address().port}`;
    const soak=await run('scripts/load-soak.js',['--url',base,'--seconds','2','--concurrency','4',
      '--paths','/healthz,/readyz','--p95-ms','5000','--error-rate','0'],env);
    assert.match(soak.stdout,/"budgetsPassed": true/);
    const evidence=await checkpoints.list(database);
    const selected=evidence.filter((row)=>['worker.throughput','load.soak'].includes(row.key));
    assert.deepEqual(selected.map((row)=>[row.key,row.status]),[['load.soak','PASS'],['worker.throughput','PASS']]);
    assert.equal(selected.find((row)=>row.key==='worker.throughput').detail.engine,'postgresql');
    assert.equal(selected.find((row)=>row.key==='load.soak').detail.url,base);
    assert.equal(Number((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs
      WHERE kind='certification.noop'`)).rows[0].count),0);
  });
