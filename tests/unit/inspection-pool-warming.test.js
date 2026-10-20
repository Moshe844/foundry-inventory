'use strict';process.env.NODE_ENV='test';const test=require('node:test'),assert=require('node:assert/strict');
test('background warming cannot evict a recent business renderer and real acquisitions retain fresh authorization',async t=>{
 const pilot=require('../../src/assistant/postgres-codex-pilot'),inspection=require('../../scripts/environment-agent-demo/inspection'),created=[],closed=[],accesses=[];let revoked=false;
 t.mock.method(pilot,'access',async(db,ctx)=>{accesses.push(ctx.actorId);if(revoked&&ctx.actorId==='actor-a')throw Error('revoked');});t.mock.method(pilot,'readAuthorization',async()=>({hostOnly:true}));t.mock.method(inspection,'createInspectionServer',async({ctx})=>{const server={actor:ctx.actorId,async close(){closed.push(ctx.actorId);}};created.push(server);return server;});
 const pool=require('../../scripts/environment-agent-demo/inspection-pool').createPool({maxEntries:2});t.after(()=>pool.close());const options=actorId=>({database:{},ctx:{workspaceId:'tenant-'+actorId,actorId},connectionString:'fixture-host'});
 const first=await pool.acquire(options('actor-a'));await first.release();assert.equal(await pool.warm(options('actor-b')),true);assert.equal(await pool.warm(options('actor-c')),false);assert.deepEqual(closed,[]);assert.equal(created.length,2);
 const reused=await pool.acquire(options('actor-a'));assert.equal(reused.server,first.server);const actual=await pool.acquire(options('actor-c'));assert.deepEqual(closed,['actor-b']);assert.equal(actual.server.actor,'actor-c');await actual.release();await reused.release();
 revoked=true;await assert.rejects(pool.acquire(options('actor-a')),/revoked/);assert(accesses.filter(id=>id==='actor-a').length>=3,'Cached renderers never cache an authority decision');assert.equal(created.length,3);
});
