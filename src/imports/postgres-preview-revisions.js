'use strict';
const crypto=require('node:crypto');
const imports=require('./postgres-service'),jobs=require('../operations/postgres-job-queue');
const {ValidationError,NotFoundError}=require('../domain/errors');
const ACTIVE=['PENDING','RUNNING','RETRY'];
async function latest(database,workspaceId,planId){
 const row=(await database.query(`SELECT id,status,result,last_error,attempt_count,created_at,updated_at,started_at,lease_expires_at,payload->>'totalRows' total_rows FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='import.revise-preview' AND payload->>'planId'=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,[workspaceId,planId])).rows[0];
 if(!row)return null;
 const p=row.result?.previewProgress;
 const state={id:row.id,status:row.status,active:ACTIVE.includes(row.status),attempt:Number(row.attempt_count),processedRows:p?.processedRows??0,totalRows:p?.totalRows??(row.total_rows===null?null:Number(row.total_rows)),queuedAt:row.created_at,startedAt:row.started_at,lastUpdateAt:row.updated_at};
 if(row.status==='COMPLETED'&&state.totalRows!==null)state.processedRows=state.totalRows;
 state.label=row.status==='COMPLETED'?'Preview updated':row.status==='RUNNING'?'Checking saved preview rows':row.status==='RETRY'?'Retrying the preview check safely':row.status==='PENDING'?'Preview update queued':'Preview update stopped';
 state.reason=row.last_error?.code==='57014'?'The preview check exceeded its database time limit. No inventory changed.':row.last_error?['validation_error','not_found','entitlement_required'].includes(row.last_error.code)?row.last_error.message:'The preview check was interrupted before completion. Review its saved state before trying again. No stock or Money was imported.':null;
 return state;
}
async function queue(database,ctx,id,input){
 // A fast unchanged-tracking save still goes through the service's complete
 // authority, current-hash and tracking-input validation.
 const plan=await imports.get(database,ctx.workspaceId,id);
 if((await latest(database,ctx.workspaceId,id))?.active)throw new ValidationError('A preview update is already saved. Its progress is shown above; no second update was started.');
 if(plan.recordsDetected<=500||require('./preview-revision-input').unchangedTracking(plan,input)){
  return {plan:await imports.revise(database,ctx,id,input),queued:false};
 }
 const actor=(await database.query('SELECT * FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');
 const permissions=require('../actions/permissions');permissions.assertCan(actor,permissions.OPERATE,'review inventory data');
 return database.transaction(async client=>{
  const saved=(await client.query('SELECT * FROM import_plans WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,id])).rows[0];
  if(!saved)throw new NotFoundError('That import could not be found.');
  if(saved.status!=='READY'||saved.approval_status!=='AWAITING_APPROVAL'||saved.integrity_hash!==input.expectedHash)throw new ValidationError('The preview changed. Review the current preview before saving choices.');
  const active=await latest(client,ctx.workspaceId,id);
  if(active?.active)throw new ValidationError('A preview update is already saved. Its progress is shown above; no second update was started.');
  const scoped={query:(sql,values)=>client.query(sql,values),transaction:fn=>fn(client)};
  const key=crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const queued=await jobs.enqueue(scoped,{workspaceId:ctx.workspaceId,kind:'import.revise-preview',idempotencyKey:`${id}:${input.expectedHash}:${key}`,payload:{planId:id,actorId:ctx.actorId,input,totalRows:plan.recordsDetected},priority:35,maxAttempts:3});
  if(queued.job.status==='DEAD')await jobs.retryDead(scoped,queued.job.id,ctx.workspaceId,{by:ctx.actorId});
  return {...queued,queued:true};
 },{isolation:'READ COMMITTED'});
}
async function run(job,database){
 const {planId,actorId,input}=job.payload||{};
 if(!job.workspaceId||!planId||!actorId||!input?.expectedHash)throw Object.assign(new Error('The saved preview update is missing its source identity.'),{retryable:false});
 // The commit receipt shares the preview transaction. A worker restart after
 // commit must complete the same job without revising a second time.
 const current=await jobs.get(database,job.id,job.workspaceId);
 if(current?.result?.committedHash){
  const plan=await imports.get(database,job.workspaceId,planId);
  if(plan.integrityHash===current.result.committedHash)return {planId,integrityHash:plan.integrityHash,recovered:true};
  throw Object.assign(new Error('The preview changed after this saved update. Review its current result.'),{retryable:false});
 }
 const leaseMs=60000;let lost=false,pending=Promise.resolve(),lastPublish=0,progress=null,committing=false;
 const publish=async value=>{const updated=await database.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('previewProgress',$4::jsonb),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND result->>'committedHash' IS NULL AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken,JSON.stringify({...value,attempt:job.attemptCount})]);if(!updated.rowCount)lost=true;};
 const timer=setInterval(()=>{pending=pending.then(async()=>{if(!await jobs.heartbeat(database,job.id,job.leaseToken,{leaseMs}))lost=true;if(!lost&&!committing&&progress)await publish(progress);}).catch(()=>{lost=true;});},2500);timer.unref();
 const assertLease=()=>{if(lost)throw Object.assign(new Error('The preview worker was interrupted before saving. No stock changed.'),{code:'preview_lease_lost'});};
 try{
  const result=await imports.revise(database,{workspaceId:job.workspaceId,actorId},planId,input,{jobId:job.id,
   onProgress:async value=>{progress=value;assertLease();if(Date.now()-lastPublish<750&&value.processedRows!==0&&value.processedRows!==value.totalRows)return;lastPublish=Date.now();await publish(value);assertLease();},
   beforeCommit:async(client,plan)=>{committing=true;await pending;assertLease();
    const updated=await client.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('committedHash',$4::text,'previewProgress',$5::jsonb),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken,plan.integrityHash,JSON.stringify({processedRows:plan.recordsDetected,totalRows:plan.recordsDetected,attempt:job.attemptCount})]);if(!updated.rowCount)throw Object.assign(new Error('The preview worker lost ownership before saving. No stock changed.'),{code:'preview_lease_lost'});
   }});
  return {planId,integrityHash:result.integrityHash,previewProgress:{processedRows:result.recordsDetected,totalRows:result.recordsDetected,attempt:job.attemptCount}};
 }catch(error){if(error instanceof ValidationError||error instanceof NotFoundError)error.retryable=false;throw error;}
 finally{clearInterval(timer);await pending;}
}
module.exports={queue,latest,run};
require('../commercial/enforcement').guardExports(module.exports,0,1,{queue:'imports.spreadsheet'});
