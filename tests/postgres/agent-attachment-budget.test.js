'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('pilot attachment previews cannot invoke legacy unmetered mapping models',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Upload owner',businessName:'Upload business',email:randomUUID()+'@example.test',password:'Upload!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 let calls=0;
 const plan=await require('../../src/imports/postgres-service').analyse(db,ctx,{text:'col_a,col_b,col_c\nUnfamiliar sleeve,6,Unknown shelf\nUnfamiliar plate,3,Unknown shelf',filename:'unfamiliar-columns.csv',allowModel:false,provider:{name:'openai',model:'gpt-6.1-sol',complete:async()=>{calls++;throw Error('UNAPPROVED_PROVIDER_CALL');}}});
 assert.equal(calls,0);assert.equal(plan.approvalStatus,'AWAITING_APPROVAL');assert.equal(plan.recordsDetected,2);
 assert.equal((await db.query('SELECT count(*) AS n FROM movements WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
 assert.equal((await db.query('SELECT count(*) AS n FROM stockchief_runtime.codex_pilot_calls')).rows[0].n,'0');
});
