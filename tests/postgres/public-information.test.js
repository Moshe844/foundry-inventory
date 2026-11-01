'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('security, status, API documentation and later roadmap are public and linked',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),app=require('../../src/postgres-app').createPostgresApp({database:f.db,env:'test',sessionSecret:'public-information-fixture'}),server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});
 f.cleanup(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await app.locals.sessionStore.close();});const base='http://127.0.0.1:'+server.address().port;
 for(const [path,expected] of [['/security','SOC 2'],['/status','Web and database responding'],['/api/docs','Idempotency-Key'],['/roadmap','QuickBooks and Xero']]){const response=await fetch(base+path);assert.equal(response.status,200,path);const body=await response.text();assert(body.includes(expected),path);for(const link of ['/security','/status','/api/docs','/roadmap'])assert(body.includes('href="'+link+'"'));}
});
