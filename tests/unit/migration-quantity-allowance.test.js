'use strict';
// Publishing runs every new migration in one transaction with a 2-minute statement
// limit. The two migrations that convert a quantity column (and can rewrite a large
// table) get 10 minutes, then the limit goes back to 2 minutes for everything after.
const test=require('node:test'),assert=require('node:assert/strict'),{migratePostgres}=require('../../src/db/migrate-postgres');
test('quantity column conversions get a bounded longer limit; every other migration keeps 2 minutes',async()=>{
 const log=[];const client={async query(sql){log.push(String(sql));return {rows:[]};}};
 await migratePostgres({transaction:async(work)=>work(client)});
 const limits=[];let limit='120000';
 for(const sql of log){const m=/set_config\('statement_timeout','(\d+)'/.exec(sql);if(m){limit=m[1];continue;}
  if(/^INSERT INTO stockchief_postgres_migrations/.test(sql))continue;
  if(/ALTER TABLE (balances|import_rows)[\s\S]*TYPE numeric|ALTER COLUMN quantity TYPE numeric/i.test(sql))limits.push(limit);}
 const applied=log.filter(sql=>/^INSERT INTO stockchief_postgres_migrations/.test(sql)).length;
 assert(applied>500,'every migration ran against the recording client');
 const raised=log.map((sql,i)=>/set_config\('statement_timeout','600000'/.test(sql)?log[i+1]:null).filter(Boolean);
 assert.equal(raised.length,2,'exactly two migrations run with the longer limit');
 assert(raised.some(sql=>sql.includes('ALTER TABLE import_rows ALTER COLUMN quantity TYPE numeric')),'547 converts import row quantities with the longer limit');
 assert.equal(log.filter(sql=>/set_config\('statement_timeout','120000'/.test(sql)).length,2,'the 2-minute limit is restored after each');
 assert(limits.length>0);
});
