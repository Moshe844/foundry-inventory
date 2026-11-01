'use strict';
const {createHash}=require('node:crypto');
function incident(error,origin,release){const safe=value=>String(value||'unknown').replace(/[^a-zA-Z0-9_.:-]/g,'_').slice(0,80);return {kind:'runtime.fatal',origin:safe(origin),name:safe(error?.name),code:safe(error?.code),release:safe(release),fingerprint:createHash('sha256').update(String(error?.stack||error?.name||'unknown')+'\0'+release).digest('hex')};}
function install({runtime=process,record=async()=>{},stop=()=>{},release='unknown',timeoutMs=2000}={}){
 let stopping=false,finished=false,timer;
 const exit=()=>{if(finished)return;finished=true;clearTimeout(timer);runtime.exit(1);};
 function fatal(error,origin){if(stopping)return exit();stopping=true;const event=incident(error,origin,release);try{runtime.stderr.write(JSON.stringify({event:'stockchief.runtime.fatal',...event})+'\n');}catch{}try{stop();}catch{}
  timer=setTimeout(exit,Math.min(5000,Math.max(100,timeoutMs)));timer.unref?.();
  Promise.resolve().then(()=>record(event)).catch(()=>{}).finally(exit);
 }
 const exception=error=>fatal(error,'uncaughtException'),rejection=error=>fatal(error,'unhandledRejection');runtime.on('uncaughtException',exception);runtime.on('unhandledRejection',rejection);
 return ()=>{runtime.off('uncaughtException',exception);runtime.off('unhandledRejection',rejection);clearTimeout(timer);};
}
module.exports={install,incident};
