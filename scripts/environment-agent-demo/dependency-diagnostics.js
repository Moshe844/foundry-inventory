'use strict';
const path=require('node:path');
// Host diagnostics only. Never return exception messages or stacks to an agent,
// public progress response or customer. Logging cannot alter the failed work.
function record(error,{goalId=null,phase='runtime',log=value=>console.error(JSON.stringify(value))}={}){
 try{
  let source=error;for(let n=0;n<4&&source&&!['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(source.code);n++)source=source.cause;
  if(!source||!['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND'].includes(source.code))return false;
  const root=path.resolve(__dirname,'../..'),origins=(Array.isArray(source.requireStack)?source.requireStack:[]).map(file=>{
   if(typeof file!=='string')return null;const relative=path.relative(root,file),vendor=/(?:^|[/\\])node_modules[/\\](.+)$/.exec(file);
   const owned=relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)?relative:vendor?'node_modules/'+vendor[1]:null;
   return owned&&/^[A-Za-z0-9_@./\\-]{1,240}$/.test(owned)?owned.replaceAll('\\','/'):null;
  }).filter(Boolean).slice(0,4);
  // Only Node's host-owned require stack qualifies a module identifier. An
  // arbitrary error carrying a copied code supplies no trusted message data.
  const match=origins.length&&/^Cannot find (?:module|package) '([^']+)'/.exec(String(source.message||''));
  const module=match&&/^[@A-Za-z0-9_./-]{1,160}$/.test(match[1])?match[1]:null;
  log({kind:'native_dependency_unavailable',code:source.code,phase:/^[a-z_]{1,40}$/.test(phase)?phase:'runtime',
   goalId:typeof goalId==='string'&&/^goal_[a-z0-9]+$/.test(goalId)?goalId:null,module,origins});return true;
 }catch{return false;}
}
module.exports={record};
