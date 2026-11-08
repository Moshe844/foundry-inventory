'use strict';
// Explicit certification diagnostics: SQL shapes only, never parameter values.
function profile(database){
 const queries=new Map(),transactions=new Map(),started=performance.now(),cpu=process.cpuUsage();let phase='analysis';
 function wrap(original){const out={...original,query:async(statement,...args)=>{const at=performance.now(),stage=phase;try{return await original.query(statement,...args);}finally{const shape=String(statement).replace(/'(?:''|[^'])*'/g,"'?'").replace(/\s+/g,' ').trim().slice(0,240),key=stage+'\n'+shape;if(queries.has(key)||queries.size<1024){const row=queries.get(key)||{phase:stage,sql:shape,count:0,totalMs:0,maxMs:0},ms=performance.now()-at;row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);queries.set(key,row);}}}};
  if(original.transaction)out.transaction=async(fn,settings)=>{const at=performance.now(),stage=phase;let callbackMs=0,attempts=0;
   try{return await original.transaction(async client=>{attempts++;const entered=performance.now();try{return await fn(wrap(client));}finally{callbackMs+=performance.now()-entered;}},settings);}
   finally{const totalMs=performance.now()-at,row=transactions.get(stage)||{phase:stage,count:0,attempts:0,totalMs:0,callbackMs:0,boundaryMs:0};row.count++;row.attempts+=attempts;row.totalMs+=totalMs;row.callbackMs+=callbackMs;row.boundaryMs+=totalMs-callbackMs;transactions.set(stage,row);}
  };
  if(original.withSessionLock)out.withSessionLock=(key,fn)=>original.withSessionLock(key,client=>fn(wrap(client)));
  if(original.withSharedSession)out.withSharedSession=fn=>original.withSharedSession(client=>fn(wrap(client)));
  return out;
 }
 return {database:wrap(database),phase:value=>{phase=value;},report:()=>({elapsedMs:Math.round(performance.now()-started),cpu:process.cpuUsage(cpu),totalQueryMs:Math.round([...queries.values()].reduce((n,r)=>n+r.totalMs,0)),totalQueryCount:[...queries.values()].reduce((n,r)=>n+r.count,0),transactions:[...transactions.values()].map(r=>({...r,totalMs:Math.round(r.totalMs),callbackMs:Math.round(r.callbackMs),boundaryMs:Math.round(r.boundaryMs)})),queries:[...queries.values()].sort((a,b)=>b.totalMs-a.totalMs).slice(0,40).map(r=>({...r,totalMs:Math.round(r.totalMs),maxMs:Math.round(r.maxMs)}))})};
}
module.exports={profile};
