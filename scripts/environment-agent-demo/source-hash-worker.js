'use strict';
// Keep the complete fresh integrity check, without blocking browser, TLS or
// database callbacks on the host's execution thread. No digest is cached.
const {Worker,isMainThread,parentPort}=require('node:worker_threads');
if(!isMainThread){
 parentPort.on('message',id=>{try{parentPort.postMessage({id,hash:require('./certification').sourceHash()});}
  catch{parentPort.postMessage({id,error:true});}});
}else{
 let worker=null,sequence=0;const pending=new Map();
 function rejectAll(){for(const job of pending.values()){clearTimeout(job.timer);job.reject(Error('STAGING_CODEX_ADMISSION_BLOCKED'));}pending.clear();}
 function ready(){if(worker)return worker;
  const current=new Worker(__filename,{resourceLimits:{maxOldGenerationSizeMb:64}});worker=current;
  current.on('message',message=>{const job=pending.get(message.id);if(!job)return;
   pending.delete(message.id);clearTimeout(job.timer);
   if(message.error||!/^[a-f0-9]{64}$/.test(message.hash||''))job.reject(Error('STAGING_CODEX_ADMISSION_BLOCKED'));else job.resolve(message.hash);
   if(!pending.size)current.unref();
  });
  current.on('error',()=>{if(worker===current){worker=null;rejectAll();}});
  current.on('exit',()=>{if(worker===current){worker=null;rejectAll();}});
  current.unref();return current;
 }
 function sourceHash(){return new Promise((resolve,reject)=>{
  const current=ready(),id=++sequence;current.ref();
  const timer=setTimeout(()=>{if(worker===current){worker=null;rejectAll();void current.terminate();}},15000);
  pending.set(id,{resolve,reject,timer});current.postMessage(id);
 });}
 module.exports={sourceHash};
}
