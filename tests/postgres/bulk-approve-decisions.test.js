'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict'),request=require('supertest'),{randomUUID}=require('node:crypto');
test('one approval applies only the selected matching purchase decisions on every plan',{timeout:240000},async t=>{
 const f=await require('../helpers/agent-workflow-fixture').fixture(t),{db,ctx,browser,subscribe}=f;
 const settings={RESEND_API_KEY:'fixture-only',FOUNDRY_FROM_EMAIL:'test@example.test',FOUNDRY_PUBLIC_URL:'https://stockchief.example.test'};
 const original=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
 Object.assign(process.env,settings);
 t.after(()=>{for(const [key,value] of Object.entries(original))if(value===undefined)delete process.env[key];else process.env[key]=value;});
 const commerce=require('../../src/operations/postgres-commerce'),catalog=require('../../src/domain/postgres-catalog-service');
 const plan=require('../../src/autopilot/postgres-service'),supplierId='fixture-supplier',locationId=f.location.id;
 await db.query("UPDATE accounts SET created_at=(now()-interval '16 days')::text WHERE id=$1",[f.owner.accountId]);
 await db.query("UPDATE suppliers SET email='orders@example.test' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,supplierId]);
 await db.query(`INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at)
   VALUES($1,$2,$1,'Batch mailbox','gmail','[]','{}','connected','[]',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId]);
 async function prepared(tier,index,warehouse){
  const sku=(await catalog.createItem(db,ctx,{name:'Batch '+tier+' '+index,baseCode:randomUUID(),trackingMode:'quantity'})).skuIds[0];
  await commerce.linkSupplierItem(db,ctx,{supplierId,skuId:sku,lastUnitCost:2,unitsPerPurchaseUnit:1,orderMultiple:1,minimumOrderQuantity:1,isPreferred:true});
  const inventory=require('../../src/domain/postgres-inventory-engine');
  await inventory.receive(db,ctx,{skuId:sku,locationId:warehouse,quantity:10,unitCost:2,idempotencyKey:randomUUID()});
  await inventory.issue(db,ctx,{skuId:sku,locationId:warehouse,quantity:3,reasonCode:'sold',idempotencyKey:randomUUID()});
  await db.query(`INSERT INTO reorder_policies(id,workspace_id,sku_id,location_id,reorder_point,target_stock,source,created_at,updated_at)
   VALUES($1,$2,$3,$4,8,20,'manual',now()::text,now()::text)`,[randomUUID(),ctx.workspaceId,sku,warehouse]);
  return (await plan.plan(db,ctx.workspaceId,{onlySkuIds:[sku]})).created[0];
 }
 const other=await require('../../src/domain/postgres-location-service').createLocation(db,ctx,{name:'Other receiving warehouse',kind:'warehouse'});
 const count=async()=>Number((await db.query("SELECT count(*) n FROM purchase_orders WHERE workspace_id=$1 AND source='foundry_recommendation'",[ctx.workspaceId])).rows[0].n);
 let approved=0;
 for(const tier of ['starter','growth','pro','enterprise']){
  await subscribe(tier);
  const [first,second,third]=[await prepared(tier,1,locationId),await prepared(tier,2,locationId),await prepared(tier,3,other.id)];
  const group={kind:'purchase',location:locationId,currency:first.recommendedAction.currency};
  const page=await browser.get('/needs-you/work').query(group).expect(200);
  assert(page.text.includes(first.id)&&page.text.includes(second.id)&&!page.text.includes(third.id),tier);
  const approve=()=>browser.post('/needs-you/work/approve').type('form').send({...group,_csrf:f.csrf(page.text),ids:[first.id,second.id,third.id,first.id]});
  const response=await approve().expect(303);approved+=2;
  const result=await browser.get(response.headers.location).expect(200);
  const messages=[...result.text.matchAll(/<[^>]*class="[^"]*(?:toast|flash)[^"]*"[^>]*>(.*?)<\//gs)].map(match=>match[1]);
  assert.equal(await count(),approved,tier+' '+messages.join(' '));
  assert.equal((await plan.getWork(db,ctx.workspaceId,third.id)).execution_status,'WAITING_FOR_APPROVAL',tier);
  assert.match(result.text,/2 decisions approved/);assert.match(result.text,/outside this group/);
  await approve().expect(303);assert.equal(await count(),approved,tier+' replay');
 }
});

test('approving several decisions reports what worked and what did not, and caps the batch',{timeout:120000},async t=>{
 const cluster=await require('../helpers/postgres-cluster').startCluster(),db=require('../../src/db/postgres').openPostgres(cluster.connectionString);let app;
 t.after(async()=>{if(app)await app.locals.sessionStore.close();await db.close();await cluster.stop();});
 await require('../../src/db/migrate-postgres').migratePostgres(db);
 const password='Bulk-'+randomUUID(),owner=await require('../../src/domain/postgres-auth-service').createBusiness(db,{name:'Owner',businessName:'Bulk shop',email:randomUUID()+'@example.test',password});
 const inbox=require('../../src/projections/postgres-work-inbox'),realSelection=inbox.selection;
 const autonomy=require('../../src/autopilot/postgres-service'),{ValidationError}=require('../../src/domain/errors'),real=autonomy.approve,calls=[];
 inbox.selection=async(_db,_workspaceId,{ids})=>new Map(ids.filter(id=>id!=='outside').map(id=>[id,{type:'purchase',quantityScope:'workspace'}]));
 autonomy.approve=async(_db,_ctx,_user,id,options)=>{calls.push([id,options.destinationLocationId]);if(id==='bad')throw new ValidationError('The selected supplier has no verified order email address.');};
 t.after(()=>{autonomy.approve=real;inbox.selection=realSelection;});
 app=require('../../src/postgres-app').createPostgresApp({database:db,env:'test',sessionSecret:randomUUID()});
 const agent=request.agent(app),csrf=text=>/name="_csrf" value="([^"]+)"/.exec(text)[1],login=await agent.get('/login');
 await agent.post('/login').type('form').send({_csrf:csrf(login.text),email:owner.email,password});
 const page=await agent.get('/needs-you/work?kind=purchase&location=&currency=USD');assert.equal(page.status,200);assert.match(page.text,/Approve selected/);
 const one=await agent.post('/needs-you/work/approve').type('form').send({_csrf:csrf(page.text),kind:'purchase',currency:'USD',ids:['good','bad','good2','outside','good'],destinationLocationId:'loc-1'});
 assert.equal(one.status,303);assert.match(one.headers.location,/^\/needs-you\/work\?/);assert.deepEqual(calls,[['good','loc-1'],['bad','loc-1'],['good2','loc-1']]);
 const after=await agent.get(one.headers.location);assert.match(after.text,/2 decisions approved/);assert.match(after.text,/2 decisions could not be approved: The selected supplier has no verified order email address\. The decision changed or is outside this group\./);
 calls.length=0;const none=await agent.post('/needs-you/work/approve').type('form').send({_csrf:csrf(after.text),kind:'purchase'});assert.equal(none.status,303);assert.equal(calls.length,0);
 const many=await agent.post('/needs-you/work/approve').type('form').send({_csrf:csrf(after.text),kind:'purchase',ids:Array.from({length:90},(_,i)=>'id'+i)});assert.equal(many.status,303);assert.equal(calls.length,75,'one batch is one page at most');
});
