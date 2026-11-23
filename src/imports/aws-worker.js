'use strict';

const KINDS=Object.freeze(['import.analyse-source.aws','import.execute-approved']);

function dedicatedHandlers(all) {
  return Object.fromEntries(KINDS.map(kind=>{
    const handler=all[kind]||(kind==='import.analyse-source.aws'?all['import.analyse-source']:null);
    if(typeof handler!=='function'||handler.externalEffect!==true) throw new Error('A dedicated import worker needs the existing fenced external handlers.');
    return [kind,Object.assign((...args)=>handler(...args),handler,{workerLane:'imports'})];
  }));
}

function validWake(message) {
  try{const body=JSON.parse(message.Body);return body.v===1&&typeof body.id==='string'&&/^rjob_[a-z0-9]+$/.test(body.id);}catch{return false;}
}

function listen(transport,worker,{onError=()=>{}}={}) {
  const controller=new AbortController();let stopped=false;
  const pending=(async()=>{
    while(!stopped){
      try{
        const messages=await transport.receive(controller.signal);
        for(const message of messages){
          if(!validWake(message)){onError(Object.assign(new Error('Invalid import wake signal; retained for dead-letter handling.'),{code:'import_wake_invalid'}));continue;}
          worker.wake();
          // Acknowledge the wake, not a business effect. The job remains in
          // PostgreSQL until its fenced handler commits and verifies it.
          await transport.acknowledge(message);
        }
      }catch(error){
        if(stopped)break;
        onError(error);
        await require('node:timers/promises').setTimeout(1000,undefined,{signal:controller.signal}).catch(()=>{});
      }
    }
  })();
  return {async stop(){stopped=true;controller.abort();await pending;}};
}

function databaseAddress(value,{test=false}={}) {
  let address;try{address=new URL(value);}catch{throw new Error('The AWS worker needs a valid PostgreSQL database URL.');}
  if(!['postgres:','postgresql:'].includes(address.protocol)||!address.hostname||!address.pathname.slice(1))throw new Error('The AWS worker needs a valid PostgreSQL database URL.');
  const local=['localhost','127.0.0.1','[::1]'].includes(address.hostname);
  if(!test&&local)throw new Error('The AWS worker needs the approved hosted database endpoint.');
  if(!local&&address.searchParams.get('sslmode')!=='verify-full')throw new Error('The AWS database connection requires sslmode=verify-full.');
  if(!local&&!address.hostname.includes('.'))throw new Error('Render private hostnames cannot be reached from AWS. Use an approved external endpoint with a restricted IP allowlist.');
  return address.href;
}

module.exports={KINDS,dedicatedHandlers,validWake,listen,databaseAddress};
