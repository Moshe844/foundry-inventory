'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');

test('QuickBooks feature loss preserves imported stock, billing and authorization, then resumes when the feature returns',{timeout:180000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);
 t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const previous={};for(const key of ['QUICKBOOKS_CLIENT_ID','QUICKBOOKS_CLIENT_SECRET','QUICKBOOKS_ENVIRONMENT'])previous[key]=process.env[key];
 Object.assign(process.env,{QUICKBOOKS_CLIENT_ID:'feature-fixture',QUICKBOOKS_CLIENT_SECRET:'feature-fixture-secret',QUICKBOOKS_ENVIRONMENT:'sandbox'});
 t.after(()=>{for(const [key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const auth=require('../../src/domain/postgres-auth-service'),sync=require('../../src/connections/postgres-provider-sync');
 const catalog=require('../../src/connections/postgres-catalog-import'),shape=require('../../src/connections/accounting-catalog'),store=require('../../src/connections/postgres-credential-store');
 const owner=await auth.createBusiness(db,{name:'Feature Owner',businessName:'Feature qualification',email:randomUUID()+'@example.test',password:'Feature!'+randomUUID()});
 const ctx={workspaceId:owner.workspaceId,actorId:owner.userId,accountId:owner.accountId},id=randomUUID();
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES($1,$2,'pro',(SELECT id FROM commercial_plan_versions WHERE plan_id='pro' AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1),'ACTIVE',now(),now()+interval '1 month')",[randomUUID(),owner.accountId]);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,created_at,updated_at)
  VALUES($1,$2,$1,'Feature fixture','quickbooks','connected','["accounting:read"]','[]','{}',360,'AUTHORITY_REQUIRED',$3,'organization',now(),now())`,[id,owner.workspaceId,owner.userId]);
 const grant={realmId:'organization',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAt:new Date(Date.now()+86400000).toISOString()};
 await store.put(db,owner.workspaceId,id,'provider',grant);
 const connection=(await db.query('SELECT * FROM workspace_connectors WHERE id=$1',[id])).rows[0];
 await db.transaction(async c=>{for(const row of [shape.location('organization','Fixture company'),shape.product({id:'product',code:'F-1',name:'Fixture inventory',currency:'JPY',price:0,tracked:true,quantity:7,locationId:'organization'})])await sync.cacheRecord(c,connection,row);});
 await catalog.createLocation(db,ctx,id,{externalId:'organization'});
 await catalog.importProducts(db,ctx,id,{externalIds:['product'],includeOpening:true});
 // This test exercises real credential storage, synchronization and imports.
 // External traffic and its billing wrapper are isolated fixture boundaries.
 t.mock.method(require('../../src/commercial/operations'),'run',async(_db,_workspace,_operation,run)=>run());
 let mode='enabled',quantity=7,providerWrites=0;
 t.mock.method(global,'fetch',async(value,options)=>{
  const url=new URL(value);assert.equal(url.hostname,'sandbox-quickbooks.api.intuit.com');
  if((options.method||'GET')!=='GET'){providerWrites++;throw Error('Qualification must not write to any provider');}
  if(mode==='feature-fault')return Response.json({Fault:{type:'ValidationFault',Error:[{code:'5030',Message:'Feature Not Supported'}]}});
  if(url.pathname.includes('/companyinfo/'))return Response.json({CompanyInfo:{CompanyName:'Fixture company'}});
  if(url.pathname.endsWith('/preferences'))return Response.json({Preferences:{ProductAndServicesPrefs:mode==='unknown'?{}:{QuantityOnHand:mode!=='disabled'},CurrencyPrefs:{HomeCurrency:{value:'JPY'}}}});
  if(mode==='fault-200')return Response.json({Fault:{type:'ValidationFault',Error:[{code:'6000',Message:'Provider did not complete the query'}]}});
  return Response.json({QueryResponse:{Item:[{Id:'product',Sku:'F-1',Name:'Fixture inventory',Type:'Inventory',TrackQtyOnHand:true,QtyOnHand:quantity,UnitPrice:0}]}});
 });
 const run=()=>sync.sync({id:randomUUID(),workspaceId:owner.workspaceId,payload:{connectorId:id}},db,{get:()=>require('../../src/connections/providers/quickbooks')});
 const snapshot=async()=>({
  catalog:(await db.query('SELECT external_id,provider_data FROM connection_external_records WHERE workspace_id=$1 AND connector_id=$2 ORDER BY external_id',[ctx.workspaceId,id])).rows,
  balances:(await db.query('SELECT sku_id,location_id,on_hand FROM balances WHERE workspace_id=$1 ORDER BY sku_id,location_id',[ctx.workspaceId])).rows,
  subscriptions:(await db.query('SELECT to_jsonb(s) AS state FROM account_subscriptions s WHERE account_id=$1 ORDER BY id',[owner.accountId])).rows,
  grant:await store.get(db,owner.workspaceId,id,'provider'),
 });
 assert.equal((await run()).products,1);const before=await snapshot();
 for(const unavailable of ['disabled','unknown','feature-fault','fault-200']){
  mode=unavailable;quantity=999;
  await assert.rejects(run(),error=>['QUICKBOOKS_INVENTORY_UNAVAILABLE','QUICKBOOKS_FEATURE_UNAVAILABLE','QUICKBOOKS_API_FAULT'].includes(error.code));
  assert.deepEqual(await snapshot(),before,'A capability loss or provider fault must preserve catalogue, stock, subscription and grant');
  const current=(await db.query('SELECT status,setup_status,last_error FROM workspace_connectors WHERE id=$1',[id])).rows[0];
  assert.equal(current.status,'connected');assert.equal(current.setup_status,'AUTHORITY_REQUIRED');assert.match(current.last_error,/preserved/);
  await db.query("UPDATE workspace_connectors SET config=(config::jsonb-'syncRetryAt')::text WHERE id=$1",[id]);
 }
 mode='enabled';quantity=12;assert.equal((await run()).products,1);
 const restored=await snapshot();assert.deepEqual(restored.grant,before.grant);assert.deepEqual(restored.subscriptions,before.subscriptions);assert.deepEqual(restored.balances,before.balances,'Resuming catalogue reads must not replace StockChief-owned stock');
 const product=restored.catalog.find(row=>row.external_id==='product');
 assert.equal(JSON.parse(product.provider_data).inventoryCounts[0].quantity,12);
 assert.equal(providerWrites,0);
});
