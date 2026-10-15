'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded all-time financial investigation retains its canonical query scope during side-effect-free verification',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Query scope verifier',businessName:'Offline',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()});
 const fixture=require('../fixtures/codex-read-scope-verification.json'),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},store=require('../../src/assistant/postgres-goal-store');
 const goal=await store.claim(db,ctx,(await store.create(db,ctx,fixture.request)).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token});
 const session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 const output=await session.execute('business_operations',{steps:fixture.steps},callId=>gateway.operate({steps:fixture.steps,callId}));
 const current=await store.get(db,ctx,goal.id),entry=Object.values(current.checkpoint.harness.evidence).find(e=>e.name==='business_operations'),catalogue=(await gateway.authorize()).catalogue;
 const before=(await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n;
 const fresh=await require('../../src/assistant/agent-evidence-verification').current(db,ctx,current,entry,{catalogue});
 for(let index=0;index<fixture.steps.length;index++)assert.deepEqual(fresh.outcomes[index].result.intent,output.outcomes[index].result.intent,'The same pure presentation preserves the complete typed query scope');
 const report={status:'completed',outcome:'answer',answer:'No invoices or payments are recorded.',claims:fixture.claims.map(c=>({...c,evidenceId:entry.id}))};
 assert.equal((await require('../../src/assistant/postgres-codex-verification').verify(db,ctx,current,JSON.stringify(report),catalogue)).verified,true);
 const changed=structuredClone(report);changed.claims.find(c=>c.path.endsWith('/timeframe')).value='today';
 assert.equal((await require('../../src/assistant/postgres-codex-verification').verify(db,ctx,current,JSON.stringify(changed),catalogue)).verified,false,'A claimed different query period is not inferred or silently accepted');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before,'Verification must not append another interaction');
 // Immutable delivery IDs are provenance, never business truth or access to
 // another actor/workspace. Even a constructed journal cannot borrow one.
 const forged=structuredClone(entry),body=JSON.parse(forged.text);body.outcomes[0].result.interactionId='other-workspace-interaction';forged.text=JSON.stringify(body);
 await assert.rejects(require('../../src/assistant/agent-evidence-verification').current(db,ctx,current,forged,{catalogue}),/CURRENT_READ_SCOPE_UNVERIFIED/);
 assert.equal((await db.query('SELECT count(*) AS n FROM accounting_payments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({actualRecordedClaims:fixture.claims.length,paidCalls:0,additionalInteractionsDuringVerification:0,financialWrites:0}));
});
