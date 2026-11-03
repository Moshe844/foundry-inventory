'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),profile=require('../../scripts/lib/staging-import-sql-profile');
test('import SQL profiling resets only the guarded staging database and preserves cumulative evidence',async()=>{
 const calls=[],db={query:async(sql,args)=>{calls.push({sql,args});if(sql.includes('current_database() AS name'))return {rows:[{name:'stockchief_staging',oid:'42'}]};return {rows:[{queryid:'12',calls:'500',total_exec_time:1000}]};}};
 const options={connectionString:'postgres://fixture@dpg-damlkhuk1f9s739h5ga0-a/stockchief_staging',serviceId:'srv-daqh418473hc73853e7g'};
 const result=await profile.reset(db,options);assert.equal(result.previous[0].calls,'500');assert.equal(result.database,'stockchief_staging');
 const resets=calls.filter(x=>x.sql.includes('pg_stat_statements_reset'));assert.equal(resets.length,1);assert.deepEqual(resets[0],{sql:'SELECT pg_stat_statements_reset(0,$1::oid,0)',args:['42']});assert(calls.find(x=>x.sql.includes('FROM pg_stat_statements')).sql.includes('WHERE dbid='));
 for(const invalid of [{...options,serviceId:'production'},{...options,connectionString:'postgres://fixture@production/stockchief'}])await assert.rejects(profile.reset(db,invalid));
 await assert.rejects(profile.reset({query:async()=>({rows:[{name:'production',oid:'77'}]})},options),/does not match/);
 assert.equal(calls.filter(x=>x.sql.includes('pg_stat_statements_reset')).length,1);
});
