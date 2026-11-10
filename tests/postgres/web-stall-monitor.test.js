'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{once}=require('node:events');

// The stall recorder must name a pause, what was in flight during it, and the
// proxy's own reports, without recording identifiers from the address.
test('a server pause is recorded with what was in flight, and proxy reports arrive too',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const monitor=require('../../src/operations/web-stall-monitor').start(db,{enabled:true,summaryMs:1500,flushMs:200});
 // A request is in flight on an address carrying an identifier when the process stops for 900 ms.
 const res=new (require('node:events'))();let resumed=false;
 monitor.track({method:'GET',originalUrl:'/orders/so_d7urtnf7n0f22ocki4t2b3gw?tab=money'},res,()=>{resumed=true;});assert(resumed);
 await new Promise(r=>setTimeout(r,400));const stop=Date.now()+900;while(Date.now()<stop){}
 await new Promise(r=>setTimeout(r,600));res.emit('finish');
 process.emit('message',{type:'stockchief.guardian.stall',kind:'slow_answer',ms:2400,detail:{route:'GET /privacy',status:200}});
 await new Promise(r=>setTimeout(r,2200));await monitor.stop();
 const rows=(await db.query('SELECT source,kind,duration_ms,detail FROM stockchief_runtime.web_stalls ORDER BY observed_at')).rows;
 const pause=rows.find(r=>r.kind==='event_loop');
 assert(pause,'the pause was recorded: '+JSON.stringify(rows.map(r=>r.kind)));
 assert(pause.duration_ms>=600,'it measured the pause: '+pause.duration_ms);
 assert.deepEqual(pause.detail.inflight.map(r=>r.route),['GET /orders/:id'],'it names the request in flight without its identifier');
 assert(pause.detail.memory.rssMb>0);
 assert(rows.some(r=>r.source==='proxy'&&r.kind==='slow_answer'&&r.duration_ms===2400),'the proxy report was recorded');
 assert(rows.some(r=>r.kind==='summary'&&typeof r.detail.cpuPercentOfOneCore==='number'),'a summary was recorded');
});
