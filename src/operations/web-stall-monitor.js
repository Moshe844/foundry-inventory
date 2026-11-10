'use strict';
// Records why the web server sometimes stops answering for seconds.
//
// A timer that should fire every 250 ms measures how late it fires: lateness
// means the process could not run anything, so every waiting request waited
// too. Each pause of half a second or more is written down with what was in
// flight, the memory clean-up (GC) pauses around it, memory use, process CPU,
// and the container's CPU throttling counters. A one-minute summary records
// the same figures even when nothing paused, so slow-but-busy periods show
// too. The restart proxy in front reports its own pauses and slow answers
// here as well (web-restart-guardian.js). Rows are kept three days.
const fs=require('node:fs');
const {PerformanceObserver,monitorEventLoopDelay}=require('node:perf_hooks');
const {newId}=require('../lib/util');

const TICK_MS=250,PAUSE_MS=500,SUMMARY_MS=60000,FLUSH_MS=2000,KEEP='3 days';

// Paths without identifiers or tokens: long segments become :id.
function route(method,url){
  const path=String(url||'').split('?')[0].split('/').map((part)=>part.length>=16||/\d{4,}/.test(part)?':id':part).join('/');
  return (method||'')+' '+path.slice(0,90);
}

// Container limits and throttling (cgroup v2, then v1); null where unavailable.
function readFile(path){try{return fs.readFileSync(path,'utf8');}catch{return null;}}
function cgroup(){
  const stat=readFile('/sys/fs/cgroup/cpu.stat'),v1=stat?null:readFile('/sys/fs/cgroup/cpu/cpu.stat');
  const field=(text,name)=>{const m=new RegExp('^'+name+' (\\d+)$','m').exec(text||'');return m?Number(m[1]):null;};
  const max=(readFile('/sys/fs/cgroup/cpu.max')||'').trim().split(/\s+/);
  const memoryCurrent=Number(readFile('/sys/fs/cgroup/memory.current'))||null,memoryMax=Number(readFile('/sys/fs/cgroup/memory.max'))||null;
  return {
    throttledPeriods:stat?field(stat,'nr_throttled'):field(v1,'nr_throttled'),
    throttledMs:stat?Math.round((field(stat,'throttled_usec')||0)/1000):v1?Math.round((field(v1,'throttled_time')||0)/1e6):null,
    cpuLimitCores:max.length===2&&max[0]!=='max'?Number(max[0])/Number(max[1]):null,
    memoryMb:memoryCurrent?Math.round(memoryCurrent/1048576):null,memoryLimitMb:memoryMax?Math.round(memoryMax/1048576):null};
}

function start(database,{source='web',enabled=process.env.NODE_ENV!=='test'&&process.env.STOCKCHIEF_STALL_MONITOR!=='0',summaryMs=SUMMARY_MS,flushMs=FLUSH_MS}={}){
  const inflight=new Map();let sequence=0;
  const track=(req,res,next)=>{const id=++sequence;inflight.set(id,{route:route(req.method,req.originalUrl||req.url),at:Date.now()});
    const done=()=>inflight.delete(id);res.once('finish',done);res.once('close',done);next();};
  if(!enabled)return {track,record:()=>{},stop:async()=>{}};

  const queue=[],gcs=[],delay=monitorEventLoopDelay({resolution:20});delay.enable();
  let observer=null;
  try{observer=new PerformanceObserver((list)=>{for(const entry of list.getEntries())if(entry.duration>=20)gcs.push({at:Date.now(),ms:Math.round(entry.duration),kind:entry.detail?.kind??entry.kind});
    while(gcs.length>200)gcs.shift();});observer.observe({entryTypes:['gc']});}catch{observer=null;}
  const memory=()=>{const m=process.memoryUsage();return {rssMb:Math.round(m.rss/1048576),heapUsedMb:Math.round(m.heapUsed/1048576),heapTotalMb:Math.round(m.heapTotal/1048576),externalMb:Math.round(m.external/1048576)};};
  const record=(kind,durationMs,detail={},from=source)=>{queue.push({id:newId('stall'),source:from,kind,duration_ms:Math.max(0,Math.round(durationMs)),detail});if(queue.length>500)queue.shift();};

  let last=Date.now(),lastCpu=process.cpuUsage(),lastCgroup=cgroup(),summaryAt=Date.now();
  const tick=setInterval(()=>{
    const now=Date.now(),late=now-last-TICK_MS;last=now;
    if(late>=PAUSE_MS){const cpu=process.cpuUsage(lastCpu),group=cgroup();
      record('event_loop',late,{inflight:[...inflight.values()].sort((a,b)=>a.at-b.at).slice(0,6).map((r)=>({route:r.route,ageMs:now-r.at})),
        inflightCount:inflight.size,gcPauses:gcs.filter((g)=>g.at>=now-late-2000),memory:memory(),
        cpuMs:Math.round((cpu.user+cpu.system)/1000),throttledPeriods:group.throttledPeriods!=null&&lastCgroup.throttledPeriods!=null?group.throttledPeriods-lastCgroup.throttledPeriods:null,
        throttledMs:group.throttledMs!=null&&lastCgroup.throttledMs!=null?group.throttledMs-lastCgroup.throttledMs:null});}
    if(now-summaryAt>=summaryMs){const cpu=process.cpuUsage(lastCpu),group=cgroup(),elapsed=now-summaryAt;summaryAt=now;lastCpu=process.cpuUsage();
      record('summary',delay.max/1e6,{p50Ms:Math.round(delay.percentile(50)/1e6),p99Ms:Math.round(delay.percentile(99)/1e6),maxMs:Math.round(delay.max/1e6),
        cpuPercentOfOneCore:Math.round((cpu.user+cpu.system)/1000/elapsed*100),gcPauses:gcs.filter((g)=>g.at>=now-elapsed).length,
        gcPauseMs:gcs.filter((g)=>g.at>=now-elapsed).reduce((n,g)=>n+g.ms,0),memory:memory(),container:group,
        throttledPeriods:group.throttledPeriods!=null&&lastCgroup.throttledPeriods!=null?group.throttledPeriods-lastCgroup.throttledPeriods:null,
        throttledMs:group.throttledMs!=null&&lastCgroup.throttledMs!=null?group.throttledMs-lastCgroup.throttledMs:null,inflightCount:inflight.size,uptimeS:Math.round(process.uptime())});
      lastCgroup=group;delay.reset();}
  },TICK_MS);tick.unref();

  // The proxy in front reports its own pauses and slow answers over IPC.
  const fromProxy=(message)=>{if(message?.type==='stockchief.guardian.stall'&&typeof message.kind==='string')
    record(message.kind.slice(0,40),Number(message.ms)||0,message.detail&&typeof message.detail==='object'?message.detail:{},'proxy');};
  process.on('message',fromProxy);

  let flushing=false,cleanedAt=0;
  const flush=async()=>{if(flushing||!queue.length)return;flushing=true;const rows=queue.splice(0,queue.length);
    try{await database.query(`INSERT INTO stockchief_runtime.web_stalls(id,source,kind,duration_ms,detail)
        SELECT id,source,kind,duration_ms,detail FROM jsonb_to_recordset($1::jsonb) AS r(id text,source text,kind text,duration_ms int,detail jsonb)
        ON CONFLICT(id) DO NOTHING`,[JSON.stringify(rows)]);
      if(Date.now()-cleanedAt>3600000){cleanedAt=Date.now();await database.query(`DELETE FROM stockchief_runtime.web_stalls WHERE observed_at<now()-$1::interval`,[KEEP]);}}
    catch(error){console.error('[stockchief] could not record web stalls:',error.code||error.message);}
    finally{flushing=false;}};
  const flusher=setInterval(()=>{flush();},flushMs);flusher.unref();

  return {track,record,stop:async()=>{clearInterval(tick);clearInterval(flusher);delay.disable();observer?.disconnect();process.off('message',fromProxy);await flush();}};
}

module.exports={start,route,cgroup};
