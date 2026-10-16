'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('native creation contracts distinguish new names from search queries while preserving canonical and durable legacy inputs',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Creation reviewer',businessName:'Creation contracts',email:randomUUID()+'@example.test',password:'Creation!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},goals=require('../../src/assistant/postgres-goal-store');
 const name='Aluminium bracket “North / 7” '+randomUUID().slice(0,8),code='NAME-'+randomUUID().slice(0,8).toUpperCase(),goal=`Prepare a quantity product with the display name ${name} and code ${code}. Require my approval.`;
 const held=await goals.claim(db,ctx,(await goals.create(db,ctx,goal)).id),gateway=require('../../scripts/environment-agent-demo/gateway').createGateway({database:db,ctx,goal,goalId:held.id,runToken:held.run_token,provider:{complete:async()=>{throw Error('NO_MODEL_CALLS');}}});
 const names=['catalog.create_item','location.create'],discovered=await gateway.interfaces({names});
 const item=discovered.operations.find(c=>c.name===names[0]),location=discovered.operations.find(c=>c.name===names[1]);
 assert.deepEqual(item.required,['itemName'],'The recorded failure exposed generic search as the new product name');assert(item.fields.itemName);assert(!item.fields.search);assert.deepEqual(location.required,['locationName']);assert(location.fields.locationName);
 const step=arguments_=>({capability:'catalog.create_item',arguments:arguments_,dependsOn:[]});
 const created=await gateway.operate({steps:[step([{name:'itemName',value:name},{name:'baseCode',value:code}])]});assert.equal(created.outcomes[0].result.status,'PREPARED');
 const proposal=(await db.query('SELECT payload,status FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,created.outcomes[0].result.proposal.id])).rows[0];assert.equal(proposal.payload.name,name);assert.equal(proposal.payload.baseCode,code);assert.equal(proposal.status,'PENDING');
 const before=Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
 await assert.rejects(gateway.operate({steps:[step([{name:'itemName',value:name},{name:'search',value:goal},{name:'baseCode',value:code}])]}),/duplicate field/);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),before);
 const legacy=await gateway.operate({steps:[step([{name:'search',value:name+' legacy'},{name:'baseCode',value:code+'-L'}])]});assert.equal(legacy.outcomes[0].result.status,'PREPARED');
 const place='East mezzanine '+randomUUID().slice(0,8),warehouse=await gateway.operate({steps:[{capability:'location.create',arguments:[{name:'locationName',value:place}],dependsOn:[]}]});assert.equal(warehouse.outcomes[0].result.status,'PREPARED');assert.equal((await db.query('SELECT payload FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,warehouse.outcomes[0].result.proposal.id])).rows[0].payload.name,place);
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM items WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);assert.equal(Number((await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),0);
 assert.equal((await goals.get(db,ctx,held.id)).original_request,goal);assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');
 t.diagnostic(JSON.stringify({clearNativeNameContracts:true,exactValuesPreserved:true,canonicalEnginesUnchanged:true,legacyInputsSupported:true,conflictingAliasesRejectedBeforeEffects:true,approvalRequired:true,executedEffects:0,modelCalls:0}));
});
