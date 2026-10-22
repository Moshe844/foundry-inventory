'use strict';
// Keep the complete fresh integrity check, without blocking browser, TLS or
// database callbacks on the host's execution thread. No digest is cached.
const {Worker,isMainThread,parentPort}=require('node:worker_threads');
const denied=require('./admission-error');
if(!isMainThread){
 parentPort.on('message',id=>{try{parentPort.postMessage({id,hash:require('./certification').sourceHash()});}
  catch(error){const code=/^[A-Z0-9_]{1,24}$/.test(error?.code||'')?error.code.toLowerCase():'failed';parentPort.postMessage({id,error:true,kind:'source_integrity_read_'+code});}});
}else{
 let worker=null,sequence=0;const pending=new Map();
 function rejectAll(kind){for(const job of pending.values()){clearTimeout(job.timer);job.reject(denied(kind));}pending.clear();}
 function ready(){if(worker)return worker;
  const current=new Worker(__filename,{resourceLimits:{maxOldGenerationSizeMb:64}});worker=current;
  current.on('message',message=>{const job=pending.get(message.id);if(!job)return;
   pending.delete(message.id);clearTimeout(job.timer);
   if(message.error||!/^[a-f0-9]{64}$/.test(message.hash||''))job.reject(denied(/^source_integrity_read_[a-z0-9_]{1,24}$/.test(message.kind||'')?message.kind:'source_integrity_invalid_result'));else job.resolve(message.hash);
   if(!pending.size)current.unref();
  });
  current.on('error',()=>{if(worker===current){worker=null;rejectAll('source_integrity_worker_error');}});
  current.on('exit',()=>{if(worker===current){worker=null;rejectAll('source_integrity_worker_exit');}});
  current.unref();return current;
 }
 function sourceHash(){return new Promise((resolve,reject)=>{
  const current=ready(),id=++sequence;current.ref();
  const timer=setTimeout(()=>{if(worker===current){worker=null;rejectAll('source_integrity_timeout');void current.terminate();}},15000);
  pending.set(id,{resolve,reject,timer});current.postMessage(id);
 });}
 module.exports={sourceHash};
}
