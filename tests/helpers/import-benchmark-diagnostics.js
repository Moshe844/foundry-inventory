'use strict';
const fs=require('node:fs'),path=require('node:path');

async function start(db,directory,mode){
 if(process.env.NODE_ENV!=='test'||!directory||!['baseline','copy'].includes(mode))throw new Error('Import diagnostics require a test fixture and explicit artifact directory.');
 // The fixture starts its own temporary server with tracking enabled for all
 // leased connections. Never ALTER SYSTEM or configure a customer database.
 if((await db.query('SHOW track_functions')).rows[0].track_functions!=='all')throw new Error('Start the disposable cluster with function tracking enabled.');
 const before=new Map((await db.query('SELECT funcid,calls,total_time,self_time FROM pg_stat_user_functions')).rows.map(r=>[r.funcid,r]));
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
  const databaseFunctions=(await db.query('SELECT funcid,schemaname,funcname,calls,total_time,self_time FROM pg_stat_user_functions')).rows.map(r=>{
   const previous=before.get(r.funcid)||{calls:0,total_time:0,self_time:0};return {schemaname:r.schemaname,funcname:r.funcname,calls:Number(r.calls)-Number(previous.calls),
    total_ms:Math.round((r.total_time-previous.total_time)*100)/100,self_ms:Math.round((r.self_time-previous.self_time)*100)/100};
  }).filter(r=>r.calls>0).sort((a,b)=>b.total_ms-a.total_ms).slice(0,40);
  if(!databaseFunctions.length)throw new Error('The diagnostic run did not capture its leased database connections.');
  fs.writeFileSync(path.join(directory,mode+'-database-functions.json'),JSON.stringify(databaseFunctions,null,2)+'\n');
  return {mode,nodeHotFrames,databaseFunctions};
 }};
}
module.exports={start};
