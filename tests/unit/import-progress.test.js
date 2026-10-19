'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{present}=require('../../src/imports/postgres-progress');
test('import progress requires canonical verification and distinguishes queue, execution, interruption and approval',()=>{
 const base={id:'fixture',source_name:'source.csv',records_detected:20,records_valid:20,records_invalid:0,plan_status:'READY',approval_status:'APPROVED',created_at:'2026-10-19T00:00:00.000Z',database_now:1000};
 for(const [input,state]of [[{job_status:'PENDING'},'QUEUED'],[{job_status:'RUNNING',lease_expires_at:2000},'RUNNING'],[{job_status:'RUNNING',lease_expires_at:999},'PAUSED'],[{job_status:'DEAD'},'NEEDS_REVIEW'],[{job_status:'PAUSED'},'PAUSED'],[{job_status:'COMPLETED'},'NEEDS_REVIEW'],[{},'APPROVED'],[{approval_status:'AWAITING_APPROVAL'},'AWAITING_APPROVAL'],[{execution_status:'EXECUTING'},'RUNNING'],[{plan_status:'CANCELLED'},'CANCELLED'],[{plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:0},'NEEDS_REVIEW'],[{plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1},'VERIFIED']]){const view=present({...base,...input});assert.equal(view.state,state);assert.equal(view.verified,state==='VERIFIED');assert.equal(view.active,['RUNNING','QUEUED'].includes(state));assert.equal(view.finished,!view.active);assert(!JSON.stringify(view).includes('lease_expires_at'));}
});
test('processed rows remain provisional until canonical verification and never invent progress for older workers',()=>{
 const base={id:'fixture',records_detected:800,records_valid:800,records_invalid:0,plan_status:'READY',approval_status:'APPROVED',job_status:'RUNNING',lease_expires_at:2000,database_now:1000};
 assert.equal(present(base).processedRows,null);assert.equal(present(base).progressPercent,null);
 const progress={stage:'verifying',processedRows:800,totalRows:800};const view=present({...base,job_result:{importProgress:progress}});assert.equal(view.processedRows,800);assert.equal(view.progressPercent,99);assert.equal(view.stage,'verifying');assert.equal(view.verified,false);
 for(const bad of [{...progress,totalRows:900},{...progress,processedRows:801},{...progress,processedRows:-1},{...progress,stage:'private_exception'}])assert.equal(present({...base,job_result:{importProgress:bad}}).processedRows,null);
 const complete=present({...base,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1});assert.equal(complete.progressPercent,100);assert.equal(complete.stage,'complete');
});
