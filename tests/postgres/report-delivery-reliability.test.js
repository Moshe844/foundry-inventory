'use strict';process.env.NODE_ENV='test';
const test=require('node:test'),assert=require('node:assert/strict');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
test('scheduled reports deliver once per due slot on every plan and hold changed reports or recipients',{timeout:150000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx,owner}=f;
 const reports=require('../../src/reports/postgres-service'),scheduling=require('../../src/reports/postgres-scheduling');
 const jobs=require('../../src/operations/postgres-job-queue');
 const actor={role:'owner',permissions:[],email:f.email},sent=[];
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async(message,options)=>{
   sent.push({message,key:options.idempotencyKey});return {provider:'resend',externalId:'report-acceptance-'+sent.length};
 }});
 const process=kind=>jobs.processOne(db,{[kind]:handlers[kind]},{owner:'scheduled-report-test'});
 const schedule={frequency:'weekly',hour:9,minute:17,weekday:2,timeZone:'America/New_York'};
 const selectPlan=plan=>db.query(`INSERT INTO account_subscriptions(id,account_id,plan_id,plan_version_id,status,billing_interval,source)
   SELECT 'report-test-subscription',$1,$2,id,'COMP','CUSTOM','ISOLATED_TEST' FROM commercial_plan_versions
   WHERE plan_id=$2 AND status='ACTIVE' ORDER BY created_at DESC,id LIMIT 1
   ON CONFLICT(account_id) DO UPDATE SET plan_id=excluded.plan_id,plan_version_id=excluded.plan_version_id`,[owner.accountId,plan]);
 const delivery=async report=>(await db.query(`SELECT * FROM stockchief_runtime.report_deliveries
   WHERE workspace_id=$1 AND template_id=$2`,[ctx.workspaceId,report.id])).rows[0];
 for(const plan of ['starter','growth','pro','enterprise']){
   await selectPlan(plan);
   const report=await reports.save(db,ctx,actor,{dataset:'stock',title:'Weekly stock '+plan,columns:['sku','on_hand']},{schedule});
   const due=new Date(report.next_send_at);
   assert.equal(require('../../src/lib/business-time').parts(due,schedule.timeZone).hour,9);
   assert.equal((await scheduling.enqueueDue(db,new Date(due-1))).queued,0);
   assert.equal((await scheduling.enqueueDue(db,due)).queued,1);
   assert.equal((await scheduling.enqueueDue(db,due)).queued,0);
   assert.equal((await process('report.generate-delivery')).status,'COMPLETED');
   assert.equal((await delivery(report)).status,'PENDING');
   assert.equal((await process('system.email-send')).status,'COMPLETED');
   const completed=await delivery(report);
   assert.equal(completed.status,'SENT');
   assert.equal(completed.provider_message_id,'report-acceptance-'+sent.length);
   assert.equal(sent.at(-1).message.to,f.email);
   assert.match(sent.at(-1).message.subject,new RegExp('Weekly stock '+plan));
   assert.equal(await process('system.email-send'),null);
   await require('../../src/reports/postgres-delivery-controls').change(db,ctx,actor,report.id,{action:'pause',expectedRevision:report.revision});
 }
 assert.equal(sent.length,4);
 assert.equal(new Set(sent.map(entry=>entry.key)).size,4);
 for(const change of ['definition','recipient']){
   const report=await reports.save(db,ctx,actor,{dataset:'stock',title:'Stale '+change,columns:['sku','on_hand']},{schedule});
   const due=new Date(report.next_send_at);
   assert.equal((await scheduling.enqueueDue(db,due)).queued,1);
   assert.equal((await process('report.generate-delivery')).status,'COMPLETED');
   if(change==='definition'){
     await reports.save(db,ctx,actor,{...report.definition,title:'New stock report'},{id:report.id,expectedRevision:report.revision,schedule});
   }else{
     await db.query('UPDATE accounts SET email=$2 WHERE id=$1',[owner.accountId,'changed-report-owner@example.test']);
   }
   const result=await process('system.email-send');
   assert.equal(sent.length,4,'A stale '+change+' never reaches the provider');
   if(change==='definition'){
     assert.equal(result.status,'COMPLETED');
     assert.equal((await delivery(report)).status,'CANCELLED');
   }else{
     assert.equal(result.status,'DEAD');
     assert.equal(result.lastError.code,'report_recipient_changed');
   }
   await require('../../src/reports/postgres-delivery-controls').change(db,ctx,actor,report.id,{action:'pause',expectedRevision:change==='definition'?Number(report.revision)+1:report.revision});
 }
});
test('every current report delivery exposes its durable identity in the service and visible review',{timeout:90000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f,reports=require('../../src/reports/postgres-service'),controls=require('../../src/reports/postgres-delivery-controls'),actor={role:'owner',permissions:[],email:f.email};
 const report=await reports.save(db,ctx,actor,{dataset:'stock',title:'Independent delivery identity',columns:['sku','on_hand'],sort:'sku'});
 const first=await controls.change(db,ctx,actor,report.id,{action:'send_now',requestKey:'first-request'});await db.query("UPDATE stockchief_runtime.report_deliveries SET created_at=now()-interval '2 minutes' WHERE workspace_id=$1 AND id=$2",[ctx.workspaceId,first.deliveryId]);
 const latest=await controls.change(db,ctx,actor,report.id,{action:'send_now',requestKey:'second-request'}),saved=await reports.load(db,ctx,actor,report.id),listed=(await reports.list(db,ctx,actor)).find(r=>r.id===report.id);assert.equal(saved.latest_delivery.id,latest.deliveryId);assert.equal(listed.latest_delivery.id,latest.deliveryId);assert.notEqual(saved.latest_delivery.id,first.deliveryId);assert.equal(saved.latest_delivery.status,'PENDING');
 const ejs=require('ejs'),path=require('path'),html=await ejs.renderFile(path.join(__dirname,'../../src/web/views/reports/delivery-actions.ejs'),{report:saved,helpers:{dateTime:d=>new Date(d).toISOString()},csrfToken:'isolated-csrf',reportActionKey:'isolated-action'});assert(html.includes(latest.deliveryId),'The exact delivery reference must be visible to both the owner and Ask');assert(!html.includes(first.deliveryId),'A previous delivery must never be represented as the latest');assert(html.includes('Preparing or sending'));assert(!html.includes('Accepted by email provider</strong>'));
 await assert.rejects(reports.load(db,{...ctx,actorId:'foreign-actor'},actor,report.id));await assert.rejects(reports.load(db,{...ctx,workspaceId:'foreign-business'},actor,report.id));assert.equal((await reports.list(db,{...ctx,actorId:'foreign-actor'},actor)).length,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM commercial_email_deliveries e JOIN stockchief_runtime.jobs j ON j.id=e.job_id WHERE j.workspace_id=$1',[ctx.workspaceId])).rows[0].n,0,'Reading identity must never send a message');
});
test('routine report delivery is not starved by a continuing maintenance batch',{timeout:90000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await require('../helpers/postgres-model-fixture').fundWorkspace(db,ctx.workspaceId);
 const reports=require('../../src/reports/postgres-service'),controls=require('../../src/reports/postgres-delivery-controls'),jobs=require('../../src/operations/postgres-job-queue');
 const actor={role:'owner',permissions:[],email:f.email},report=await reports.save(db,ctx,actor,{dataset:'stock',title:'Unfamiliar report',columns:['sku','on_hand'],sort:'sku'});
 const queued=await controls.change(db,ctx,actor,report.id,{action:'send_now',requestKey:'one-approved-send'});
 await jobs.enqueue(db,{workspaceId:ctx.workspaceId,kind:'system.reconcile-business',idempotencyKey:'maintenance-batch',payload:{},priority:79});
 let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let sends=0;
 const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async()=>{sends++;return {provider:'resend',externalId:'unfamiliar-acceptance'};}});
 const maintenance=Object.assign(async()=>{entered();await gate;return {checked:true};},{externalEffect:true,...(handlers['system.reconcile-business'].workerLane?{workerLane:handlers['system.reconcile-business'].workerLane}:{})});
 const runtime=require('../../src/operations/postgres-worker').start(db,{intervalMs:10,handlers:{'system.reconcile-business':maintenance,'report.generate-delivery':handlers['report.generate-delivery'],'system.email-send':handlers['system.email-send']},onError:e=>{throw e;}});
 f.cleanup(async()=>{release();await runtime.stop();});await started;
 const end=Date.now()+3500;let current;do{current=(await db.query('SELECT status FROM stockchief_runtime.report_deliveries WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,queued.deliveryId])).rows[0];if(current.status==='SENT')break;await wait(25);}while(Date.now()<end);
 assert.equal(current.status,'SENT','An ongoing maintenance batch must not occupy routine delivery');assert.equal(sends,1);
 assert.equal((await db.query("SELECT status FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND idempotency_key='maintenance-batch'",[ctx.workspaceId])).rows[0].status,'RUNNING');
 release();await runtime.stop();
 assert.equal((await reports.load(db,ctx,actor,report.id)).last_delivered_at!==null,true);
 const replay=await controls.change(db,ctx,actor,report.id,{action:'send_now',requestKey:'one-approved-send'});assert.equal(replay.replayed,true);assert.equal(replay.deliveryId,queued.deliveryId);assert.equal(sends,1);
});
test('Ask waits for report email acceptance, never equates generation or an unproved SENT flag with delivery',{timeout:90000},async t=>{
 const f=await require('../helpers/postgres-shipping-fixture').fixture(t),{db,ctx}=f;
 await require('../helpers/postgres-model-fixture').fundWorkspace(db,ctx.workspaceId);
 const reports=require('../../src/reports/postgres-service'),controls=require('../../src/reports/postgres-delivery-controls'),jobs=require('../../src/operations/postgres-job-queue'),plans=require('../../src/assistant/postgres-capability-plans');
 const actor={role:'owner',permissions:[],email:f.email},report=await reports.save(db,ctx,actor,{dataset:'stock',title:'Receipt proof',columns:['sku','on_hand'],sort:'sku'});
 const queued=await controls.change(db,ctx,actor,report.id,{action:'send_now',requestKey:'receipt-checked'}),result={reportId:report.id,...queued};
 const proposalId='fixture-approved-report';await db.query(`INSERT INTO stockchief_runtime.assistant_action_proposals(id,workspace_id,actor_user_id,action_type,payload,summary,source_message,status,idempotency_key,result,executed_at)
 VALUES($1,$2,$3,'report.template.send_now','{}','One approved report','Send once','EXECUTED','fixture-report-approval',$4::jsonb,now())`,[proposalId,ctx.workspaceId,ctx.actorId,JSON.stringify(result)]);
 const harness={calls:{report:{state:'DONE',result:{outcomes:[{result:{proposal:{id:proposalId}}}]}}}},goal={id:'fixture-report-goal',original_request:'Send the approved report once'},catalogue={list:()=>[{name:'report.template.send_now'}]},receipts=require('../../scripts/environment-agent-demo/receipts');
 const pending=await receipts.collect(db,ctx,goal,harness,catalogue);assert.equal(pending.dependencyState,'WAITING_EVENT');assert.equal(pending.operations[0].externalVerification.scope,'current_report_email_acceptance');assert.equal(pending.operations[0].externalVerification.state,'WAITING_EVENT');
 assert.equal((await plans.externalState(db,ctx.workspaceId,result)).state,'WAITING_EVENT');
 assert.equal((await plans.externalState(db,'foreign-inventory',result)).reason,'report_delivery_missing');
 assert.equal((await plans.externalState(db,ctx.workspaceId,{...result,reportId:'different-report'})).reason,'report_delivery_missing');
 await db.query("UPDATE stockchief_runtime.report_deliveries SET status='SENT',provider_message_id='unproved',completed_at=now() WHERE id=$1",[queued.deliveryId]);
 assert.equal((await plans.externalState(db,ctx.workspaceId,result)).state,'WAITING_EVENT','A SENT label without provider acceptance is not evidence');
 await db.query("UPDATE stockchief_runtime.report_deliveries SET status='PENDING',provider_message_id=NULL,completed_at=NULL WHERE id=$1",[queued.deliveryId]);
 let sends=0;const handlers=require('../../src/operations/postgres-runtime-handlers').create(undefined,{emailSender:async()=>{sends++;return {provider:'resend',externalId:'independent-provider-receipt'};}});
 await jobs.processOne(db,{'report.generate-delivery':handlers['report.generate-delivery']},{owner:'receipt-generator'});
 assert.equal((await plans.externalState(db,ctx.workspaceId,result)).state,'WAITING_EVENT','A completed generation job has not sent the report');
 const delivery=(await jobs.processOne(db,{'system.email-send':handlers['system.email-send']},{owner:'receipt-sender'}));assert.equal(delivery.status,'COMPLETED');
 assert.equal((await plans.externalState(db,ctx.workspaceId,result)).state,'DONE');assert.equal(sends,1);assert((await reports.load(db,ctx,actor,report.id)).last_delivered_at);
 const accepted=await receipts.collect(db,ctx,goal,harness,catalogue);assert.equal(accepted.dependencyState,'READY');assert.equal(accepted.operations[0].externalVerification.state,'DONE');assert.equal(accepted.operations[0].result.status,'PENDING','Retain the original queue receipt while reporting its fresh verified completion');
 await jobs.processOne(db,{'system.email-send':handlers['system.email-send']},{owner:'replayed-sender'});assert.equal(sends,1);
 await db.query("UPDATE stockchief_runtime.report_deliveries SET status='FAILED',error_message='Provider rejected the recipient' WHERE id=$1",[queued.deliveryId]);
 assert.equal((await plans.externalState(db,ctx.workspaceId,result)).reason,'report_delivery_failed');
});
