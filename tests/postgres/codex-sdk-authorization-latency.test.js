'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native bookkeeping avoids repeated catalogue construction while retaining fresh authority and full execution checks',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Latency test',businessName:'Latency fixture',email:randomUUID()+'@example.test',password:'Fake!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store');
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,'Investigate an unfamiliar business question.')).id);
 let queries=0;const measured={...db,query:async(...args)=>{queries++;return db.query(...args);}};
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:measured,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 queries=0;const full=await gateway.authorize(),fullQueries=queries;assert(full.catalogue.list().length);
 queries=0;const fresh=await gateway.authorize({catalogue:false}),lightQueries=queries;
 assert.deepEqual(fresh.actor,full.actor);assert.equal(fresh.catalogue,undefined);
 assert(fullQueries>lightQueries+30,JSON.stringify({fullQueries,lightQueries}));
 const calls=[];const session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:settings=>{calls.push(settings);return gateway.authorize(settings);}});
 // The live trace crossed twelve model rounds and seventeen tool rounds.
 // Repeat native checkpoint boundaries at that scale without inference.
 for(let index=0;index<17;index++){await session.load();await session.checkpoint({browserStep:index});}
 for(let index=0;index<12;index++){await session.codexRequest();await session.codexPending('round-'+index);await session.codexDelivered('round-'+index,{status:200},{terminal:false,tool:true});}
 assert(calls.every(c=>c.catalogue===false));
 await session.execute('environment_browser',{},async()=>({screen:{url:'http://isolated/',text:'Observed records'}}));
 assert(calls.some(c=>c.catalogue===true),'Tool execution still obtains the full fresh catalogue');
 await db.query("UPDATE users SET permissions='{}'::jsonb,role='member' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(session.load(),/SESSION_AUTHORITY_CHANGED/);
 await store.cancel(db,ctx,goal.id);
 await assert.rejects(gateway.authorize({catalogue:false}),/not held/);
});
