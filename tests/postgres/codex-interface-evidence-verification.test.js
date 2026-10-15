'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('actual recorded interface claims revalidate through the same current catalogue and lossless tool codec',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Metadata verifier',businessName:'Offline',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store');
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,'Investigate business prerequisites without changing anything.')).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 const session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 const verify=require('../../src/assistant/postgres-codex-verification').verify,fixture=require('../fixtures/codex-interface-verification.json');
 const catalogue=(await gateway.authorize()).catalogue;
 let total=0;
 for(const observed of fixture.observations){
  const input={search:'',offset:0,names:observed.selection.names};
  const output=await session.executePresented('environment_interfaces',input,()=>gateway.interfaces(input),{full:true});
  const current=await store.get(db,ctx,goal.id),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='environment_interfaces');
  assert(entry.sourceText&&entry.sourceSha256,'Interface source is now durably reconstructible');
  const claims=observed.claims.map(c=>({...c,evidenceId:entry.id}));
  const report={status:'completed',outcome:'answer',answer:'Observed workflow prerequisites.',claims};
  assert.equal((await verify(db,ctx,current,JSON.stringify(report),catalogue)).verified,true,'Exact real-model claims verify on the current interface definitions');
  delete entry.sourceText;delete entry.sourceSha256;
  assert.equal((await verify(db,ctx,current,JSON.stringify(report),catalogue)).verified,true,'Recorded exact-name legacy evidence remains safely retrievable');
  const original=JSON.parse(entry.text),firstName=original.operations[0].name;
  const removed={list:()=>catalogue.list().filter(c=>c.name!==firstName),get:name=>name===firstName?null:catalogue.get(name)};
  assert.equal((await verify(db,ctx,current,JSON.stringify(report),removed)).verified,false,'Removed authority/contract cannot be verified using an old description');
  const codec=require('../../scripts/environment-agent-demo/evidence-presentation'),wire=codec.project(entry.name,original);
  for(const [key,value]of Object.entries(wire._stockchiefDefinitions||{})){
   const c={evidenceId:entry.id,path:'/_stockchiefDefinitions/'+key,value};
   assert.equal((await verify(db,ctx,current,JSON.stringify({...report,claims:[c]}),catalogue)).verified,true,'Exact lossless wire definitions are valid evidence, not invented object subsets');
   break;
  }
  assert.equal(output._stockchiefEvidence.evidenceId,entry.id);total+=claims.length;
 }
 const input={search:'inventory',offset:1,names:[]};
 await session.execute('environment_interfaces',input,()=>gateway.interfaces(input));
 const current=await store.get(db,ctx,goal.id),entry=Object.values(current.checkpoint.harness.evidence).findLast(e=>e.name==='environment_interfaces');
 const fresh=await require('../../src/assistant/agent-evidence-verification').current(db,ctx,current,entry,{catalogue});
 assert.deepEqual(fresh,JSON.parse(entry.text),'New source preserves the exact pagination offset');
 delete entry.sourceText;delete entry.sourceSha256;
 await assert.rejects(require('../../src/assistant/agent-evidence-verification').current(db,ctx,current,entry,{catalogue}),/CURRENT_EVIDENCE_REQUIRED/,'Missing legacy search offset must never be guessed');
 // The other host metadata source is the authorized environment supplied at
 // startup. Business identity/role must be rechecked too, not treated as an
 // unsupported source or accepted indefinitely after the workspace changes.
 const contextSession=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:async settings=>({...await gateway.authorize(settings),environment:{business:{name:'Offline'},actor:{role:'owner'},clock:{utc:new Date().toISOString()}}})});
 const loaded=await contextSession.load(),environmentId=loaded.goalContext.environment._stockchiefEvidence.evidenceId;
 const identityGoal=await store.get(db,ctx,goal.id),identityReport={status:'completed',outcome:'answer',answer:'Business identity confirmed.',claims:[{evidenceId:environmentId,path:'/business/name',value:'Offline'}]};
 assert.equal((await verify(db,ctx,identityGoal,JSON.stringify(identityReport),catalogue)).verified,true);
 await db.query('UPDATE workspaces SET name=$2 WHERE id=$1',[ctx.workspaceId,'Changed business']);
 assert.equal((await verify(db,ctx,identityGoal,JSON.stringify(identityReport),catalogue)).verified,false);
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({exactRecordedClaims:total,paidCalls:0,businessWrites:0,missingProvenanceRejected:true}));
});
