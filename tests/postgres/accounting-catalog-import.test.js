'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
test('accounting catalogue imports use canonical inventory without granting accounting posting authority',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 t.after(async()=>{await db.close();await cluster.stop();});
 const auth=require('../../src/domain/postgres-auth-service'),sync=require('../../src/connections/postgres-provider-sync'),catalog=require('../../src/connections/postgres-catalog-import'),shape=require('../../src/connections/accounting-catalog');
 for(const type of ['quickbooks','xero']){
  const owner=await auth.createBusiness(db,{name:'Owner',businessName:type+' catalogue',email:randomUUID()+'@example.test',password:'Test!'+randomUUID()}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},id=randomUUID(),at=new Date().toISOString();
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
   VALUES($1,$2,$1,'Accounting fixture',$3,'connected','["accounting:read"]','[]','{}',360,'AUTHORITY_REQUIRED',$4,$5,$5)`,[id,ctx.workspaceId,type,ctx.actorId,at]);
  const connection=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  await db.transaction(async c=>{for(const row of [shape.location('organization','Fixture company'),shape.product({id:'product',code:'F-1',name:'Fixture inventory',currency:'JPY',price:0,tracked:true,quantity:7,locationId:'organization'})])await sync.cacheRecord(c,connection,row);});
  await assert.rejects(catalog.importProducts(db,ctx,id,{externalIds:['product'],includeOpening:true}),/Match every location/);
  await catalog.createLocation(db,ctx,id,{externalId:'organization'});
  const result=await catalog.importProducts(db,ctx,id,{externalIds:['product'],includeOpening:true});assert.equal(result.openingUnits,7);
  assert((await catalog.importProducts(db,ctx,id,{externalIds:['product'],includeOpening:true})).replayed);
  const after=(await db.query('SELECT setup_status,capabilities FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,id])).rows[0];
  assert.equal(after.setup_status,'AUTHORITY_REQUIRED');assert.deepEqual(JSON.parse(after.capabilities),['accounting:read']);
  assert.equal((await db.query('SELECT kind FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].kind,'other');
  assert.equal((await db.query('SELECT sum(on_hand) AS n FROM balances WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'7');
  const price=(await db.query('SELECT amount_minor,currency FROM sku_prices WHERE workspace_id=$1',[ctx.workspaceId])).rows[0];assert.equal(Number(price.amount_minor),0);assert.equal(price.currency,'JPY');
  assert.equal((await db.query('SELECT count(*) AS n FROM accounting_journal_entries WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,'0');
  await assert.rejects(catalog.describe(db,{...ctx,workspaceId:'another-business'},id),/not in this business/);
 }
});
