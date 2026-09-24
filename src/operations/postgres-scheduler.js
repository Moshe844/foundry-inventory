'use strict';

const jobs=require('./postgres-job-queue');

async function scheduleOnce(database,options={}){
  const now=Number(options.now ?? Date.now());
  const bucketMs=Number(options.bucketMs || 60_000);
  if(!Number.isSafeInteger(now)||!Number.isSafeInteger(bucketMs)||bucketMs<10_000)throw new TypeError('Invalid scheduler time bucket.');
  const bucket=Math.floor(now/bucketMs);
  return jobs.enqueue(database,{kind:'system.runtime-sweep',idempotencyKey:`runtime-sweep:${bucket}`,
    payload:{now},priority:10,maxAttempts:5,availableAt:now,now});
}

function start(database,options={}){
  const intervalMs=Number(options.intervalMs || 60_000);
  if(!Number.isSafeInteger(intervalMs)||intervalMs<10_000)throw new TypeError('Scheduler interval must be at least ten seconds.');
  let stopped=false;let timer;let active=null;
  const tick=async()=>{
    if(stopped||active)return;
    active=scheduleOnce(database).catch((error)=>{if(options.onError)options.onError(error);else console.error('[stockchief] PostgreSQL scheduler failed:',error.code||error.message);});
    try{await active;}finally{active=null;if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}}
  };
  tick();
  return {stop:async()=>{stopped=true;clearTimeout(timer);if(active)await active;}};
}

module.exports={scheduleOnce,start};
