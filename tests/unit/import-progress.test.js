'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{present}=require('../../src/imports/postgres-progress');
test('import progress requires canonical verification and distinguishes queue, execution, interruption and approval',()=>{
 const base={id:'fixture',source_name:'source.csv',records_detected:20,records_valid:20,records_invalid:0,plan_status:'READY',approval_status:'APPROVED',created_at:'2026-10-19T00:00:00.000Z',database_now:1000};
 for(const [input,state]of [[{job_status:'PENDING'},'QUEUED'],[{job_status:'RUNNING',lease_expires_at:2000},'RUNNING'],[{job_status:'RUNNING',lease_expires_at:999},'PAUSED'],[{job_status:'DEAD'},'NEEDS_REVIEW'],[{job_status:'PAUSED'},'PAUSED'],[{job_status:'COMPLETED'},'NEEDS_REVIEW'],[{},'APPROVED'],[{approval_status:'AWAITING_APPROVAL'},'AWAITING_APPROVAL'],[{execution_status:'EXECUTING'},'RUNNING'],[{plan_status:'CANCELLED'},'CANCELLED'],[{plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:0},'NEEDS_REVIEW'],[{plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1},'VERIFIED']]){const view=present({...base,...input});assert.equal(view.state,state);assert.equal(view.verified,state==='VERIFIED');assert.equal(view.active,['RUNNING','QUEUED'].includes(state));assert.equal(view.finished,!view.active);assert(!JSON.stringify(view).includes('lease_expires_at'));}
});

test('completion uses the observed commit or finished job and never inherits a failed attempt clock into a retry',()=>{
 const base={id:'fixture',records_detected:800,records_valid:800,records_invalid:0,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1,finished_at:'2026-10-19T21:59:54.000Z',job_finished_at:'2026-10-19T22:00:57.000Z'};
 assert.equal(present(base).completedAt,base.job_finished_at);assert.equal(present({...base,committed_at:'2026-10-19T22:00:56.000Z'}).completedAt,'2026-10-19T22:00:56.000Z');
 const queued=present({...base,plan_status:'READY',execution_status:'FAILED',verified:0,job_status:'PENDING',job_finished_at:null,started_at:'2026-10-19T20:00:00.000Z'});assert.equal(queued.startedAt,null);assert.equal(queued.completedAt,null);
 const running=present({...base,plan_status:'READY',execution_status:'EXECUTING',verified:0,job_status:'RUNNING',lease_expires_at:2000,database_now:1000,job_finished_at:null});assert.equal(running.completedAt,null);
});
test('processed rows remain provisional until canonical verification and never invent progress for older workers',()=>{
 const base={id:'fixture',records_detected:800,records_valid:800,records_invalid:0,plan_status:'READY',approval_status:'APPROVED',job_status:'RUNNING',lease_expires_at:2000,database_now:1000};
 assert.equal(present(base).processedRows,null);assert.equal(present(base).progressPercent,null);
 const progress={stage:'verifying',processedRows:800,totalRows:800};const view=present({...base,job_result:{importProgress:progress}});assert.equal(view.processedRows,800);assert.equal(view.progressPercent,99);assert.equal(view.stage,'verifying');assert.equal(view.verified,false);
 for(const bad of [{...progress,totalRows:900},{...progress,processedRows:801},{...progress,processedRows:-1},{...progress,stage:'private_exception'}])assert.equal(present({...base,job_result:{importProgress:bad}}).processedRows,null);
 const complete=present({...base,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1});assert.equal(complete.progressPercent,100);assert.equal(complete.stage,'complete');
});
test('an unresolved source question remains pending input rather than requesting an unusable approval',()=>{
 const row={id:'question',plan_status:'READY',approval_status:'AWAITING_APPROVAL',records_detected:4,records_valid:2,records_invalid:2,needs_source_review:true};
 const question=present(row);assert.equal(question.state,'NEEDS_INPUT');assert.equal(question.label,'Needs your answer');assert.equal(question.stageLabel,'Resolve the preview questions');assert.equal(question.active,false);assert.equal(question.verified,false);
 assert.equal(present({...row,needs_source_review:false}).state,'AWAITING_APPROVAL');assert.equal(present({...row,approval_status:'APPROVED'}).state,'APPROVED');
});
