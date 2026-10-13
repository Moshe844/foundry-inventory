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
 let browserReads=0;
 const tools=require('../../scripts/environment-agent-demo/candidates').sharedTools({gateway,session,browser:{act:async()=>{browserReads++;return {url:'http://isolated/',text:'Observed records'};}},sandbox:{}});
 queries=0;await tools.find(t=>t.name==='environment_browser').execute({action:'inspect',ref:null,value:null});const browserQueries=queries;
 assert(calls.every(c=>c.catalogue===false),'Real shared browser tool path avoids every full catalogue rebuild');
 assert(browserQueries<fullQueries,JSON.stringify({fullQueries,lightQueries,browserQueries}));
 const visual={image:{data:'offline-only',mimeType:'image/png'},screen:{url:'http://isolated/',text:'Complete observed inventory'}};
 await session.execute('environment_browser',{action:'visual'},async()=>visual);
 const shown=await session.present(visual,{full:true});assert.equal(shown.screen._stockchiefEvidence.valuePointerPrefix,'/screen');
 const saved=await session.load();assert.equal(JSON.parse(saved.evidence[shown.screen._stockchiefEvidence.evidenceId].text).screen.text,visual.screen.text);
 assert.equal(shown.screen._stockchiefEvidence.complete,true);
 // Historical sessions stored the screen alone. The reference must describe
 // that persisted value, rather than the newer image wrapper presented now.
 const legacy={...visual,screen:{url:'http://isolated/earlier',text:'Earlier observed inventory'}};
 await session.execute('environment_browser',{action:'legacy'},async()=>legacy.screen);
 assert.equal((await session.present(legacy,{full:true})).screen._stockchiefEvidence.valuePointerPrefix,'');
 assert.equal((await session.present(legacy.screen,{full:true}))._stockchiefEvidence.valuePointerPrefix,'');
 queries=0;await tools.find(t=>t.name==='environment_interfaces').execute({search:'policy',names:[],offset:0});const interfaceQueries=queries;
 assert(interfaceQueries<fullQueries*2,'Interface discovery builds one fresh catalogue, not three');
 await session.execute('business_operations',{stepsJson:JSON.stringify([{capability:'read.operating_rules',arguments:[],dependsOn:[]}])},async()=>({outcomes:[]}));
 assert(calls.some(c=>c.catalogue===true),'Business operations retain fresh catalogue validation');
 t.diagnostic(JSON.stringify({fullQueries,lightQueries,browserQueries,interfaceQueries}));
 await db.query("UPDATE users SET permissions='{}'::jsonb,role='member' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);
 await assert.rejects(session.load(),/SESSION_AUTHORITY_CHANGED/);
 const beforeReads=browserReads;
 await assert.rejects(tools.find(t=>t.name==='environment_browser').execute({action:'inspect',ref:null,value:null}),/SESSION_AUTHORITY_CHANGED/);
 assert.equal(browserReads,beforeReads,'Revoked authority fails before browser inspection even without the redundant wrapper check');
 await store.cancel(db,ctx,goal.id);
 await assert.rejects(gateway.authorize({catalogue:false}),/not held/);
});
