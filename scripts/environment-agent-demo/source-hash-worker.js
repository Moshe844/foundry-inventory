'use strict';
// Keep the complete fresh integrity check, without blocking browser, TLS or
// database callbacks on the host's execution thread. No digest is cached.
const {Worker,isMainThread,parentPort,workerData,MessageChannel,receiveMessageOnPort}=require('node:worker_threads');
const denied=require('./admission-error');
const CHECK_TIMEOUT_MS=15000;
if(!isMainThread){
 parentPort.on('message',id=>{let result;try{result={id,hash:require('./certification').sourceHash()};}
  catch(error){const code=/^[A-Z0-9_]{1,24}$/.test(error?.code||'')?error.code.toLowerCase():'failed';result={id,error:true,kind:'source_integrity_read_'+code};}
  workerData.results.postMessage({...result,finishedAt:process.hrtime.bigint()});});
}else{
 let worker=null,sequence=0;const pending=new Map();
 function rejectAll(kind){for(const job of pending.values()){clearTimeout(job.timer);job.reject(denied(kind));}pending.clear();}
 function settle(current,message){if(worker!==current)return;const job=pending.get(message.id);if(!job)return;
  pending.delete(message.id);clearTimeout(job.timer);
  if(typeof message.finishedAt!=='bigint'||message.finishedAt<job.startedAt)job.reject(denied('source_integrity_invalid_result'));
  else if(message.finishedAt>job.deadline)job.reject(denied('source_integrity_timeout'));
  else if(message.error||!/^[a-f0-9]{64}$/.test(message.hash||''))job.reject(denied(/^source_integrity_read_[a-z0-9_]{1,24}$/.test(message.kind||'')?message.kind:'source_integrity_invalid_result'));
  else job.resolve(message.hash);
  if(!pending.size){current.thread.unref();current.results.unref();}
 }
 function ready(){if(worker)return worker;
  const {port1,port2}=new MessageChannel();let thread;
  try{thread=new Worker(__filename,{resourceLimits:{maxOldGenerationSizeMb:64},workerData:{results:port2},transferList:[port2]});}
  catch{port1.close();port2.close();throw denied('source_integrity_worker_start');}
  const current={thread,results:port1};worker=current;
  port1.on('message',message=>settle(current,message));
  thread.on('error',()=>{if(worker===current){worker=null;rejectAll('source_integrity_worker_error');port1.close();}});
  thread.on('exit',()=>{if(worker===current){worker=null;rejectAll('source_integrity_worker_exit');port1.close();}});
  thread.unref();port1.unref();return current;
 }
 function sourceHash(){return new Promise((resolve,reject)=>{
  const current=ready(),id=++sequence,startedAt=process.hrtime.bigint(),deadline=startedAt+BigInt(CHECK_TIMEOUT_MS)*1000000n;current.thread.ref();current.results.ref();
  const timer=setTimeout(()=>{
   if(worker!==current)return;
   // A busy parent can run an overdue timer before delivering a message that
   // the worker already completed. Drain that queue first. The worker's own
   // monotonic finish time still enforces the unchanged computation deadline.
   let queued;while((queued=receiveMessageOnPort(current.results)))settle(current,queued.message);
   if(pending.has(id)){worker=null;rejectAll('source_integrity_timeout');current.results.close();void current.thread.terminate();}
  },CHECK_TIMEOUT_MS);
  pending.set(id,{resolve,reject,timer,startedAt,deadline});current.thread.postMessage(id);
 });}
 module.exports={sourceHash};
}
