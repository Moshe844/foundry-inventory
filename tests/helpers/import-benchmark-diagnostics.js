'use strict';
const fs=require('node:fs'),path=require('node:path');

async function start(db,directory,mode){
 if(process.env.NODE_ENV!=='test'||!directory||!['baseline','copy'].includes(mode))throw new Error('Import diagnostics require a test fixture and explicit artifact directory.');
 // Session-only tracking. Never ALTER SYSTEM or change production settings.
 await db.query("SET track_functions='all'");
 const session=new (require('node:inspector/promises').Session)();session.connect();
 await session.post('Profiler.enable');await session.post('Profiler.start');let stopped=false;
 const cancel=async()=>{if(stopped)return;stopped=true;try{await session.post('Profiler.stop');}finally{session.disconnect();}};
 return {cancel,async finish(){
  if(stopped)throw new Error('Import diagnostics have already stopped.');
  let profile;try{({profile}=await session.post('Profiler.stop'));}finally{stopped=true;session.disconnect();}
  fs.writeFileSync(path.join(directory,mode+'.cpuprofile'),JSON.stringify(profile));
  const frames=new Map(profile.nodes.map(n=>[n.id,n.callFrame])),weights=new Map();
  for(let i=0;i<profile.samples.length;i++){const frame=frames.get(profile.samples[i]);if(!frame)continue;
   const key=JSON.stringify(frame);weights.set(key,(weights.get(key)||0)+(profile.timeDeltas[i]||0));}
  const nodeHotFrames=[...weights].sort((a,b)=>b[1]-a[1]).slice(0,30).map(([frame,us])=>({...JSON.parse(frame),selfMs:Math.round(us/1000)}));
  await db.query('SELECT pg_stat_force_next_flush()');
  const databaseFunctions=(await db.query(`SELECT schemaname,funcname,calls,round(total_time::numeric,2)::text total_ms,round(self_time::numeric,2)::text self_ms
   FROM pg_stat_user_functions WHERE calls>0 ORDER BY total_time DESC LIMIT 40`)).rows;
  fs.writeFileSync(path.join(directory,mode+'-database-functions.json'),JSON.stringify(databaseFunctions,null,2)+'\n');
  return {mode,nodeHotFrames,databaseFunctions};
 }};
}
module.exports={start};
