'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('recorded warning investigation verifies JSON wire values and still rejects actual rule or timestamp changes',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Wire reviewer',businessName:'Wire evidence',email:randomUUID()+'@example.test',password:'Offline!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const item=await require('../../src/domain/postgres-catalog-service').createItem(db,ctx,{name:'Unfamiliar product '+randomUUID(),baseCode:'WIRE-'+randomUUID().slice(0,8),trackingMode:'quantity'}),ruleId=randomUUID();
 // Exact live failure: the PostgreSQL timestamp is a Date, while the native
 // agent and durable journal receive its JSON string. No scenario is added
 // to the runtime and no model or business authorization is simulated here.
 await db.query(`INSERT INTO stockchief_runtime.stock_threshold_rules
  (id,workspace_id,sku_id,threshold,metric,comparator,armed,stated_as,approved_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,10,'on_hand','at_or_below',false,'Local verification fixture',$4,$5,$5)`,[ruleId,ctx.workspaceId,item.skuIds[0],ctx.actorId,'2026-10-15T15:04:22.247Z']);
 assert((await db.query('SELECT updated_at FROM stockchief_runtime.stock_threshold_rules WHERE id=$1',[ruleId])).rows[0].updated_at instanceof Date);
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,ctx,(await store.create(db,ctx,'Do any current stock warnings duplicate the same rule and product? Explain the actual evidence.')).id);
 const gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token}),session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:gateway.authorize});
 const steps=[{capability:'read.operating_rules',arguments:[],dependsOn:[]},{capability:'read.needs_you',arguments:[],dependsOn:[]}];
 await session.execute('business_operations',{steps},callId=>gateway.operate({steps,callId}));
 const saved=await store.get(db,ctx,goal.id),entry=Object.values(saved.checkpoint.harness.evidence).find(e=>e.name==='business_operations'),wire=JSON.parse(entry.text),catalogue=(await gateway.authorize()).catalogue;
 assert.equal(typeof wire.outcomes[0].result.rows[0].updatedAt,'string');
 const report={version:1,status:'completed',outcome:'answer',answer:'The current approved stock warning is waiting to re-arm.',claims:[1,0].map(i=>({evidenceId:entry.id,path:'/outcomes/'+i+'/result/rows',value:wire.outcomes[i].result.rows}))};
 const before=(await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,verify=()=>require('../../src/assistant/postgres-codex-verification').verify(db,ctx,saved,JSON.stringify(report),catalogue);
 assert.equal((await verify()).verified,true,'Identical current timestamps must not become CURRENT_RECORDS_CHANGED solely because the driver returns Date objects');
 await db.query("UPDATE stockchief_runtime.stock_threshold_rules SET updated_at=updated_at+interval '1 millisecond' WHERE id=$1",[ruleId]);
 assert.equal((await verify()).verificationFailure,'CURRENT_RECORDS_CHANGED','A real timestamp change remains an exact mismatch');
 await db.query('UPDATE stockchief_runtime.stock_threshold_rules SET updated_at=$2,threshold=11 WHERE id=$1',[ruleId,'2026-10-15T15:04:22.247Z']);
 assert.equal((await verify()).verificationFailure,'CURRENT_RECORDS_CHANGED','Changing a business value cannot be hidden by an identical timestamp');
 await db.query('UPDATE stockchief_runtime.stock_threshold_rules SET threshold=10 WHERE id=$1',[ruleId]);
 assert.equal((await verify()).verified,true);
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,before,'Final verification creates no duplicate interactions');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({recordedFailurePath:'/outcomes/0/result/rows/0/updatedAt',actualDateMismatchReproduced:true,realTimestampChangesRejected:true,realBusinessChangesRejected:true,paidCalls:0}));
});
