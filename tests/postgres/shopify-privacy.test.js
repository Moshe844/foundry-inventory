'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {startCluster}=require('../helpers/postgres-cluster'),{openPostgres}=require('../../src/db/postgres');
const privacy=require('../../src/connections/postgres-shopify-privacy'),vault=require('../../src/connections/credentials');
const {newId}=require('../../src/lib/util');
test('Shopify privacy works with real PostgreSQL on Starter, Growth and Pro',{timeout:240000},async t=>{
 const saved=Object.fromEntries(['SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_PUBLIC_CLIENT_ID','SHOPIFY_PUBLIC_CLIENT_SECRET'].map(key=>[key,process.env[key]]));
 Object.assign(process.env,{SHOPIFY_CLIENT_ID:'fixture-legacy',SHOPIFY_CLIENT_SECRET:'fixture-legacy-secret',SHOPIFY_PUBLIC_CLIENT_ID:'fixture-public',SHOPIFY_PUBLIC_CLIENT_SECRET:'fixture-public-secret'});
 t.after(()=>{for(const [key,value]of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const cluster=await startCluster(),db=openPostgres(cluster.connectionString);t.after(async()=>{await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const auth=require('../../src/domain/postgres-auth-service'),now=new Date().toISOString();
 const sign=(body,topic,shop,delivery='delivery-'+crypto.randomUUID(),secret=process.env.SHOPIFY_CLIENT_SECRET)=>{const raw=Buffer.from(JSON.stringify(body));return {raw,headers:{'x-shopify-hmac-sha256':crypto.createHmac('sha256',secret).update(raw).digest('base64'),'x-shopify-topic':topic,'x-shopify-shop-domain':shop,'x-shopify-webhook-id':delivery}};};
 const other=await auth.createBusiness(db,{name:'Other owner',businessName:'Other inventory',email:crypto.randomUUID()+'@example.test',password:'Other!'+crypto.randomUUID()});
 for(const plan of ['starter','growth','pro'])await t.test(plan+' privacy export, deletion, replay and authorization',async()=>{
  const identity=await auth.createBusiness(db,{name:'Owner',businessName:'Privacy '+plan,email:crypto.randomUUID()+'@example.test',password:'Owner!'+crypto.randomUUID()}),ctx={workspaceId:identity.workspaceId,actorId:identity.userId};
  await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,source) SELECT $1,$2,$3,id,'COMP','ISOLATED_TEST' FROM commercial_plan_versions WHERE plan_id=$3 AND status='ACTIVE' ORDER BY version_number DESC LIMIT 1",[newId('sub'),identity.accountId,plan]);
  const connector=newId('con'),customer=newId('customer'),shop='privacy-'+plan+'.myshopify.com';
  await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,expected_interval_minutes,setup_status,authorized_by_user_id,provider_account_id,provider_account_name,created_at,updated_at)
   VALUES($1,$2,$1,'Privacy store','shopify','connected','[]','[]','{}',5,'CONNECTED',$3,$4,'Privacy store',$5,$5)`,[connector,ctx.workspaceId,ctx.actorId,shop,now]);
  await db.query("INSERT INTO customers(id,workspace_id,name,email,phone,shipping_address,created_by_user_id,created_at,updated_at) VALUES($1,$2,'Privacy Customer','privacy@example.test','5551234567','18 Privacy Road',$3,$4,$4)",[customer,ctx.workspaceId,ctx.actorId,now]);
  await db.query("INSERT INTO connection_mappings(id,workspace_id,connector_id,entity_type,external_id,foundry_record_id,confidence,created_at,updated_at) VALUES($1,$2,$3,'customer','77',$4,'approved',$5,$5)",[newId('map'),ctx.workspaceId,connector,customer,now]);
  const body={shop_id:99,shop_domain:shop,customer:{id:77,email:'privacy@example.test',phone:'never-retain-this-phone'},orders_requested:[],data_request:{id:101}};
  const request=sign(body,'customers/data_request',shop),accepted=await privacy.receive(db,'legacy',request.headers,request.raw);
  assert.equal(accepted.targets,1);assert.equal((await privacy.receive(db,'legacy',request.headers,request.raw)).replayed,true);
  assert.equal((await db.query('SELECT count(*)::int n FROM shopify_privacy_work WHERE request_id=$1',[accepted.requestId])).rows[0].n,1);
  const retained=(await db.query('SELECT * FROM shopify_privacy_requests WHERE id=$1',[accepted.requestId])).rows[0];assert(!JSON.stringify(vault.decrypt(retained)).includes('never-retain-this-phone'));assert(!retained.ciphertext.includes('privacy@example.test'));
  const work=(await privacy.list(db,ctx))[0];assert.equal(work.status,'PENDING');
  await assert.rejects(privacy.download(db,{workspaceId:other.workspaceId,actorId:other.userId},work.id),/not ready|expired/);
  await privacy.processWork(db,{workspaceId:ctx.workspaceId,payload:{workId:work.id}});
  await assert.rejects(privacy.completeExport(db,ctx,work.id),/Download/);
  const exported=await privacy.download(db,ctx,work.id);assert(JSON.stringify(exported).includes('privacy@example.test'));
  assert(!JSON.stringify(exported).includes('never-retain-this-phone'));
  await privacy.completeExport(db,ctx,work.id);assert.equal((await privacy.list(db,ctx))[0].status,'COMPLETED');
  const deletion=sign({...body,data_request:undefined,orders_to_redact:[]},'customers/redact',shop),eraseRequest=await privacy.receive(db,'legacy',deletion.headers,deletion.raw),eraseWork=(await db.query('SELECT id FROM shopify_privacy_work WHERE request_id=$1',[eraseRequest.requestId])).rows[0];
  await privacy.processWork(db,{workspaceId:ctx.workspaceId,payload:{workId:eraseWork.id}});assert.equal((await privacy.erase(db,ctx,eraseWork.id)).completed,true);
  const redacted=(await db.query('SELECT * FROM customers WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,customer])).rows[0];assert.equal(redacted.email,null);assert.equal(redacted.phone,null);assert.equal(redacted.shipping_address,null);assert.match(redacted.name,/Deleted customer/);
  assert.equal((await privacy.erase(db,ctx,eraseWork.id)).replayed,true);
  const filtered=await privacy.filterBody(db,{workspace_id:ctx.workspaceId,id:connector,provider_type:'shopify'},{customer:{id:77,first_name:'Privacy',last_name:'Customer',email:'privacy@example.test',phone:'5551234567'},shipping_address:{address1:'18 Privacy Road'},billing_address:{address1:'not-needed'},line_items:[{id:44,quantity:3}]});
  assert(!JSON.stringify(filtered).includes('privacy@example.test'));assert(!filtered.shipping_address);assert.equal(filtered.line_items[0].quantity,3);
  const event=await privacy.filterEvent(db,{id:connector,provider_type:'shopify'},ctx.workspaceId,{type:'sales_order.created',data:{customer:{externalId:'77',name:'Privacy Customer'},customerEmail:'privacy@example.test',shippingAddress:'18 Privacy Road',lines:[{quantity:3}]}});assert(!event.data.customerEmail);assert(!event.data.shippingAddress);assert.match(event.data.customer.name,/Deleted customer/);assert.equal(event.data.lines[0].quantity,3);
  const tampered=Buffer.from(request.raw.toString().replace('101','102'));await assert.rejects(privacy.receive(db,'legacy',request.headers,tampered),/signature/);
  const changed=sign({...body,data_request:{id:102}},'customers/data_request',shop,request.headers['x-shopify-webhook-id']);await assert.rejects(privacy.receive(db,'legacy',changed.headers,changed.raw),/different content/);
  const publicRequest=sign(body,'customers/data_request',shop,undefined,process.env.SHOPIFY_PUBLIC_CLIENT_SECRET);assert.equal((await privacy.receive(db,'public',publicRequest.headers,publicRequest.raw)).targets,0,'A public-app signature cannot reach the legacy installation');
 });
 await t.test('legal holds stay in force after repeated attempts, and unsigned HTTP requests cannot queue work',async()=>{
  const connection=(await db.query("SELECT c.*,u.id AS owner_id FROM workspace_connectors c JOIN users u ON u.workspace_id=c.workspace_id AND u.role='owner' WHERE c.provider_account_id='privacy-growth.myshopify.com'")).rows[0],ctx={workspaceId:connection.workspace_id,actorId:connection.owner_id};
  const request=sign({shop_id:99,shop_domain:connection.provider_account_id,customer:{id:77}},'customers/redact',connection.provider_account_id),accepted=await privacy.receive(db,'legacy',request.headers,request.raw),work=(await db.query('SELECT id FROM shopify_privacy_work WHERE request_id=$1',[accepted.requestId])).rows[0];
  await privacy.processWork(db,{workspaceId:ctx.workspaceId,payload:{workId:work.id}});await privacy.hold(db,ctx,work.id,{reason:'Documented legal retention obligation for the reviewed records',until:new Date(Date.now()+86400000).toISOString()});
  await assert.rejects(privacy.erase(db,ctx,work.id),/legal retention hold/);await assert.rejects(privacy.erase(db,ctx,work.id),/legal retention hold/);assert.equal((await db.query('SELECT status FROM shopify_privacy_work WHERE id=$1',[work.id])).rows[0].status,'HELD');
  await assert.rejects(privacy.download(db,{...ctx,actorId:'non-member'},work.id),/Only an inventory owner/);
  const app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:'privacy-http-boundary'});try{
   const count=Number((await db.query('SELECT count(*) FROM shopify_privacy_requests')).rows[0].count),http=require('supertest')(app);
   await http.post('/api/v1/connections/shopify/privacy/legacy').set('content-type','application/json').set('x-shopify-topic','customers/redact').send({shop_domain:connection.provider_account_id}).expect(401);
   assert.equal(Number((await db.query('SELECT count(*) FROM shopify_privacy_requests')).rows[0].count),count);
   await http.get('/settings/privacy/'+work.id+'/export').expect(302);
  }finally{await app.locals.sessionStore.close();}
 });
 await t.test('expired raw payloads are erased while durable replay receipts remain',async()=>{
  const owner=(await db.query("SELECT * FROM workspace_connectors WHERE provider_account_id='privacy-starter.myshopify.com'")).rows[0],sealed=vault.encrypt({headers:{},rawBody:Buffer.from(JSON.stringify({customer:{email:'expire@example.test'}})).toString('base64')});
  for(const [id,status]of [['expired-done','COMPLETED'],['pending-kept','RECEIVED']])await db.query(`INSERT INTO connection_webhook_receipts(id,workspace_id,connector_id,delivery_id,payload_hash,ciphertext,iv,auth_tag,status,received_at,updated_at) VALUES($1,$2,$3,$1,'stable-hash',$4,$5,$6,$7,now()-interval '40 days',now()-interval '40 days')`,[id,owner.workspace_id,owner.id,sealed.ciphertext,sealed.iv,sealed.authTag,status]);
  const result=await require('../../src/connections/postgres-personal-data-retention').run(db);assert.equal(result.webhookPayloads,1);
  const rows=(await db.query("SELECT id,ciphertext,payload_hash,payload_purged_at FROM connection_webhook_receipts WHERE id IN ('expired-done','pending-kept') ORDER BY id")).rows;
  assert.equal(rows[0].ciphertext,'');assert.equal(rows[0].payload_hash,'stable-hash');assert(rows[0].payload_purged_at);assert(rows[1].ciphertext);assert.equal(rows[1].payload_purged_at,null);
 });
});
