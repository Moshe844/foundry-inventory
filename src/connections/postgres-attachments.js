'use strict';
const {createHash}=require('node:crypto'),path=require('node:path'),{ValidationError,NotFoundError}=require('../domain/errors');
// A bounded, cost-free document preprocessor, never a business decision maker.
// Email and attachment text remain untrusted evidence for the actual agent.
async function extractMessage(database,workspaceId,messageId){
 const message=(await database.query('SELECT id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2',[workspaceId,messageId])).rows[0];if(!message)throw new NotFoundError('That message is not in this business.');
 const rows=(await database.query('SELECT id,filename,content,content_hash,extracted_text,extraction_status FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2 ORDER BY id',[workspaceId,messageId])).rows,results=[],deadline=Date.now()+60000;
 for(const row of rows){let text=row.extracted_text,status='READABLE',error=null;
  try{
    if(!['.pdf','.txt'].includes(path.extname(row.filename).toLowerCase()))throw new ValidationError('This attachment format needs a manual document review.');
    if(!Buffer.isBuffer(row.content)||!row.content.length||row.content.length>20*1024*1024)throw new ValidationError('The original attachment is unavailable or too large.');
    if(createHash('sha256').update(row.content).digest('hex')!==row.content_hash)throw new ValidationError('The saved attachment failed its integrity check.');
    if(row.extraction_status!=='READABLE'||!text){if(Date.now()>deadline)throw new ValidationError('This message has more documents than can be read in one bounded review. The remaining originals need review.');text=await require('./document-reader').read({filename:row.filename,buffer:row.content});}
  }catch(e){status='NEEDS_REVIEW';error=e instanceof ValidationError?e.message:'StockChief could not read this attachment completely. Review the original before using its figures.';}
  await database.query(`UPDATE connection_email_attachments SET extracted_text=$4,extraction_status=$5,extraction_error=$6
    WHERE workspace_id=$1 AND message_id=$2 AND id=$3 AND content_hash=$7`,[workspaceId,messageId,row.id,text||null,status,error,row.content_hash]);
  results.push({attachmentId:row.id,status,characters:text?.length||0});
 }
 const review=await require('./postgres-document-review').prepare(database,workspaceId,messageId);
 return {messageId,attachments:results,modelCalls:0,businessEffects:0,review};
}
async function textPage(database,workspaceId,messageId,id,offset=0){
 if(!Number.isSafeInteger(offset)||offset<0)throw new ValidationError('Choose a valid document page.');
 const row=(await database.query(`SELECT id,filename,content_hash,extracted_text,extraction_status,extraction_error FROM connection_email_attachments
   WHERE workspace_id=$1 AND message_id=$2 AND id=$3`,[workspaceId,messageId,id])).rows[0];if(!row)throw new NotFoundError('That attachment is not in this message.');
 const text=row.extracted_text||'';if(offset>text.length)throw new ValidationError('That document page is unavailable.');
 return {id:row.id,filename:row.filename,contentHash:row.content_hash,status:row.extraction_status,error:row.extraction_error,text:text.slice(offset,offset+6000),offset,total:text.length,next:offset+6000<text.length?offset+6000:null,previous:offset?Math.max(0,offset-6000):null};
}
async function requestRecheck(database,ctx,messageId){
 const actor=(await database.query('SELECT u.role,u.permissions FROM users u JOIN workspaces w ON w.id=u.workspace_id WHERE u.workspace_id=$1 AND u.id=$2 AND w.deletion_requested_at IS NULL',[ctx.workspaceId,ctx.actorId])).rows[0];
 if(!actor)throw new (require('../domain/errors').AuthorizationError)('Current business membership is required.');
 require('../actions/permissions').assertCan(actor,require('../actions/permissions').OPERATE,'read saved attachments again');
 const entitlements=require('../entitlements/postgres-service'),scope=await entitlements.ownerScopeForWorkspace(database,ctx.workspaceId);await entitlements.assertCapability(database,scope,'email.auto_extract');
 return database.transaction(async client=>{
  const message=(await client.query('SELECT id FROM connection_email_messages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.workspaceId,messageId])).rows[0];
  if(!message)throw new NotFoundError('That message is not in this business.');
  const rows=(await client.query('SELECT id FROM connection_email_attachments WHERE workspace_id=$1 AND message_id=$2',[ctx.workspaceId,messageId])).rows;
  if(!rows.length)throw new ValidationError('This message has no saved attachment to read.');
  const active=(await client.query("SELECT id,status FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND kind='mail.attachment-extract' AND payload->>'messageId'=$2 AND status IN ('PENDING','RUNNING','RETRY') ORDER BY created_at DESC LIMIT 1",[ctx.workspaceId,messageId])).rows[0];
  if(active)return {jobId:active.id,status:active.status,replayed:true};
  const scoped={query:(sql,values)=>client.query(sql,values),transaction:work=>work(client)},job=await require('../operations/postgres-job-queue').enqueue(scoped,{workspaceId:ctx.workspaceId,kind:'mail.attachment-extract',idempotencyKey:'attachment-recheck:'+messageId+':'+require('node:crypto').randomUUID(),payload:{messageId},priority:45,maxAttempts:2});
  await client.query("UPDATE connection_email_attachments SET extraction_status='PENDING',extracted_text=NULL,extraction_error=NULL WHERE workspace_id=$1 AND message_id=$2",[ctx.workspaceId,messageId]);
  return {jobId:job.job.id,status:job.job.status,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function readingStatus(database,workspaceId,messageId){
 // Own record, file states and current job share one database snapshot.
 const row=(await database.query(`SELECT m.id,m.native_review_goal_id,m.native_review_state,m.native_review_reason,
  g.status AS review_status,jsonb_build_object('lifecycleStage',g.checkpoint->'lifecycleStage',
   'navigation',g.checkpoint->'navigation','harness',jsonb_build_object(
    'requestRefused',g.checkpoint#>'{harness,requestRefused}','failure',g.checkpoint#>'{harness,failure}',
    'interruption',g.checkpoint#>'{harness,interruption}','admissionBlock',g.checkpoint#>'{harness,admissionBlock}',
    'modelUsagePending',g.checkpoint#>'{harness,modelUsagePending}')) AS review_checkpoint,
  files.attachments,job.status AS job_state,job.created_at AS job_created_at
  FROM connection_email_messages m
  LEFT JOIN stockchief_runtime.assistant_goals g ON g.workspace_id=m.workspace_id AND g.id=m.native_review_goal_id
  LEFT JOIN LATERAL (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.filename,f.id),'[]'::jsonb) AS attachments
   FROM (SELECT id,filename,mime_type,extraction_status,extraction_error FROM connection_email_attachments WHERE workspace_id=m.workspace_id AND message_id=m.id) f) files ON true
  LEFT JOIN LATERAL (SELECT status,created_at FROM stockchief_runtime.jobs WHERE workspace_id=m.workspace_id AND kind='mail.attachment-extract' AND payload->>'messageId'=m.id
   ORDER BY (status IN ('PENDING','RUNNING','RETRY')) DESC,created_at DESC,id DESC LIMIT 1) job ON true
  WHERE m.workspace_id=$1 AND m.id=$2`,[workspaceId,messageId])).rows[0];
 if(!row)throw new NotFoundError('That message is not in this business.');
 const active=['PENDING','RUNNING','RETRY'].includes(row.job_state),ready=row.attachments.filter(f=>f.extraction_status==='READABLE').length;
 let review=null;
 if(row.native_review_goal_id&&row.review_status){const state=require('../assistant/agent-conversation').state({id:row.native_review_goal_id,status:row.review_status,checkpoint:row.review_checkpoint});
  review={phase:state.phase,label:state.label,active:['queued','working','verification','external_wait','navigation'].includes(state.phase),href:'/ask?goal='+encodeURIComponent(row.native_review_goal_id)+'#focused-goal'};
 }else if(row.native_review_goal_id)review={phase:'unavailable',label:'Review is unavailable',active:false,href:null};
 else if(row.native_review_state==='NEEDS_REVIEW')review={phase:'needs_review',label:'This document needs attention',reason:row.native_review_reason,active:false,href:null};
 return {attachments:row.attachments,active,jobState:row.job_state||null,startedAt:active?row.job_created_at:null,ready,total:row.attachments.length,stopped:row.job_state==='DEAD',review};
}
module.exports={extractMessage,textPage,requestRecheck,readingStatus};
