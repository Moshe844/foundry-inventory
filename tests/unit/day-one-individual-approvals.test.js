'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../src/commercial/agent-plan');
const approval=require('../../src/commercial/individual-approval');

for(const plan of ['starter','growth','pro'])test(plan+': watch period permits exact reviews but refuses automatic and mission authority',async()=>{
 const state={plan,terms:{offerId:'agent-v3'},shadow:true};
 const db={query:async sql=>({rows:sql.includes('workspace_autopilot')?[{mode:'OBSERVE',paused:0,suspended:0}]:[]})};
 for(const action of ['contact.create','inventory.adjust','communication.send_email','report.template.create','autopilot.resume']){
  assert.equal(await approval.run({workspaceId:'workspace',actorId:'owner'},()=>policy.stopped(db,'workspace',state,action,false)),null,action+' can be individually reviewed');
  assert.equal(await policy.stopped(db,'workspace',state,action,false),policy.SHADOW_REASON,action+' cannot borrow an approval merely by passing false');
  assert.equal(await approval.run({workspaceId:'workspace',actorId:'owner'},()=>policy.stopped(db,'workspace',state,action,true)),policy.SHADOW_REASON,action+' remains blocked automatically even within a reviewed request');
  assert.equal(await policy.stopped(db,'workspace',state,action,true),policy.SHADOW_REASON,action+' cannot run as automatic or mission work');
 }
 // An explicit per-job Watch only setting is still a separate owner restriction.
 const watched={query:async sql=>({rows:sql.includes('agent_job_modes')?[{mode:'watch'}]:[{mode:'SUPERVISED'}]})};
 assert.match(await approval.run({workspaceId:'workspace',actorId:'owner'},()=>policy.stopped(watched,'workspace',state,'sales_quote.create',false)),/job is set to Watch only/);
 const after={...state,shadow:false};
 assert.match(await policy.stopped(db,'workspace',after,'contact.create',false),/watch-only mode/,'expiry alone never changes an explicit inventory mode');
});

test('a worker, another inventory or a request field cannot borrow an individual approval',async()=>{
 const state={plan:'pro',terms:{offerId:'agent-v3'},shadow:true};
 const db={query:async()=>({rows:[]})};
 const request={workspaceId:'one',actorId:'owner',individualApproval:true};
 assert.equal(await policy.stopped(db,'one',state,'contact.create',false),policy.SHADOW_REASON);
 await approval.run(request,async()=>{
  assert.equal(await policy.stopped(db,'two',state,'contact.create',false),policy.SHADOW_REASON);
  assert.equal(await policy.stopped(db,'one',state,'contact.create',true),policy.SHADOW_REASON);
  assert.equal(await policy.stopped(db,'one',state,'contact.create',false),null);
 });
 assert.equal(await policy.stopped(db,'one',state,'contact.create',false),policy.SHADOW_REASON,'the exception ends with the reviewed operation');
 const {reviewedRecordPath}=require('../../src/web/reviewed-individual-approval');
 for(const path of ['/autopilot/landed-cost-bills/bill-1/approve','/autopilot/supplier-forecasts/report-1/send','/autopilot/supplier-forecasts/report-api-group-1/send',
 '/autopilot/po-delivery-dates/source-1','/autopilot/channel-buffer-reviews/review-1/publish','/autopilot/supplier-rfqs/request-1/chase/delivery-1',
 '/mail/message-1/return','/mail/message-1/supplier-details','/warehouse/bin-corrections/correction-1/scan','/warehouse/bin-corrections/correction-1/approve'])assert(reviewedRecordPath(path),path);
 for(const path of ['/autopilot/run','/autopilot/reviews/stock-sharing/prepare','/autopilot/approval-groups/group-1/approve','/autopilot/mission/step-1/approve','/autopilot/customer-replies/rule-1/settings','/api/v1/business/actions/approve',
 '/autopilot/po-delivery-dates/source-1/settings','/autopilot/po-delivery-dates/source-1/teach','/mail/message-1/return-rule','/mail/message-1/supplier-details-settings',
 '/warehouse/bin-corrections/settings','/warehouse/bin-corrections/correction-1/rule'])assert.equal(reviewedRecordPath(path),false,path);
});

test('only trusted review execution can stamp a durable provider approval',async t=>{
 const effects=require('../../src/operations/postgres-provider-effects'),jobs=require('../../src/operations/postgres-job-queue');
 t.mock.method(jobs,'enqueue',async()=>({job:{id:'fixture-job'},created:true}));
 const input={workspaceId:'workspace',kind:'payment.request.create',provider:'stripe',aggregateType:'customer_payment',aggregateId:'payment',idempotencyKey:'review',requestedByUserId:'owner'};
 const client={query:async(sql,values)=>{
  assert(sql.includes('INSERT INTO stockchief_runtime.provider_effects'));
  return {rows:[{id:values[0],workspace_id:values[1],kind:values[2],provider:values[3],aggregate_type:values[4],aggregate_id:values[5],payload:JSON.parse(values[6]),idempotency_key:values[7],requested_by_user_id:values[8],status:'PENDING'}]};
 }};
 const forged=await effects.enqueueInTransaction(client,{...input,payload:{individualApprovalActorId:'owner'}});
 assert.equal(forged.effect.payload.individualApprovalActorId,undefined,'caller-supplied proof is discarded');
 const reviewed=await approval.run({workspaceId:'workspace',actorId:'owner'},()=>effects.enqueueInTransaction(client,{...input,payload:{}}));
 assert.equal(reviewed.effect.payload.individualApprovalActorId,'owner');
 const automated=await approval.run({workspaceId:'workspace',actorId:'owner'},()=>effects.enqueueInTransaction(client,{...input,payload:{automatic:true}}));
 assert.equal(automated.effect.payload.individualApprovalActorId,undefined,'an automatic effect cannot inherit a reviewed request');
 await assert.rejects(effects.withIndividualApproval({query:async()=>({rowCount:1})},{...reviewed.effect,requestedByUserId:'someone-else'},()=>{}),/no longer valid/);
});
