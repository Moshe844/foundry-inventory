'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('verified single-attempt transport reserves its full request bound without changing ceilings or old holds',{timeout:90000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);await require('../../src/db/migrate-postgres').migratePostgres(db);t.after(async()=>{await db.close();await cluster.stop();});
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Transport bound',email:randomUUID()+'@example.test',password:randomUUID()}),scope={accountId:owner.accountId,workspaceId:owner.workspaceId},policy=require('../../src/commercial/model').POLICIES.import_mapping,budget=require('../../src/commercial/model-cost-budget'),provider=require('../../src/ai/providers/anthropic').create({apiKey:'fixture-not-real',model:'claude-haiku-4-5-20251001',effort:'none'}),request={system:'Unfamiliar workbook source contract',prompt:'Source evidence '.repeat(200),schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},maxOutputTokens:3000};
 const priorLimit=budget.operationLimit('import_mapping');assert.equal(priorLimit,.30);
 const old=await budget.reserve(db,scope,{name:provider.name,model:provider.model},request,policy,'import_mapping','unregistered-conservative');
 const held=await budget.reserve(db,scope,provider,request,policy,'import_mapping','registered-single');
 const rows=(await db.query('SELECT idempotency_key,maximum_minor,detail FROM commercial_model_cost_holds WHERE workspace_id=$1 ORDER BY idempotency_key',[scope.workspaceId])).rows,one=rows.find(x=>x.idempotency_key==='registered-single'),three=rows.find(x=>x.idempotency_key==='unregistered-conservative');
 assert.equal(one.detail.providerExecutions,1);assert.equal(three.detail.providerExecutions,3);assert(Number(one.maximum_minor)>0&&Number(one.maximum_minor)<=30);assert(Number(three.maximum_minor)>=Number(one.maximum_minor)*3-.000003);assert.equal(budget.operationLimit('import_mapping'),priorLimit);
 assert(await budget.promptByteAllowance(db,provider,request,'import_mapping')>await budget.promptByteAllowance(db,{name:provider.name,model:provider.model},request,'import_mapping'));
 const still=(await db.query("SELECT status,maximum_minor FROM commercial_model_cost_holds WHERE workspace_id=$1 AND idempotency_key='unregistered-conservative'",[scope.workspaceId])).rows[0];assert.equal(still.status,'RESERVED');assert.equal(still.maximum_minor,three.maximum_minor,'No historical hold is discounted or released');
 assert(old&&held);
});
