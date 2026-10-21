'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
test('concurrent token reads share one current grant and server misconfiguration never revokes customer consent',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 await require('../../src/db/migrate-postgres').migratePostgres(db);t.after(async()=>{await db.close();await cluster.stop();});
 const owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Refresh serialization',email:crypto.randomUUID()+'@example.test',password:'Test!'+crypto.randomUUID()});
 const id=crypto.randomUUID(),at=new Date().toISOString(),store=require('../../src/connections/postgres-credential-store'),service=require('../../src/connections/postgres-provider-service');
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
 expected_interval_minutes,setup_status,credential_ref,authorized_by_user_id,created_at,updated_at)
 VALUES($1,$2,$1,'Refresh fixture','clover','connected','[]','[]','{}',1,'CONNECTED',$3,$4,$5,$5)`,[id,owner.workspaceId,'connection_credentials:'+id,owner.userId,at]);
 await store.put(db,owner.workspaceId,id,'provider',{accessToken:'old',refreshToken:'single-use-old',generation:0});
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,id])).rows[0];
 let rotations=0,configured=true,rejected=false;
 const adapter={metadata:()=>({available:configured}),async refreshCredentials(value){
  if(rejected)throw Object.assign(new Error('Private provider rejection'),{status:401});
  if(value.generation===1)return {credentials:value,refreshed:false};
  assert.equal(value.refreshToken,'single-use-old');rotations++;await new Promise(r=>setTimeout(r,80));
  return {credentials:{accessToken:'new',refreshToken:'single-use-new',generation:1},refreshed:true};}};
 const results=await Promise.all(Array.from({length:8},()=>service.loadProviderCredentials(db,connection,adapter)));
 assert.equal(rotations,1,'a single-use token must not rotate eight times');assert(results.every(r=>r.refreshToken==='single-use-new'));
 assert.equal((await store.get(db,owner.workspaceId,id,'provider')).generation,1);
 configured=false;await assert.rejects(service.loadProviderCredentials(db,connection,adapter),e=>e.code==='PROVIDER_CONFIGURATION_REQUIRED');
 let current=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,id])).rows[0];
 assert.equal(current.status,'connected');assert.equal(current.setup_status,'CONNECTED');assert.match(current.last_error,/configuration/);assert.equal(rotations,1);
 configured=true;rejected=true;await assert.rejects(service.loadProviderCredentials(db,connection,adapter),e=>e.status===401);
 current=(await db.query('SELECT * FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,id])).rows[0];
 assert.equal(current.setup_status,'REAUTHORIZATION_REQUIRED');assert(!current.last_error.includes('Private'));
 await db.query("UPDATE workspace_connectors SET status='disconnected',setup_status='DISCONNECTED' WHERE workspace_id=$1 AND id=$2",[owner.workspaceId,id]);
 await assert.rejects(service.loadProviderCredentials(db,connection,adapter),/Reconnect/);
 assert.equal((await db.query('SELECT status FROM workspace_connectors WHERE workspace_id=$1 AND id=$2',[owner.workspaceId,id])).rows[0].status,'disconnected','stale work cannot resurrect a disconnected grant');
});
