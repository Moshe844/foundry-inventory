'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
test('storage admission is isolated from writes, concurrent-safe and measured independently',{timeout:180000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f,storage=require('../../src/commercial/storage-capacity'),ent=require('../../src/commercial/entitlements'),scope={accountId:owner.accountId,workspaceId:ctx.workspaceId};
 await db.query("INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status) VALUES('storage-admission-sub',$1,'starter',$2,'COMP') ON CONFLICT(account_id) DO UPDATE SET plan_id=EXCLUDED.plan_id,plan_version_id=EXCLUDED.plan_version_id,status=EXCLUDED.status",[owner.accountId,require('../../src/commercial/offers/approved-2026-11-02').id+':starter']);
 assert.equal((await db.query("SELECT count(*)::int n FROM pg_trigger g JOIN pg_proc p ON p.oid=g.tgfoid WHERE p.proname='commercial_track_storage'")).rows[0].n,0);
 assert.equal((await db.query("SELECT to_regprocedure('commercial_check_storage(text)') f")).rows[0].f,null);
 await storage.refresh(db,ctx.workspaceId);const original=await storage.state(db,owner.accountId);assert(original>0);
 const setLimit=async bytes=>db.query("INSERT INTO commercial_entitlement_overrides(id,account_id,meter,limit_units,reason) VALUES('storage-admission-limit',$1,'storage_bytes',$2,'Test storage admission') ON CONFLICT(id) DO UPDATE SET limit_units=EXCLUDED.limit_units",[owner.accountId,bytes]);
 await t.test('parallel reservations share account capacity without a per-business-write lock',async()=>{
  await setLimit(original+100);
  const attempts=await Promise.allSettled(['one','two'].map(key=>db.transaction(c=>storage.reserve(c,ctx.workspaceId,key,80,{finished:true}),{isolation:'READ COMMITTED'})));
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'entitlement_required');assert.equal(await storage.reserved(db,owner.accountId),80);
  await storage.refresh(db,ctx.workspaceId);assert.equal(await storage.reserved(db,owner.accountId),0);
 });
 await t.test('a late commit cannot lose its allowance when an earlier measurement is published',async()=>{
  await setLimit(original+1000000);let ready,release;const waiting=new Promise(r=>ready=r),unblock=new Promise(r=>release=r);
  const writer=db.transaction(async c=>{await storage.reserve(c,ctx.workspaceId,'late-visible',10000,{finished:true});await c.query("UPDATE locations SET name=name||'-late' WHERE workspace_id=$1",[ctx.workspaceId]);ready();await unblock;},{isolation:'READ COMMITTED'});
  await waiting;
  const wrapped={transaction:async(fn,options)=>{const result=await db.transaction(fn,options);if(options.readOnly){release();await writer;}return result;}};
  try{await storage.refresh(wrapped,ctx.workspaceId);}finally{release();await writer;}
  assert.equal(await storage.reserved(db,owner.accountId),10000);await storage.refresh(db,ctx.workspaceId);assert.equal(await storage.reserved(db,owner.accountId),0);
 });
 await t.test('uploads and approval enforce storage, replay safely and retain source records',async()=>{
  await setLimit((await storage.state(db,owner.accountId)));
  const uploads=require('../../src/imports/postgres-source-uploads');await assert.rejects(uploads.enqueue(db,ctx,{text:'Product,SKU\nCapacity,STORE-UP',requestKey:'blocked-capacity'}),e=>e.code==='entitlement_required');
  assert.equal((await db.query("SELECT count(*)::int n FROM import_source_uploads WHERE workspace_id=$1 AND request_key='blocked-capacity'",[ctx.workspaceId])).rows[0].n,0);
  await setLimit(2000000000);const imports=require('../../src/imports/postgres-service'),plan=await imports.analyse(db,ctx,{text:'Product,SKU,Cost,Price\nStorage product,STORE-01,1,2',allowModel:false});
  const meter=await ent.meterState(db,scope,'storage_bytes');await setLimit(meter.capacityUsed+storage.importBytes(plan)-1);
  await assert.rejects(imports.approve(db,ctx,plan.id,plan.integrityHash),e=>e.code==='entitlement_required');assert.equal((await imports.get(db,ctx.workspaceId,plan.id)).approvalStatus,'AWAITING_APPROVAL');
  await setLimit(2000000000);await imports.approve(db,ctx,plan.id,plan.integrityHash);const pending=await storage.reserved(db,owner.accountId);await imports.approve(db,ctx,plan.id,plan.integrityHash);assert.equal(await storage.reserved(db,owner.accountId),pending);
  assert((await imports.execute(db,ctx,plan.id)).verified);await storage.refresh(db,ctx.workspaceId);assert.equal(await storage.reserved(db,owner.accountId),0);assert((await storage.state(db,owner.accountId))>original);
 });
 await t.test('product photos and incoming email attachments use the same file admission guard',async()=>{
  const photo={buffer:require('@napi-rs/canvas').createCanvas(2,2).toBuffer('image/png')},products=require('../../src/domain/postgres-product-overview');await setLimit(0);await assert.rejects(products.savePhoto(db,ctx,f.item.itemId,photo),e=>e.code==='entitlement_required');
  await db.query("UPDATE suppliers SET email='storage-supplier@example.test' WHERE workspace_id=$1 AND id='fixture-supplier'",[ctx.workspaceId]);
  await db.query("INSERT INTO workspace_connectors(id,workspace_id,connector_key,display_name,provider_type,provides,config,status,capabilities,created_at,updated_at) VALUES('storage-mail',$1,'storage-mail','Storage mailbox','gmail','[]','{}','connected','[]',now(),now())",[ctx.workspaceId]);
  const mail=require('../../src/connections/postgres-mail'),connection={id:'storage-mail',workspace_id:ctx.workspaceId,provider_type:'gmail'},message={messageId:'storage-mail-file',sender:'storage-supplier@example.test',subject:'Attached source',attachments:[{filename:'source.txt',contentBase64:Buffer.from('Source evidence').toString('base64')}]};
  await assert.rejects(mail.capture(db,connection,message),e=>e.code==='entitlement_required');assert.equal((await db.query('SELECT count(*)::int n FROM connection_email_attachments WHERE workspace_id=$1',[ctx.workspaceId])).rows[0].n,0);
  await setLimit(2000000000);await products.savePhoto(db,ctx,f.item.itemId,photo);const saved=await mail.capture(db,connection,message),held=await storage.reserved(db,owner.accountId);assert(saved.accepted);assert((await mail.capture(db,connection,message)).replayed);assert.equal(await storage.reserved(db,owner.accountId),held);
  await storage.refresh(db,ctx.workspaceId);assert.equal(await storage.reserved(db,owner.accountId),0);
 });
 await t.test('two real import approvals cannot consume the same remaining storage allowance',async()=>{
  await setLimit(2000000000);const imports=require('../../src/imports/postgres-service'),plans=[];
  for(const code of ['APPROVAL-A','APPROVAL-B'])plans.push(await imports.analyse(db,ctx,{text:'Product,SKU,Cost,Price\n'+code+','+code+',1,2',allowModel:false}));
  const meter=await ent.meterState(db,scope,'storage_bytes');await setLimit(meter.capacityUsed+storage.importBytes(plans[0]));
  const results=await Promise.allSettled(plans.map(plan=>imports.approve(db,ctx,plan.id,plan.integrityHash)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'entitlement_required');
  for(const plan of plans)await imports.cancel(db,ctx,plan.id);await setLimit(2000000000);await storage.refresh(db,ctx.workspaceId);assert.equal(await storage.reserved(db,owner.accountId),0);
 });
 await t.test('a held obsolete quota lock cannot block stock movements at the storage limit',async()=>{
  await setLimit(0);let ready,release;const waiting=new Promise(r=>ready=r),unblock=new Promise(r=>release=r);
  const holder=db.transaction(async c=>{await c.query("SELECT pg_advisory_xact_lock(hashtextextended('storage-quota:'||$1,0))",[owner.accountId]);ready();await unblock;},{isolation:'READ COMMITTED'});await waiting;
  try{await db.transaction(c=>require('../../src/domain/postgres-inventory-engine').receiveInTransaction(c,ctx,{skuId:f.item.skuIds[0],locationId:f.location.id,quantity:1,idempotencyKey:'storage-independent-stock'}),{isolation:'READ COMMITTED',lockTimeoutMs:500});}finally{release();await holder;}
 });
 await t.test('measurement scheduling and publication survive a later runtime sweep failure',async()=>{
  const now=Date.now(),jobs=require('../../src/operations/postgres-job-queue');await db.query("UPDATE commercial_storage_usage SET measured_at=now()-interval '2 hours' WHERE workspace_id=$1",[ctx.workspaceId]);
  await require('../../src/operations/postgres-scheduler').scheduleOnce(db,{now});
  const failed=await jobs.processOne(db,{'system.runtime-sweep':async()=>{throw Error('Intentional later sweep failure');}},{owner:'storage-sweep-failure',now,leaseMs:60000});assert.equal(failed.status,'RETRY');
  const pending=(await db.query("SELECT id,status FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='commercial.storage-baseline' ORDER BY created_at DESC LIMIT 1",[ctx.workspaceId])).rows[0];assert.equal(pending.status,'PENDING');
  const handler=require('../../src/operations/postgres-runtime-handlers').create()['commercial.storage-baseline'],measured=await jobs.processOne(db,{'commercial.storage-baseline':handler},{owner:'storage-independent-measurement',leaseMs:120000});assert.equal(measured.status,'COMPLETED',JSON.stringify(measured.lastError));
  assert((await db.query("SELECT bool_and(measured_at>now()-interval '1 minute') fresh FROM commercial_storage_usage WHERE workspace_id=$1",[ctx.workspaceId])).rows[0].fresh);
 });
});
