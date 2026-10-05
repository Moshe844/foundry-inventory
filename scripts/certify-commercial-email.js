'use strict';
// Sends only to Resend's documented simulated-delivery address, never customers.
const assert=require('node:assert/strict');const fs=require('node:fs');
const {startCluster}=require('../tests/helpers/postgres-cluster');const {openPostgres}=require('../src/db/postgres');
const {migratePostgres}=require('../src/db/migrate-postgres');const auth=require('../src/domain/postgres-auth-service');
const usage=require('../src/commercial/entitlements');const control=require('../src/commercial/control-service');
const service=require('../src/commercial/service');const notifications=require('../src/commercial/notifications');
const handlers=require('../src/operations/postgres-runtime-handlers');const queue=require('../src/operations/postgres-job-queue');
const email=require('../src/operations/email');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 if(process.env.NODE_ENV!=='test'||process.env.STOCKCHIEF_CERTIFY_RESEND!=='true')throw Error('Explicit test email certification opt-in required');
 const apiKey=process.env.RESEND_API_KEY;const from=process.env.FOUNDRY_FROM_EMAIL;
 if(!apiKey||!from)throw Error('Existing Resend configuration required');
 const report={startedAt:new Date().toISOString(),recipient:'delivered@resend.dev',recipientType:'RESEND_SIMULATED_DELIVERY',
  humanInboxDeliveryCertified:false,liveCheckoutEnabled:false,tests:[],messages:[],passed:false};
 const api=async route=>{const r=await fetch('https://api.resend.com'+route,{headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error(`Resend inspection HTTP ${r.status}`);return r.json();};
 const quota=await api('/usage');
 // Verified Free plan: never start a test that needs a paid overage or cap change.
 for(const period of ['daily','monthly']){
  const q=quota.emails?.[period];if(!q||![q.used,q.limit].every(Number.isSafeInteger)||q.used+8>q.limit)throw Error('Insufficient or unverified existing email quota');
 }
 const cluster=await startCluster();const db=openPostgres(cluster.connectionString);
 try{
  await migratePostgres(db);
  const b=await auth.createBusiness(db,{name:'Certification Test',businessName:'Email Certification',email:report.recipient,password:'Notification-certification-only!'});
  const scope={accountId:b.accountId,workspaceId:b.workspaceId};const now=Math.floor(Date.now()/1000);
  await db.query("UPDATE commercial_plans SET stripe_monthly_price_id='price_email' WHERE id='starter'");
  await db.query("UPDATE commercial_plan_meters SET included_units=20 WHERE plan_id='starter' AND meter IN ('ai_work_credits','connected_operations')");
  await control.snapshotPlanVersion(db,'starter');
  await service.handleBillingEvent(db,{id:'evt_email',type:'customer.subscription.created',created:now,data:{object:{id:'sub_email',customer:'cus_email',status:'active',
   metadata:{stockchief_account_id:b.accountId},current_period_start:now-100,current_period_end:now+86400*30,
   items:{data:[{price:{id:'price_email',recurring:{interval:'month'}}}]}}}});
  for(const meter of ['ai_work_credits','connected_operations'])for(const [threshold,units] of [[80,16],[95,3],[100,1]]){
   const input={meter,units,idempotencyKey:`${meter}:${threshold}`};await usage.recordUsage(db,scope,input);await usage.recordUsage(db,scope,input);
  }
  await notifications.queuePaymentFailed(db,{accountId:b.accountId,eventId:'email-failure',graceEnds:new Date(Date.now()+7*86400000)});
  await notifications.queueSubscriptionSuspended(db,{accountId:b.accountId,expiredAt:'test-expiry'});
  const jobs=(await db.query("SELECT id FROM stockchief_runtime.jobs WHERE kind='system.email-send'")).rows;assert.equal(jobs.length,8);
  const sender=async(message,options)=>{assert.equal(message.to,report.recipient);return email.sendResend(message,{...options,apiKey,from});};
  const worker={'system.email-send':handlers.create(undefined,{emailSender:sender,emailOptions:{from}})['system.email-send']};
  for(let i=0;i<8;i++){
   const result=await queue.processOne(db,worker,{owner:'resend-certification'});assert.equal(result.status,'COMPLETED',result.lastError?.message);
   const message=email.unseal(result.payload);const id=result.result.externalId;
   report.messages.push({jobId:result.id,providerId:id,messageType:result.payload.messageType,subject:message.subject});
   const replay=await handlers.systemEmail(result,db,{emailSender:sender,emailOptions:{from}});assert.equal(replay.externalId,id);assert.equal(replay.replayed,true);
   if(i===0){const duplicate=await sender(message,{idempotencyKey:`stockchief-email:${result.id}`});assert.equal(duplicate.externalId,id);}
   await sleep(350);
  }
  report.tests.push('Eight durable threshold/payment/grace notifications accepted; worker replay and provider duplicate send retain the same email identity');
  for(const message of report.messages){
   const deadline=Date.now()+60000;let row;
   do{row=await api(`/emails/${message.providerId}`);if(row.last_event==='delivered')break;await sleep(1500);}while(Date.now()<deadline);
   message.providerEvent=row.last_event;assert.equal(row.last_event,'delivered');await sleep(200);
  }
  report.tests.push('Resend reports simulated delivery for every notification');
  assert.equal(Number((await db.query("SELECT count(*) FROM commercial_cost_events WHERE provider='resend'")).rows[0].count),8);
  report.tests.push('Every unique worker delivery attempt has a cost event; no unlimited free email rate was invented');
  report.passed=true;
 }finally{report.finishedAt=new Date().toISOString();fs.writeFileSync('data/commercial-email-certification-2026-10-05.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));await db.close();cluster.stop();}
}
module.exports={main};if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
