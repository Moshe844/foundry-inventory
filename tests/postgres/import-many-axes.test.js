'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('native import preserves 32 explicit option axes and distinguishes values beyond the third axis',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});await require('../../src/db/migrate-postgres').migratePostgres(db);
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Many axes',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId};
 const options=Array.from({length:32},(_,i)=>'Option '+(i+1)),values=Array.from({length:32},(_,i)=>'Value '+(i+1));
 const csv=[['Product','SKU',...options,'Location','Quantity'].join(','),['Configured motor','AXIS-A',...values,'Shelf','2'].join(','),['Configured motor','AXIS-B',...values.slice(0,31),'Different final option','Shelf','3'].join(',')].join('\n');
 const service=require('../../src/imports/postgres-service'),plan=await service.analyse(db,ctx,{text:csv,allowModel:false});assert.equal(plan.recordsValid,2);
 await service.approve(db,ctx,plan.id,plan.integrityHash);const result=await service.execute(db,ctx,plan.id);assert(result.verified);assert.equal(result.skusCreated,2);assert.equal(result.itemsCreated,1);
 assert.equal(Number((await db.query('SELECT count(*) n FROM item_options WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n),32);
 const last=(await db.query(`SELECT s.code,sv.value FROM skus s JOIN sku_option_values sv ON sv.sku_id=s.id
  JOIN item_options o ON o.id=sv.option_id
  WHERE s.workspace_id=$1 AND o.name='Option 32' ORDER BY s.code`,[ctx.workspaceId])).rows;
 assert.deepEqual(last,[{code:'AXIS-A',value:'Value 32'},{code:'AXIS-B',value:'Different final option'}]);
 assert((await service.execute(db,ctx,plan.id)).duplicate);
});
