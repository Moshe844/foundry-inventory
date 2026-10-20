'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('structured native dataset queries retain canonical aggregation, evidence sources, legacy calls and tenant boundaries',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),owner=await auth.createBusiness(db,{name:'Query owner',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),other=await auth.createBusiness(db,{name:'Other owner',businessName:randomUUID(),email:randomUUID()+'@example.test',password:'Fixture!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const catalog=require('../../src/domain/postgres-catalog-service');for(let i=0;i<7;i++){const item=await catalog.createItem(db,ctx,{name:randomUUID(),baseCode:randomUUID(),trackingMode:'quantity'});if(i>3)await db.query('UPDATE items SET is_active=0 WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,item.itemId]);}
 await catalog.createItem(db,{workspaceId:other.workspaceId,actorId:other.userId},{name:randomUUID(),baseCode:randomUUID(),trackingMode:'quantity'});
 const store=require('../../src/assistant/postgres-goal-store'),goal=await store.claim(db,ctx,(await store.create(db,ctx,'Inspect the business records without changing them.')).id),gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal:goal.original_request,goalId:goal.id,runToken:goal.run_token}),session=require('../../scripts/environment-agent-demo/session').createSession({database:db,ctx,goalId:goal.id,runToken:goal.run_token,candidate:'codex',authorize:settings=>gateway.authorize(settings)});
 const tool=require('../../scripts/environment-agent-demo/candidates').sharedTools({gateway,session,browser:{},sandbox:{}}).find(t=>t.name==='environment_dataset');
 const spec={dataset:'catalogue',summary:true,aggregate:'count',filters:[{field:'product_status',operator:'equals',value:'active'},{field:'variant_status',operator:'equals',value:'active'}]};
 const result=await tool.execute(tool.schema.parse({spec,offset:0}));assert.equal(result.rows[0].count,'4');assert.equal(result.hasMore,false);assert.equal(result.extent.complete,true);
 const state=await session.load(),entry=Object.values(state.evidence).find(e=>e.name==='environment_dataset');assert.deepEqual(JSON.parse(entry.sourceText).input.spec,spec);
 const current=await require('../../src/assistant/agent-evidence-verification').current(db,ctx,goal,entry);assert.equal(current.rows[0].count,'4','Structured input is freshly replayed by the existing verifier');
 const legacy=await tool.execute(tool.schema.parse({specJson:JSON.stringify(spec),offset:0}));assert.equal(legacy.rows[0].count,'4');
 const mixed=await tool.execute({spec,specJson:JSON.stringify(spec),offset:0});assert.equal(mixed.error.code,'TOOL_CONTRACT_INVALID');
 const invalid=await tool.execute({spec:{dataset:'catalogue',summary:true,filters:[{field:'password',operator:'equals',value:'x'}]},offset:0});assert.equal(invalid.error.code,'TOOL_CONTRACT_INVALID');
 assert.throws(()=>tool.schema.parse({spec:{dataset:'catalogue',filters:[{field:'status',operator:'execute_sql',value:'x'}]},offset:0}));
 const money=await tool.execute({spec:{dataset:'inventory_valuation',summary:true,aggregate:'sum',measure:'book_cost_minor'},offset:0});assert.equal(money.error.code,'TOOL_CONTRACT_INVALID','Typed tools retain the exact-currency rule');
 const catalogue=await gateway.authorize();assert.equal(require('../../src/reports/postgres-service').queryContract('catalogue',catalogue.actor).schema.properties.filters.items.properties.operator.enum.join(','),require('../../src/reports/postgres-service').querySyntax.operators.join(','));
 await db.query("UPDATE users SET role='member',permissions='{}'::jsonb WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,ctx.actorId]);await assert.rejects(tool.execute({spec,offset:0}),/SESSION_AUTHORITY_CHANGED/);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 t.diagnostic(JSON.stringify({canonicalCompleteAggregate:true,typedEvidenceFreshlyVerified:true,legacyReadable:true,currencyGuard:true,tenantIsolation:true,permissionRevocation:true,paidCalls:0}));
});
