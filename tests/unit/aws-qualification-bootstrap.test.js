'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{bootstrap,settings}=require('../../src/imports/aws-qualification-bootstrap');
const host='qualification.fake123.us-east-2.rds.amazonaws.com',env={STOCKCHIEF_IMPORT_DATABASE_HOST:host,STOCKCHIEF_IMPORT_DATABASE_NAME:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_ROLE:'stockchief_qualification',STOCKCHIEF_IMPORT_DATABASE_SECRET:JSON.stringify({username:'stockchief_qualification',password:'fake-qualification-only',dbname:'stockchief_qualification'}),STOCKCHIEF_QUALIFICATION_MASTER_SECRET:JSON.stringify({username:'sc_database_owner',password:'fake-master-only%'}),STOCKCHIEF_QUALIFICATION_OWNER:'stockchief-qualification-active',STOCKCHIEF_QUALIFICATION_COMMIT:'169c58ef8cf9a4693eb16988d2f8d8f39927b59e'};
test('bootstrap rejects wrong roles/endpoints and preserves encoded owner passwords',()=>{
 const s=settings(env);assert.equal(s.master.hostname,host);assert.equal(s.master.pathname,'/postgres');assert.equal(decodeURIComponent(s.master.password),'fake-master-only%');
 assert.throws(()=>settings({...env,STOCKCHIEF_IMPORT_DATABASE_ROLE:'stockchief_runtime'}),/synthetic qualification role/);
 assert.throws(()=>settings({...env,STOCKCHIEF_QUALIFICATION_MASTER_SECRET:JSON.stringify({username:'sc_database_owner',password:'fake-secret',host:'substituted.example.test'})}),/approved database owner/);
 assert.throws(()=>settings({...env,STOCKCHIEF_MIGRATION_DATABASE_NAME:'stockchief_qualification'}),/must be separate/);
});
test('an existing customer database stops bootstrap before any role, permission or schema writes',async()=>{
 const statements=[],closed=[];
 const open=url=>({query:async sql=>{statements.push(sql);return {rows:[{n:1}],rowCount:1};},close:async()=>closed.push(new URL(url).pathname)});
 await assert.rejects(bootstrap(env,{open,migrate:()=>{throw Error('must not migrate');}}),/customer restore database is not empty/);
 assert.equal(statements.length,1);assert.match(statements[0],/^SELECT/);assert.equal(closed.length,2);
});
