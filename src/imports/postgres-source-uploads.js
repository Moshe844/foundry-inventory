'use strict';
const crypto=require('node:crypto'),{newId}=require('../lib/util'),jobs=require('../operations/postgres-job-queue'),imports=require('./postgres-service');
const {ValidationError,NotFoundError}=require('../domain/errors'),permissions=require('../actions/permissions');
const ACTIVE=['PENDING','RUNNING','RETRY'];
async function operator(database,ctx){const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];if(!actor)throw new ValidationError('The acting user does not belong to this inventory.');permissions.assertCan(actor,permissions.OPERATE,'prepare an import preview');}
function present(row){
 const p=row.result?.sourceProgress||{},ready=Boolean(row.plan_id),active=!ready&&ACTIVE.includes(row.job_status),expired=new Date(row.expires_at).getTime()<Date.now();
 const labels={reading:'Reading your file',matching:'Matching worksheets and source records',understanding:'Checking unclear source meanings',checking:'Checking product identities and stock quantities',saving:'Preparing your saved preview'};
 const failure=row.last_error;
 const reason=failure?failure.code==='57014'?'The file check exceeded its database time limit. The previous attempt was rolled back.':['validation_error','not_found','rate_limited','entitlement_required'].includes(failure.code)?failure.message:'StockChief could not finish reading this file. Your saved upload is retained; retry from here or contact support.':null;
 const totalRows=ready?Number(row.plan_rows):Number.isSafeInteger(p.totalRows)?p.totalRows:null;
 return {id:row.id,sourceName:row.source_name,sourceBytes:Number(row.source_bytes),active,ready,status:ready?'READY':active?row.job_status:'STOPPED',stage:ready?'ready':p.stage||'queued',label:ready?'Your preview is ready':active?labels[p.stage]||'File saved — waiting for a reading worker':'File reading stopped',processedRows:ready?totalRows:Number.isSafeInteger(p.processedRows)?p.processedRows:null,totalRows,worksheets:p.worksheets??null,createdAt:row.created_at,startedAt:row.started_at,lastUpdateAt:row.updated_at||row.created_at,reason,canRetry:!ready&&!expired&&row.job_status==='DEAD',href:'/imports/uploads/'+row.id,previewHref:ready?'/imports/'+row.plan_id:null};
}
const projection=`SELECT u.id,u.source_name,u.source_bytes,u.plan_id,u.expires_at,u.created_at,j.status AS job_status,j.started_at,j.updated_at,j.result,j.last_error,p.records_detected AS plan_rows FROM import_source_uploads u JOIN stockchief_runtime.jobs j ON j.id=u.job_id AND j.workspace_id=u.workspace_id LEFT JOIN import_plans p ON p.id=u.plan_id AND p.workspace_id=u.workspace_id`;
async function get(database,workspaceId,id){const row=(await database.query(projection+' WHERE u.workspace_id=$1 AND u.id=$2',[workspaceId,id])).rows[0];if(!row)throw new NotFoundError('That saved file could not be found in this inventory.');return present(row);}
async function list(database,workspaceId,{activeOnly=false,limit=10}={}){return(await database.query(projection+` WHERE u.workspace_id=$1 AND u.plan_id IS NULL AND ($2::boolean=false OR j.status IN ('PENDING','RUNNING','RETRY')) ORDER BY u.created_at DESC,u.id DESC LIMIT $3`,[workspaceId,activeOnly,Math.min(20,Math.max(1,limit))])).rows.map(present);}
async function enqueue(database,ctx,input){
 await operator(database,ctx);const bytes=input.buffer||Buffer.from(String(input.text||''),'utf8');
 if(!bytes.length)throw new ValidationError('Choose a file, or paste your data.');
 if(bytes.length>require('../config').uploads.maxBytes)throw new ValidationError('This file exceeds the displayed upload size limit.');
 const sourceHash=crypto.createHash('sha256').update(bytes).digest('hex'),key=String(input.requestKey||newId('source'));
 if(!/^[a-zA-Z0-9:_-]{1,200}$/.test(key))throw new ValidationError('Reload the upload form before saving this file.');
 const options={isText:!input.buffer,defaultLocationId:input.defaultLocationId||null,usageKey:input.usageKey||require('./usage-key').analysisUsageKey(sourceHash),...(Number.isInteger(input.sheetIndex)?{sheetIndex:input.sheetIndex}:{}),...(input.allowModel===false?{allowModel:false}:{}),...(input.sourceContext?{sourceContext:String(input.sourceContext).slice(0,4000)}:{})};
 const id=await database.transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['source-upload',ctx.workspaceId,ctx.actorId,key])]);
  const prior=(await client.query('SELECT id,source_hash,input_options FROM import_source_uploads WHERE workspace_id=$1 AND actor_id=$2 AND request_key=$3',[ctx.workspaceId,ctx.actorId,key])).rows[0];
  if(prior){if(prior.source_hash!==sourceHash||JSON.stringify(Object.entries(prior.input_options).sort())!==JSON.stringify(Object.entries(options).sort()))throw new ValidationError('That upload request already belongs to another file or set of choices. Select the file again to start a separate preview.');return prior.id;}
  if(options.defaultLocationId&&!(await client.query('SELECT 1 FROM locations WHERE workspace_id=$1 AND id=$2 AND is_active=1',[ctx.workspaceId,options.defaultLocationId])).rows.length)throw new ValidationError('Choose a location in this inventory.');
  const uploadId=newId('upl'),scoped={query:(sql,values)=>client.query(sql,values),transaction:fn=>fn(client)},queued=await jobs.enqueue(scoped,{workspaceId:ctx.workspaceId,kind:'import.analyse-source',idempotencyKey:`source:${ctx.actorId}:${key}`,payload:{uploadId,actorId:ctx.actorId},priority:35,maxAttempts:1});
  await client.query(`INSERT INTO import_source_uploads(id,workspace_id,actor_id,job_id,request_key,source_name,source_hash,source_bytes,source_content,input_options) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[uploadId,ctx.workspaceId,ctx.actorId,queued.job.id,key,String(input.filename||'Pasted inventory data').slice(0,500),sourceHash,bytes.length,bytes,JSON.stringify(options)]);return uploadId;
 },{isolation:'READ COMMITTED'});
 return get(database,ctx.workspaceId,id);
}
async function retry(database,ctx,id){await operator(database,ctx);const saved=(await database.query('SELECT job_id,plan_id,source_content IS NOT NULL AS retained,expires_at FROM import_source_uploads WHERE workspace_id=$1 AND id=$2 AND actor_id=$3',[ctx.workspaceId,id,ctx.actorId])).rows[0];if(!saved)throw new NotFoundError('That saved upload could not be found.');if(saved.plan_id)return get(database,ctx.workspaceId,id);if(!saved.retained||new Date(saved.expires_at).getTime()<=Date.now())throw new ValidationError('This upload has expired. Upload the source again to prepare a fresh preview.');if(!await jobs.retryDead(database,saved.job_id,ctx.workspaceId,{by:ctx.actorId}))throw new ValidationError('This file is already being checked. Its saved progress is shown here.');return get(database,ctx.workspaceId,id);}
async function run(job,database,{provider=null}={}){
 const ctx={workspaceId:job.workspaceId,actorId:job.payload?.actorId},id=job.payload?.uploadId;
 const source=(await database.query('SELECT * FROM import_source_uploads WHERE workspace_id=$1 AND id=$2 AND actor_id=$3 AND job_id=$4',[ctx.workspaceId,id,ctx.actorId,job.id])).rows[0];if(!source)throw Object.assign(new NotFoundError('The saved upload is no longer available.'),{retryable:false});
 if(source.plan_id){const plan=await imports.get(database,ctx.workspaceId,source.plan_id);if(plan.sourceHash!==source.source_hash)throw new Error('Saved source and preview do not reconcile.');return {uploadId:id,planId:plan.id,recovered:true};}
 if(!source.source_content||new Date(source.expires_at).getTime()<Date.now())throw Object.assign(new ValidationError('This saved upload expired. Upload the file again.'),{retryable:false});
 if(crypto.createHash('sha256').update(source.source_content).digest('hex')!==source.source_hash)throw Object.assign(new ValidationError('The saved file failed its integrity check. Upload the original again.'),{retryable:false});
 let lost=false,committing=false,progress={stage:'reading'},pending=Promise.resolve(),lastPublish=0;const leaseMs=120000;
 const publish=async()=>{if(!await database.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('sourceProgress',$4::jsonb),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND result->>'committedPlan' IS NULL AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) RETURNING id`,[ctx.workspaceId,job.id,job.leaseToken,JSON.stringify(progress)]).then(r=>r.rowCount))lost=true;};
 const heartbeat=async()=>{if(!await jobs.heartbeat(database,job.id,job.leaseToken,{leaseMs}))lost=true;};
 await heartbeat();const timer=setInterval(()=>{pending=pending.then(async()=>{await heartbeat();if(!lost&&!committing)await publish();}).catch(()=>{lost=true;});},2500);timer.unref();
 const assertLease=()=>{if(lost)throw Object.assign(new Error('The file-reading worker was interrupted before saving.'),{code:'source_lease_lost'});};
 try{
  const options=source.input_options,report=async value=>{progress={...progress,...value};assertLease();if(Date.now()-lastPublish<750)return;lastPublish=Date.now();await publish();assertLease();};
  const plan=await imports.analyse(database,ctx,{...options,...(options.isText?{text:source.source_content.toString('utf8')}:{buffer:source.source_content,filename:source.source_name}),provider,sourceJobId:job.id,onProgress:report,onBeforeAi:()=>report({stage:'understanding'}),beforeCommit:async(client,plan)=>{
   committing=true;await pending;assertLease();
   const fenced=await client.query(`UPDATE stockchief_runtime.jobs SET result=jsonb_build_object('committedPlan',$4::text),updated_at=now() WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND status='RUNNING' AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000) RETURNING id`,[ctx.workspaceId,job.id,job.leaseToken,plan.id]);if(!fenced.rowCount)throw new Error('The source-reading lease expired before saving.');
   const linked=await client.query('UPDATE import_source_uploads SET plan_id=$3,source_content=NULL WHERE workspace_id=$1 AND id=$2 AND plan_id IS NULL AND source_hash=$4',[ctx.workspaceId,id,plan.id,plan.sourceHash]);if(!linked.rowCount)throw new Error('The saved upload changed before its preview could commit.');
  }});
  return {uploadId:id,planId:plan.id};
 }finally{clearInterval(timer);await pending;}
}
module.exports={enqueue,get,list,retry,run,present};
require('../commercial/enforcement').guardExports(module.exports,0,1,{enqueue:'imports.spreadsheet',retry:'imports.spreadsheet'});
