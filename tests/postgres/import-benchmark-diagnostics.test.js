'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('stock diagnostics capture Node samples and PostgreSQL calls from independently leased connections in a private fixture',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster({trackFunctions:'all'}),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:2});
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-import-diagnostics-'));
 t.after(async()=>{await db.close();await cluster.stop();fs.rmSync(directory,{recursive:true,force:true});});
 const setting=(await db.query('SHOW track_functions')).rows[0].track_functions;
 assert.equal(setting,'all');
 await db.query(`CREATE FUNCTION stockchief_diagnostic_fixture(n int) RETURNS int LANGUAGE plpgsql AS $$BEGIN RETURN n+1;END$$`);
 const trace=await require('../helpers/import-benchmark-diagnostics').start(db,directory,'copy');t.after(trace.cancel);
 await db.withSessionLock('diagnostic-fixture',async leased=>{
  // Keep the first connection leased while the pool uses a different one.
  await leased.query('SELECT sum(stockchief_diagnostic_fixture(n)) FROM generate_series(1,1000)n');
  await leased.query('SELECT pg_stat_force_next_flush()');
  await db.query('SELECT pg_stat_force_next_flush()');
 });
 const until=performance.now()+30;let sum=0;while(performance.now()<until)sum+=Math.sqrt(sum+1);assert(sum>0);
 const result=await trace.finish();
 assert.equal(Number(result.databaseFunctions.find(f=>f.funcname==='stockchief_diagnostic_fixture')?.calls),1000);
 assert(result.nodeHotFrames.length>0);
 assert(JSON.parse(fs.readFileSync(path.join(directory,'copy.cpuprofile'),'utf8')).samples.length>0);
 await assert.rejects(trace.finish(),/already stopped/);
 // Tracking belongs only to the disposable server's startup flags. The
 // diagnostics never mutate its settings or a persisted configuration file.
 const other=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:1});
 try{assert.equal((await other.query('SHOW track_functions')).rows[0].track_functions,'all');}finally{await other.close();}
});
