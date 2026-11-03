'use strict';
process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),{startCluster}=require('../helpers/postgres-cluster'),{openPostgres}=require('../../src/db/postgres'),{migratePostgres}=require('../../src/db/migrate-postgres');
const offer=require('../../src/commercial/offers/approved-2026-11-02');
test('approved packaging is exact, versioned, repeatable and keeps live checkout closed',{timeout:180000},async t=>{
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString,{max:4});t.after(async()=>{await db.close();await cluster.stop();});
 await migratePostgres(db);
 for(const [id,p]of Object.entries(offer.plans)){
  const plan=(await db.query('SELECT * FROM commercial_plans WHERE id=$1',[id])).rows[0];assert.equal(Number(plan.monthly_amount_minor),p.monthlyMinor);assert.equal(Number(plan.annual_amount_minor),p.annualMinor);
  const version=(await db.query("SELECT * FROM commercial_plan_versions WHERE plan_id=$1 AND status='ACTIVE'",[id])).rows[0];assert.equal(version.id,offer.id+':'+id);assert.equal(version.configuration.offerId,offer.id);
  for(const [meter,limit]of Object.entries(p.limits)){const row=version.meters.find(m=>m.meter===meter);assert(row,id+':'+meter);assert.equal(Number(row.included_units),limit,id+':'+meter);assert.equal(Number(row.hard_limit),limit,id+':'+meter);}
  const enabled=new Set(version.entitlements.filter(e=>Number(e.enabled)).map(e=>e.capability));
  for(const capability of ['connections.accounting','connections.commerce','communications.email_ingestion','shipping.labels','payments.customer','api.public','inventory.kits'])assert(enabled.has(capability),id+':'+capability);
  assert.equal(enabled.has('automation.purchasing'),id==='pro');assert.equal(enabled.has('warehouse.advanced'),id!=='starter');assert.equal(enabled.has('reports.advanced'),id!=='starter');
 }
 assert.equal((await db.query('SELECT checkout_enabled FROM commercial_release_control')).rows[0].checkout_enabled,false);
 const auth=require('../../src/domain/postgres-auth-service'),ent=require('../../src/commercial/entitlements'),locations=require('../../src/domain/postgres-location-service');
 const owner=await auth.createBusiness(db,{name:'Approved owner',businessName:'Approved Starter',email:'approved-starter@example.test',password:'Approved-starter-password!'}),ctx={workspaceId:owner.workspaceId,actorId:owner.userId},scope={accountId:owner.accountId,workspaceId:owner.workspaceId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,current_period_start,current_period_end) VALUES('approved-sub',$1,'starter',$2,'ACTIVE',now(),now()+interval '1 month')",[owner.accountId,offer.id+':starter']);
 await t.test('warehouse sites and bins have independent enforced limits',async()=>{
  const first=await locations.createLocation(db,ctx,{name:'First warehouse',kind:'warehouse'});await locations.createLocation(db,ctx,{name:'Second site',kind:'store'});
  await assert.rejects(locations.createLocation(db,ctx,{name:'Third warehouse',kind:'warehouse'}),e=>e.code==='entitlement_required');
  for(let n=0;n<100;n++)await locations.createLocation(db,ctx,{name:'Bin '+n,kind:'bin',parentLocationId:first.id});
  assert.equal((await ent.meterState(db,scope,'locations')).used,2);assert.equal((await ent.meterState(db,scope,'sublocations')).used,100);
  await assert.rejects(locations.createLocation(db,ctx,{name:'Bin too many',kind:'bin',parentLocationId:first.id}),e=>e.code==='entitlement_required');
  await assert.rejects(locations.createLocation(db,ctx,{name:'Root bin',kind:'bin'}),/parent|contains/);
 });
 await t.test('API keys are limited and revocation releases capacity without deleting history',async()=>{
  const api=require('../../src/connections/postgres-public-api'),a=await api.create(db,ctx,{name:'First',scopes:['inventory:read']});await api.create(db,ctx,{name:'Second',scopes:['inventory:read']});
  await assert.rejects(api.create(db,ctx,{name:'Third',scopes:['inventory:read']}),e=>e.code==='entitlement_required');await api.revoke(db,ctx.workspaceId,a.id,ctx.actorId);await api.create(db,ctx,{name:'Replacement',scopes:['inventory:read']});
  assert.equal((await ent.meterState(db,scope,'api_keys')).used,2);assert.equal((await api.list(db,ctx.workspaceId)).length,3);
 });
 await t.test('saved report limits also cover unscheduled reports',async()=>{
  const reports=require('../../src/reports/postgres-service'),actor={role:'owner',email:owner.email};for(let n=0;n<25;n++)await reports.save(db,ctx,actor,{dataset:'catalogue',title:'Saved '+n,columns:['sku','product']});
  await assert.rejects(reports.save(db,ctx,actor,{dataset:'catalogue',title:'Too many',columns:['sku','product']}),e=>e.code==='entitlement_required');
  assert.equal((await ent.meterState(db,scope,'saved_reports')).used,25);
 });
 await t.test('incoming email, outgoing recipients and Connected Operations have independent balances',async()=>{
  const routing=require('../../src/commercial/usage-categories');assert.equal(await routing.incomingMeter(db,scope),'incoming_emails');
  for(const [meter,units]of [['incoming_emails',2],['emails_sent',3],['connected_operations',1]])await ent.recordUsage(db,scope,{meter,units,idempotencyKey:'independent:'+meter});
  assert.equal((await ent.meterState(db,scope,'incoming_emails')).used,2);assert.equal((await ent.meterState(db,scope,'emails_sent')).used,3);assert.equal((await ent.meterState(db,scope,'connected_operations')).used,1);
  await ent.recordUsage(db,scope,{meter:'incoming_emails',units:2,idempotencyKey:'independent:incoming_emails'});assert.equal((await ent.meterState(db,scope,'incoming_emails')).used,2);
 });
 assert.deepEqual(await migratePostgres(db),[]);
 await t.test('stored business bytes are exact, roll back at the quota, and leave saved data intact',async()=>{
  const before=await require('../../src/commercial/storage-capacity').state(db,scope.accountId);assert(before>0);
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('storage-test',$1,'storage_bytes',$2,'Exact quota test')",[scope.accountId,before]);
  const row=(await db.query('SELECT * FROM locations WHERE workspace_id=$1 ORDER BY id LIMIT 1',[ctx.workspaceId])).rows[0];
  await assert.rejects(db.query('UPDATE locations SET name=name||$2 WHERE id=$1',[row.id,' added bytes beyond the exact limit']),e=>e.code==='entitlement_required');
  assert.equal((await db.query('SELECT name FROM locations WHERE id=$1',[row.id])).rows[0].name,row.name);assert.equal(await require('../../src/commercial/storage-capacity').state(db,scope.accountId),before);
  await db.query("DELETE FROM commercial_entitlement_overrides WHERE id='storage-test'");
  await db.query("UPDATE locations SET name='A' WHERE id=$1",[row.id]);assert((await require('../../src/commercial/storage-capacity').state(db,scope.accountId))<before);
 });
 await t.test('API minute capacity is shared by all keys and failed requests return monthly capacity',async()=>{
  const resources=require('../../src/commercial/api-resources');
  await db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('api-minute',$1,'api_requests_per_minute',2,'Minute boundary test')",[scope.accountId]);
  const first=await resources.begin(db,scope,'test-api-first');await resources.settle(db,first,true);const failed=await resources.begin(db,scope,'test-api-invalid-cursor');await resources.settle(db,failed,false);
  assert.equal((await ent.meterState(db,scope,'api_requests')).used,1);assert.equal((await ent.meterState(db,scope,'connected_operations')).used,1);
  await assert.rejects(resources.begin(db,scope,'test-api-third'),e=>e.status===429);await db.query("DELETE FROM commercial_entitlement_overrides WHERE id='api-minute'");
 });
 await t.test('Starter queues account imports and agent jobs independently',async()=>{
  const queue=require('../../src/operations/postgres-job-queue');for(const kind of ['import.analyse-source','import.execute-approved','assistant.run-goal'])await queue.enqueue(db,{workspaceId:ctx.workspaceId,kind,idempotencyKey:'lane:'+kind});
  const first=await queue.claim(db,{owner:'approved-first',kinds:['import.analyse-source']});assert(first);assert.equal((await ent.meterState(db,scope,'active_imports')).used,1);
  assert.equal(await queue.claim(db,{owner:'approved-second',kinds:['import.execute-approved']}),null);const independent=await queue.claim(db,{owner:'approved-agent',kinds:['assistant.run-goal']});assert(independent);
  await queue.complete(db,first.id,first.leaseToken);assert(await queue.claim(db,{owner:'approved-next',kinds:['import.execute-approved']}));
 });
 await t.test('products and SKUs have separate exact boundaries, independent of units of stock',async()=>{
  await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES('approved-multi',$1,'Many variants','quantity',1,now(),now())",[ctx.workspaceId]);
  await db.query("INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) SELECT 'approved-sku-'||n,$1,'approved-multi','APP-'||n,1,now() FROM generate_series(1,5000) n",[ctx.workspaceId]);
  assert.equal((await ent.meterState(db,scope,'products')).used,1);assert.equal((await ent.meterState(db,scope,'active_skus')).used,5000);
  await assert.rejects(db.query("INSERT INTO skus(id,workspace_id,item_id,code,is_active,created_at) VALUES('approved-overflow',$1,'approved-multi','OVERFLOW',1,now())",[ctx.workspaceId]),e=>e.code==='entitlement_required');
  const location=(await db.query("SELECT id FROM locations WHERE workspace_id=$1 AND kind='warehouse' LIMIT 1",[ctx.workspaceId])).rows[0];
  await require('../../src/domain/postgres-inventory-engine').receive(db,ctx,{skuId:'approved-sku-1',locationId:location.id,quantity:1000000,idempotencyKey:'quantity-is-not-skus'});
  assert.equal((await ent.meterState(db,scope,'active_skus')).used,5000);assert.equal((await ent.meterState(db,scope,'products')).used,1);
  await db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) SELECT 'approved-product-'||n,$1,'Product '||n,'quantity',1,now(),now() FROM generate_series(1,999) n",[ctx.workspaceId]);
  assert.equal((await ent.meterState(db,scope,'products')).used,1000);
  await assert.rejects(db.query("INSERT INTO items(id,workspace_id,name,tracking_mode,is_active,created_at,updated_at) VALUES('approved-product-over',$1,'Overflow','quantity',1,now(),now())",[ctx.workspaceId]),e=>e.code==='entitlement_required');
 });
 await t.test('extra inventory inherits usable sites; warehouse bundles apply only to their named inventory',async()=>{
  const products=(await db.query('SELECT * FROM commercial_capacity_products')).rows,add=async(id,workspaceId=null)=>{const p=products.find(p=>p.id===id);await db.query("INSERT INTO commercial_capacity_orders(id,account_id,product_id,quantity,units,amount_minor,currency,price_id,stripe_customer_id,request_key,status,paid_through,workspace_id,entitlements) VALUES($1,$2,$3,1,$4,$5,'USD',$6,'cus_approved_test',$1,'ACTIVE',now()+interval '1 month',$7,$8::jsonb)",[id+'-approved',scope.accountId,id,p.units_per_pack,p.monthly_amount_minor,'price_'+id,workspaceId,JSON.stringify(p.entitlements)]);};
  await add('extra-inventory');const second=await auth.createWorkspace(db,scope.accountId,{name:'Paid extra inventory'}),secondCtx={workspaceId:second.workspaceId,actorId:second.userId};
  await locations.createLocation(db,secondCtx,{name:'Extra inventory warehouse',kind:'warehouse'});await locations.createLocation(db,secondCtx,{name:'Extra inventory store',kind:'store'});
  assert.equal((await ent.meterState(db,{accountId:scope.accountId,workspaceId:second.workspaceId},'locations')).hardLimit,2);
  await add('extra-locations',ctx.workspaceId);assert.equal((await ent.meterState(db,scope,'locations')).hardLimit,12);assert.equal((await ent.meterState(db,scope,'sublocations')).hardLimit,600);
  await assert.rejects(locations.createLocation(db,secondCtx,{name:'Unpaid third site',kind:'warehouse'}),e=>e.code==='entitlement_required');
  assert.equal((await ent.meterState(db,scope,'products')).hardLimit,2000);assert.equal((await ent.meterState(db,scope,'active_skus')).hardLimit,10000);
  const highest=await ent.meterState(db,{accountId:scope.accountId,workspaceId:null},'locations');assert.equal(highest.used,2);assert.equal(highest.hardLimit,2);assert.equal(highest.workspaceId,second.workspaceId);
 });
 await t.test('new account-wide usage packs stay tenant-bound and retain their accepted scope',async()=>{
  const addons=require('../../src/commercial/addons'),wallet=require('../../src/commercial/wallet'),packId='incoming-10000-v4';
  await db.query("UPDATE account_subscriptions SET stripe_customer_id='cus_approved_pack' WHERE account_id=$1",[scope.accountId]);await db.query("UPDATE commercial_usage_packs SET stripe_price_id='price_approved_incoming' WHERE id=$1",[packId]);
  const result=await addons.beginPurchase(db,scope,{packId,idempotencyKey:'approved-pool-purchase',origin:'https://example.test'},{testMode:true,provider:{retrievePrice:async()=>({id:'price_approved_incoming',active:true,currency:'usd',unit_amount:1500,type:'one_time'}),createAddonCheckout:async()=>({id:'cs_approved_incoming',url:'https://stripe.example.test'})}});
  assert.equal(result.purchase.allocation_scope,'ACCOUNT');assert.equal((await ent.meterState(db,scope,'incoming_emails')).purchasedRemaining,0);
  await db.transaction(c=>addons.receivePayment(c,{id:'evt_approved_pool',type:'checkout.session.completed',created:Math.floor(Date.now()/1000),data:{object:{id:'cs_approved_incoming',customer:'cus_approved_pack',payment_status:'paid',payment_intent:'pi_approved_pool',amount_subtotal:1500,currency:'usd',metadata:{stockchief_purchase_id:result.purchase.id,stockchief_account_id:scope.accountId}}}}));
  const second=(await db.query('SELECT id FROM workspaces WHERE owner_account_id=$1 AND id<>$2 LIMIT 1',[scope.accountId,ctx.workspaceId])).rows[0];
  assert.equal((await ent.meterState(db,{accountId:scope.accountId,workspaceId:second.id},'incoming_emails')).purchasedRemaining,10000);
  const grant=(await db.query('SELECT * FROM commercial_usage_grants WHERE purchase_id=$1',[result.purchase.id])).rows[0];assert.equal(grant.workspace_id,null);
  const other=await auth.createBusiness(db,{name:'Other owner',businessName:'Other tenant',email:'approved-other@example.test',password:'Other-approved-password!'});
  const bounds=ent.periodBounds(await ent.subscriptionFor(db,scope.accountId));assert.equal((await wallet.balances(db,{accountId:other.accountId,workspaceId:other.workspaceId},'incoming_emails',bounds)).purchasedRemaining,0);
  await assert.rejects(ent.meterState(db,{accountId:other.accountId,workspaceId:second.id},'incoming_emails'),/another commercial account/);
 });
 await t.test('measuring old data preserves mutations committed after the baseline snapshot',async()=>{
  await db.query("UPDATE account_subscriptions SET plan_version_id='planver_starter_1' WHERE account_id=$1",[scope.accountId]);
  const storage=require('../../src/commercial/storage-capacity'),before=await storage.state(db,scope.accountId);
  await db.query("UPDATE commercial_storage_usage SET baseline_complete=false WHERE workspace_id=$1 AND relation='locations'::regclass",[ctx.workspaceId]);
  await assert.rejects(storage.state(db,scope.accountId),/being measured/);const changed='-concurrent-change';
  const wrapper={query:db.query.bind(db),transaction:async(fn,options)=>{const result=await db.transaction(fn,options);await db.query('UPDATE locations SET name=name||$2 WHERE workspace_id=$1',[ctx.workspaceId,changed]);return result;}};
  const count=Number((await db.query('SELECT count(*) AS n FROM locations WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n);
  await storage.baseline(wrapper,ctx.workspaceId,'locations');assert.equal(await storage.state(db,scope.accountId),before+Buffer.byteLength(changed)*count);
  await db.query('UPDATE account_subscriptions SET plan_version_id=$2 WHERE account_id=$1',[scope.accountId,offer.id+':starter']);
 });
});
