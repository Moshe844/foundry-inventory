'use strict';
process.env.NODE_ENV='test';
const test=require('node:test');const assert=require('node:assert/strict');
const {startCluster}=require('../helpers/postgres-cluster');const {openPostgres}=require('../../src/db/postgres');
const {migratePostgres}=require('../../src/db/migrate-postgres');const auth=require('../../src/domain/postgres-auth-service');
const usage=require('../../src/commercial/entitlements');const commercial=require('../../src/commercial/service');
const control=require('../../src/commercial/control-service');const queue=require('../../src/operations/postgres-job-queue');
const handlers=require('../../src/operations/postgres-runtime-handlers');const email=require('../../src/operations/email');
const notifications=require('../../src/commercial/notifications');

test('commercial notifications through committed usage, durable worker and provider boundary',{timeout:90000},async t=>{
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);t.after(async()=>{await db.close();cluster.stop();});
 await migratePostgres(db);
 const business=await auth.createBusiness(db,{name:'Notification Test',businessName:'Notification Test',email:'notifications@example.test',password:'notification-test-long-password'});
 const scope={accountId:business.accountId,workspaceId:business.workspaceId};const now=Math.floor(Date.now()/1000);
 await db.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_notify' WHERE id='starter'");
 await db.query("UPDATE commercial_plan_meters SET included_units=20 WHERE plan_id='starter' AND meter IN ('ai_work_credits','connected_operations')");
 await control.snapshotPlanVersion(db,'starter');
 await commercial.handleBillingEvent(db,{id:'evt_notify',type:'customer.subscription.created',created:now,data:{object:{id:'sub_notify',customer:'cus_notify',status:'active',
  metadata:{stockchief_account_id:business.accountId},current_period_start:now-100,current_period_end:now+86400*30,
  items:{data:[{price:{id:'price_notify',recurring:{interval:'month'}}}]}}}});
 await t.test('viewing reserved usage cannot suppress commit-time 80/95/100 emails; both categories deduplicate',async()=>{
  for(const meter of ['ai_work_credits','connected_operations']){
   const request={meter,units:16,idempotencyKey:`${meter}:80`};await usage.reserveUsage(db,scope,request);
   await control.usageWarnings(db,scope);
   assert.equal(Number((await db.query('SELECT count(*) FROM commercial_usage_notifications WHERE account_id=$1 AND meter=$2',[scope.accountId,meter])).rows[0].count),0);
   await Promise.all([usage.commitUsage(db,scope,request),usage.commitUsage(db,scope,request)]);
   for(const [threshold,units] of [[95,3],[100,1]])await usage.recordUsage(db,scope,{meter,units,idempotencyKey:`${meter}:${threshold}`});
   await assert.rejects(()=>usage.reserveUsage(db,scope,{meter,units:1,idempotencyKey:`${meter}:exhausted`}),/limit/);
  }
  assert.equal((await usage.capabilityState(db,scope,'inventory.core')).enabled,true);
  const jobs=(await db.query("SELECT payload FROM stockchief_runtime.jobs WHERE kind='system.email-send' AND payload->>'messageType'='billing_usage_warning'")).rows;
  assert.equal(jobs.length,6);const messages=jobs.map(row=>email.unseal(row.payload));
  for(const threshold of [80,95,100])assert.equal(messages.filter(m=>m.subject.includes(`${threshold}%`)).length,2);
  assert.ok(messages.filter(m=>m.subject.includes('100%')).every(m=>/pauses when no usage remains/.test(m.text)));
 });
 let sent=0;let lost=false;const accepted=new Map();const keys=[];
 const emailSender=async(message,options)=>{keys.push(options.idempotencyKey);if(!accepted.has(options.idempotencyKey)){
   accepted.set(options.idempotencyKey,{provider:'resend',externalId:`email_${++sent}`});
   if(!lost){lost=true;throw Object.assign(new Error('Accepted but response lost'),{retryable:true});}
  }return accepted.get(options.idempotencyKey);};
 const worker={'system.email-send':handlers.create(undefined,{emailSender})['system.email-send']};
 await t.test('worker retries the same provider key after uncertain acceptance and records one receipt',async()=>{
  const first=await queue.processOne(db,worker,{owner:'notify-test'});assert.equal(first.status,'RETRY');
  for(let i=0;i<6;i++)assert.equal((await queue.processOne(db,worker,{owner:'notify-test',now:Date.now()+5000})).status,'COMPLETED');
  assert.equal(sent,6);assert.equal(keys.length,7);assert.equal(new Set(keys).size,6);
  assert.equal(Number((await db.query('SELECT count(*) FROM commercial_email_deliveries WHERE provider_id IS NOT NULL')).rows[0].count),6);
  assert.equal(await queue.processOne(db,worker,{owner:'notify-test',now:Date.now()+5000}),null);
  const replay=await queue.get(db,first.id,null);assert.equal((await handlers.systemEmail(replay,db,{emailSender})).replayed,true);
  assert.equal(keys.length,7);
 });
 await t.test('uncertain delivery outside provider window fails visibly without sending',async()=>{
  const queued=await notifications.queuePaymentFailed(db,{accountId:scope.accountId,eventId:'expired',graceEnds:new Date()});
  await assert.rejects(()=>handlers.systemEmail(queued.job,db,{emailSender:async()=>{throw Error('network failure');}}),/network/);
  await db.query("UPDATE commercial_email_deliveries SET first_attempt_at=now()-interval '24 hours' WHERE job_id=$1",[queued.job.id]);
  await assert.rejects(()=>handlers.systemEmail(queued.job,db,{emailSender}),/retry window expired/);
  assert.equal(sent,6);assert.equal((await db.query("SELECT status FROM commercial_critical_warnings WHERE code='EMAIL_DELIVERY_RECONCILIATION_REQUIRED'")).rows[0].status,'OPEN');
 });
 await t.test('Resend transport sends the stable key and reports retryable provider throttling',async()=>{
  const result=await email.sendResend({to:'delivered@resend.dev',subject:'Test',text:'Test'},{apiKey:'fixture',from:'fixture@example.test',idempotencyKey:'same-email',
   fetch:async(url,init)=>{assert.equal(init.headers['Idempotency-Key'],'same-email');return {ok:true,json:async()=>({id:'provider_fixture'})};}});
  assert.equal(result.externalId,'provider_fixture');
  await assert.rejects(()=>email.sendResend({},{apiKey:'fixture',from:'fixture@example.test',fetch:async()=>({ok:false,status:429,json:async()=>({message:'rate limited'})})}),e=>e.retryable&&e.status===429);
 });
 await t.test('accepted email recovers a failed cost write without sending it again',async()=>{
  const queued=await notifications.queueSubscriptionSuspended(db,{accountId:scope.accountId,expiredAt:'cost-recovery'});
  queued.job.payload.messageType='password_reset';
  let failures=1;let calls=0;const fault={...db,query:(sql,args)=>{
   if(sql.includes('INSERT INTO commercial_cost_events')&&failures-- >0)throw Error('Cost database temporarily unavailable');
   return db.query(sql,args);
  }};
  const sender=async()=>{calls++;return {provider:'resend',externalId:'accepted-before-cost-failure'};};
  await assert.rejects(()=>handlers.systemEmail(queued.job,fault,{emailSender:sender}),/temporarily unavailable/);
  const retry=await handlers.systemEmail({...queued.job,attemptCount:2},db,{emailSender:sender});assert.equal(retry.replayed,true);assert.equal(calls,1);
  const cost=(await db.query('SELECT idempotency_key FROM commercial_cost_events WHERE idempotency_key=$1',[`${queued.job.id}:attempt:1`])).rows;
  assert.equal(cost.length,1);
  const checkpoint=await require('../../src/operations/postgres-checkpoints').get(db,'password_recovery.delivery');
  assert.equal(checkpoint.status,'PASS');assert.equal(checkpoint.detail.externalId,'accepted-before-cost-failure');
 });
});
