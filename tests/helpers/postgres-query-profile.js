'use strict';
// Explicit certification diagnostics: SQL shapes only, never parameter values.
function profile(database){
 const queries=new Map(),started=performance.now(),cpu=process.cpuUsage();let phase='analysis';
 function wrap(original){const out={...original,query:async(statement,...args)=>{const at=performance.now(),stage=phase;try{return await original.query(statement,...args);}finally{const shape=String(statement).replace(/'(?:''|[^'])*'/g,"'?'").replace(/\s+/g,' ').trim().slice(0,240),key=stage+'\n'+shape;if(queries.has(key)||queries.size<1024){const row=queries.get(key)||{phase:stage,sql:shape,count:0,totalMs:0,maxMs:0},ms=performance.now()-at;row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);queries.set(key,row);}}}};
  if(original.transaction)out.transaction=(fn,settings)=>original.transaction(client=>fn(wrap(client)),settings);
  if(original.withSessionLock)out.withSessionLock=(key,fn)=>original.withSessionLock(key,client=>fn(wrap(client)));
  return out;
 }
 return {database:wrap(database),phase:value=>{phase=value;},report:()=>({elapsedMs:Math.round(performance.now()-started),cpu:process.cpuUsage(cpu),queries:[...queries.values()].sort((a,b)=>b.totalMs-a.totalMs).slice(0,40).map(r=>({...r,totalMs:Math.round(r.totalMs),maxMs:Math.round(r.maxMs)}))})};
}
module.exports={profile};
