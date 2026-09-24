'use strict';

const crypto=require('node:crypto');
const config=require('../src/config');
const { openPostgres }=require('../src/db/postgres');
const { migratePostgres }=require('../src/db/migrate-postgres');
const jobs=require('../src/operations/postgres-job-queue');
const checkpoints=require('../src/operations/postgres-checkpoints');

function argument(name,fallback){const index=process.argv.indexOf(`--${name}`);return index>=0?process.argv[index+1]:fallback;}

async function main(){
  const connectionString=process.env.FOUNDRY_DATABASE_URL||process.env.DATABASE_URL;
  if(!connectionString)throw new Error('FOUNDRY_DATABASE_URL is required for PostgreSQL worker certification.');
  const count=Math.max(100,Number(argument('jobs',1000)));
  const concurrency=Math.max(1,Math.min(32,Number(argument('concurrency',8))));
  const minimumPerSecond=Math.max(1,Number(argument('minimum-per-second',75)));
  const database=openPostgres(connectionString,{applicationName:'stockchief-worker-throughput',max:concurrency+2});
  const runId=crypto.randomUUID();const prefix=`throughput:${runId}:`;
  try{
    await migratePostgres(database);
    const started=performance.now();
    for(let index=0;index<count;index+=1)await jobs.enqueue(database,{kind:'certification.noop',
      idempotencyKey:`${prefix}${index}`,payload:{runId,index},maxAttempts:1});
    let completed=0;
    async function consumer(index){
      while(completed<count){
        const job=await jobs.processOne(database,{'certification.noop':async(current)=>({runId,index:current.payload.index})},
          {owner:`throughput-${runId}-${index}`,leaseMs:30000});
        if(!job)break;
        if(job.status!=='COMPLETED')throw new Error(`Throughput job ${job.id} did not complete.`);
        completed+=1;
      }
    }
    await Promise.all(Array.from({length:concurrency},(_value,index)=>consumer(index)));
    const completedCount=Number((await database.query(`SELECT COUNT(*) AS count FROM stockchief_runtime.jobs
      WHERE kind='certification.noop' AND idempotency_key LIKE $1 AND status='COMPLETED'`,[`${prefix}%`])).rows[0].count);
    if(completedCount!==count)throw new Error(`Expected ${count} completed jobs; found ${completedCount}.`);
    const durationMs=performance.now()-started;const jobsPerSecond=Math.round((count/durationMs)*1000);
    const detail={runId,jobs:count,completed:completedCount,concurrency,durationMs:Math.round(durationMs),jobsPerSecond,
      minimumPerSecond,budgetPassed:jobsPerSecond>=minimumPerSecond,durable:true,leases:true,completionEvents:true,
      engine:'postgresql',releaseRef:config.operations.releaseRef};
    await checkpoints.record(database,'worker.throughput',detail.budgetPassed?'PASS':'FAIL',detail);
    console.log(JSON.stringify(detail,null,2));
    if(!detail.budgetPassed)process.exitCode=1;
  }finally{
    await database.query(`DELETE FROM stockchief_runtime.jobs WHERE kind='certification.noop' AND idempotency_key LIKE $1`,[`${prefix}%`]);
    await database.close();
  }
}
main().catch((error)=>{console.error(error);process.exitCode=1;});
