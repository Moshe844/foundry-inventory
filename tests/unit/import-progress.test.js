'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{present}=require('../../src/imports/postgres-progress');

test('interrupted direct executions and lost job errors never produce a silent pause',()=>{
 const base={id:'direct',records_detected:2001,records_valid:2001,plan_status:'READY',approval_status:'APPROVED',execution_status:'FAILED',execution_stage:'paused',execution_error:'SECRET_DETAIL from internal worker',integrity_hash:'approved',apply_checkpoint:{hash:'approved',cataloguePrepared:true,savedRows:2000}};
 for(const job_status of [undefined,'PAUSED','DEAD']){const view=present({...base,job_status});assert(view.reason);assert.match(view.reason,/2,000 rows are already saved/);assert.match(view.reason,/Continue resumes/);assert.doesNotMatch(view.reason,/SECRET_DETAIL/);assert.equal(view.active,false);assert.equal(view.savedRows,2000);}
 const failed=present({...base,execution_stage:'rolled_back',apply_checkpoint:null});assert(failed.reason);assert.equal(failed.savedRows,0);assert.doesNotMatch(failed.reason,/2,000|SECRET_DETAIL/);
 const unfinished=present({...base,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:0});assert.match(unfinished.reason,/Final checks have not confirmed/);assert(!unfinished.verified);
 assert.equal(present({...base,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1}).reason,null);
 const legacy=present({...base,job_result:'A historical worker returned text rather than structured progress'});assert(legacy.reason);assert.equal(legacy.savedRows,2000);
});

test('recovered workers show their live attempt without presenting the previous failure as a new pause',()=>{
 const base={id:'recovery',records_detected:10000,records_valid:10000,plan_status:'READY',approval_status:'APPROVED',job_status:'RUNNING',job_attempt_count:2,lease_expires_at:2000,database_now:1000,job_error:{code:'lease_expired'},integrity_hash:'approved',apply_checkpoint:{hash:'approved',cataloguePrepared:true,savedRows:4000},job_result:{importProgress:{stage:'processing',processedRows:4000,totalRows:10000,attempt:1}}};
 const running=present(base);assert.equal(running.state,'RUNNING');assert.equal(running.reason,null);assert.equal(running.attempt,2);assert.match(running.stageLabel,/Attempt 2 · resuming saved rows/);assert.equal(running.savedRows,4000);
 const queued=present({...base,job_status:'RETRY'});assert.equal(queued.state,'QUEUED');assert.equal(queued.reason,null);assert.doesNotMatch(queued.stageLabel,/restarting|resuming/);
 const paused=present({...base,lease_expires_at:999});assert.equal(paused.state,'PAUSED');assert.match(paused.reason,/4,000 rows are already saved/);assert.match(paused.reason,/Continue resumes/);
 const stopped=present({...base,job_status:'DEAD',job_error:{code:'validation_error',message:'A row needs review.'}});assert.equal(stopped.state,'NEEDS_REVIEW');assert.match(stopped.reason,/A row needs review/);
 const complete=present({...base,plan_status:'SUCCEEDED',execution_status:'SUCCEEDED',verified:1});assert.equal(complete.reason,null);assert.equal(complete.stageLabel,'Inventory saved and verified');
 const preview=present({...base,preview_status:'RUNNING',preview_result:{previewProgress:{stage:'checking',processedRows:0,totalRows:10000,attempt:1}}});assert.equal(preview.attempt,1);assert.doesNotMatch(preview.stageLabel,/Attempt 2/);
});

test('prepared row counts survive the durable progress boundary without claiming stock was saved',async()=>{
 const job={workspaceId:'fixture',id:'job',leaseToken:'lease'},progress=require('../../src/imports/postgres-progress');let stored;
 const database={query:async(sql,values)=>{stored=JSON.parse(values[3]);return {rowCount:1};}};
 assert(await progress.record(database,job,{stage:'preparing',processedRows:0,totalRows:1200,preparedRows:500,attempt:1}));
 const state=present({id:'fixture',records_detected:1200,records_valid:1200,plan_status:'READY',approval_status:'APPROVED',job_status:'RUNNING',lease_expires_at:2000,database_now:1000,job_result:{importProgress:stored}});
 assert.equal(state.preparedRows,500);assert.equal(state.processedRows,0);assert.equal(state.verified,false);
 await assert.rejects(progress.record(database,job,{stage:'preparing',processedRows:0,totalRows:1200,preparedRows:1201}),/Invalid prepared/);
});
test('preview recalculation is active work but never claims inventory or accounting execution',()=>{
 const state=present({id:'review',records_detected:1503,records_valid:0,records_invalid:1503,plan_status:'READY',approval_status:'AWAITING_APPROVAL',preview_status:'RUNNING',preview_updated_at:'2026-10-22T10:00:00Z',preview_result:{previewProgress:{stage:'checking',processedRows:500,totalRows:1503,attempt:2}}});
 assert.equal(state.state,'UPDATING_PREVIEW');assert(state.active);assert(!state.finished);assert(!state.verified);assert.equal(state.processedRows,500);assert.equal(state.readyRows,1503);assert.match(state.stageLabel,/Attempt 2/);assert.match(state.stageLabel,/no inventory changes/);assert.equal(state.completedAt,null);
});
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

test('import estimates use only rows saved in this attempt and show per-inventory queue position',()=>{
 const base={id:'timing',records_valid:10000,records_detected:10000,plan_status:'READY',approval_status:'APPROVED',job_status:'RUNNING',lease_expires_at:2000,database_now:1000,job_result:{importProgress:{stage:'processing',processedRows:5500,totalRows:10000,attemptStartRows:5000,elapsedMs:10000}}};
 const state=present(base);assert.equal(state.estimatedSeconds,90);assert.match(state.estimateLabel,/About 2 minutes/);assert.equal(present({...base,job_status:'PENDING',queue_ahead:2}).queuePosition,3);assert.match(present({...base,job_status:'PENDING',queue_ahead:2}).queueLabel,/Earlier imports/);assert.equal(present({...base,job_result:{importProgress:{...base.job_result.importProgress,attemptStartRows:5500}}}).estimatedSeconds,null);assert.equal(present({...base,job_status:'PAUSED'}).estimatedSeconds,null);
});
