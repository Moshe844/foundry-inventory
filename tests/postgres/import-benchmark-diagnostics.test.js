'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');

test('stock diagnostics capture real Node samples and PostgreSQL function calls without altering server configuration',async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:1});
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'stockchief-import-diagnostics-'));
 t.after(async()=>{await db.close();await cluster.stop();fs.rmSync(directory,{recursive:true,force:true});});
 const setting=(await db.query('SHOW track_functions')).rows[0].track_functions;
 assert.equal(setting,'none');
 await db.query(`CREATE FUNCTION stockchief_diagnostic_fixture(n int) RETURNS int LANGUAGE plpgsql AS $$BEGIN RETURN n+1;END$$`);
 const trace=await require('../helpers/import-benchmark-diagnostics').start(db,directory,'copy');t.after(trace.cancel);
 await db.query('SELECT sum(stockchief_diagnostic_fixture(n)) FROM generate_series(1,1000)n');
 const until=performance.now()+30;let sum=0;while(performance.now()<until)sum+=Math.sqrt(sum+1);assert(sum>0);
 const result=await trace.finish();
 assert.equal(Number(result.databaseFunctions.find(f=>f.funcname==='stockchief_diagnostic_fixture')?.calls),1000);
 assert(result.nodeHotFrames.length>0);
 assert(JSON.parse(fs.readFileSync(path.join(directory,'copy.cpuprofile'),'utf8')).samples.length>0);
 await assert.rejects(trace.finish(),/already stopped/);
 // A new connection retains the server default: tracking changed one test
 // session, not postgresql.conf, the database, the role or other sessions.
 const other=require('../../src/db/postgres').openPostgres(cluster.connectionString,{max:1});
 try{assert.equal((await other.query('SHOW track_functions')).rows[0].track_functions,'none');}finally{await other.close();}
});
