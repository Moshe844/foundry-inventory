'use strict';

const {NotFoundError}=require('../domain/errors');

function present(row){
 const verified=row.plan_status==='SUCCEEDED'&&row.execution_status==='SUCCEEDED'&&Number(row.verified)===1;
 const running=row.job_status==='RUNNING'&&Number(row.lease_expires_at)>Number(row.database_now);
 const revising=['PENDING','RUNNING','RETRY'].includes(row.preview_status);
 let state,label;
 if(verified){state='VERIFIED';label='Import complete and verified';}
 else if(revising){state='UPDATING_PREVIEW';label='Updating your import preview';}
 else if(['PENDING','RETRY'].includes(row.job_status)){state='QUEUED';label='Import queued';}
 else if(running||!row.job_status&&row.execution_status==='EXECUTING'){state='RUNNING';label='Importing your inventory';}
 else if(row.plan_status==='CANCELLED'||row.job_status==='CANCELLED'){state='CANCELLED';label='Import stopped';}
 else if(['RUNNING','PAUSED'].includes(row.job_status)){state='PAUSED';label='Import paused before verification';}
 else if(row.execution_stage==='paused'){state='PAUSED';label='Import paused; saved rows are safe';}
 else if(['DEAD','COMPLETED'].includes(row.job_status)||['FAILED','SUCCEEDED'].includes(row.execution_status)||['FAILED','SUCCEEDED'].includes(row.plan_status)){state='NEEDS_REVIEW';label='Import needs review';}
 else if(row.approval_status==='APPROVED'){state='APPROVED';label='Approved — ready to start';}
 else if(row.needs_source_review===true){state='NEEDS_INPUT';label='Needs your answer';}
 else{state='AWAITING_APPROVAL';label='Waiting for your approval';}
 const iso=value=>value?new Date(value).toISOString():null;
 let detail=row.job_result;if(typeof detail==='string'){try{detail=JSON.parse(detail);}catch{detail=null;}}
 const p=revising?row.preview_result?.previewProgress:detail?.importProgress,known=Boolean(p&&(revising?p.stage==='checking':['preparing','processing','verifying'].includes(p.stage))&&Number.isSafeInteger(p.processedRows)&&Number.isSafeInteger(p.totalRows)&&p.processedRows>=0&&p.processedRows<=p.totalRows&&p.totalRows===Number(revising?row.records_detected:row.records_valid));
 // Before the worker's first progress write, the saved checkpoint says which
 // step is running: a product import prepares its catalogue before saving
 // stock. Supplier files have no catalogue step.
 const savedStep=row.dataset==='suppliers'||row.apply_checkpoint?.cataloguePrepared===true&&row.apply_checkpoint?.hash===row.integrity_hash?'processing':'preparing';
 const stage=verified?'complete':revising?'preview':known&&state==='RUNNING'?p.stage:state==='RUNNING'?savedStep:state.toLowerCase();
 // Job history retains the previous error while an automatic retry runs. Only
 // stopped attempts need review; a healthy retry must not ask users to resume it.
 const stopped=['PAUSED','NEEDS_REVIEW'].includes(state);
 // Direct executions and recovered historical attempts may have an execution
 // error without a queue error. A stopped attempt must still explain the pause;
 // do not expose an unclassified database/worker exception to the customer.
 const failure=stopped?(row.job_error||{code:row.execution_status==='SUCCEEDED'?'import_verification_incomplete':'import_execution_interrupted'}):null;
 let reason=failure?.code==='57014'?'This attempt exceeded the database time limit and was rolled back. No stock or inventory value from this attempt was saved.':failure?.code==='53200'?'The database ran out of memory for its transaction safety checks. This attempt was rolled back. No stock or inventory value was saved.':failure?.code==='import_lease_lost'?'The worker connection was interrupted before saving. The attempt was rolled back.':failure?'The import could not finish safely. Review its saved result before retrying.':null;
 const checkpoint=row.apply_checkpoint||{},durable=(checkpoint.cataloguePrepared===true||checkpoint.catalogueStarted===true)&&checkpoint.hash===row.integrity_hash,savedRows=durable?Number(checkpoint.savedRows||0):0;
 const detailsPending=!durable&&state==='RUNNING'&&stage==='processing'&&known&&p.totalRows>0&&p.processedRows===p.totalRows&&row.dataset!=='suppliers';
 if(durable&&failure)reason=savedRows.toLocaleString()+' rows are already saved with their stock and accounting. '+(failure.code==='validation_error'?String(row.execution_error||failure.message||'The remaining rows need review.'):failure.code==='57014'?'The last batch exceeded the database time limit.':failure.code==='53200'?'The database ran out of memory for the last batch.':'The worker was interrupted during the last batch.')+' Continue resumes the approved rows without repeating saved ones.';
 if(failure?.code==='import_verification_incomplete')reason='Final checks have not confirmed this import. Review the saved result or contact support before applying it again.';
 const applied=Number(p?.processedRows)-Number(p?.attemptStartRows),elapsedMs=Number(p?.elapsedMs),remaining=Number(row.records_valid)-Number(p?.processedRows);
 const prepared=Number(p?.preparedRows),preparing=state==='RUNNING'&&known&&stage==='preparing'&&Number.isSafeInteger(prepared);
 // Preparing creates new SKUs; measure it against them when the import says how many.
 const preparedTotal=Number.isSafeInteger(p?.preparedTotal)&&p.preparedTotal>0?p.preparedTotal:null,prepareGoal=preparedTotal??p?.totalRows;
 // Preparing has its own pace: estimate what is left of it from rows prepared so far.
 const preparingSeconds=preparing&&prepared>=500&&Number.isSafeInteger(elapsedMs)&&elapsedMs>=5000&&prepared<prepareGoal?Math.ceil((prepareGoal-prepared)/prepared*elapsedMs/1000):null;
 const estimatedSeconds=state==='RUNNING'&&known&&stage==='processing'&&Number.isSafeInteger(applied)&&applied>=500&&Number.isSafeInteger(elapsedMs)&&elapsedMs>=5000&&remaining>0?Math.ceil(remaining/applied*elapsedMs/1000):null;
 const queuePosition=state==='QUEUED'?Math.max(1,Number(row.queue_ahead||0)+1):null;
 const minutes=seconds=>Math.max(1,Math.ceil(seconds/60))+' minute'+(Math.ceil(seconds/60)<=1?'':'s');
 const estimateLabel=preparingSeconds!==null?'About '+minutes(preparingSeconds)+' left to prepare, then records are saved in batches.':estimatedSeconds===null?'Estimating time remaining after the next saved batch.':'About '+Math.max(1,Math.ceil(estimatedSeconds/60))+' minute'+(Math.ceil(estimatedSeconds/60)===1?'':'s')+' remaining at the current speed, plus final checks.';
 const queueLabel=queuePosition===null?'':'Queue position '+queuePosition+' in this inventory. '+(queuePosition===1?'Waiting for an available worker.':'Earlier imports must finish first; the wait depends on their size.');
 const attempt=revising?(known?Number(p.attempt||1):null):Math.max(known?Number(p.attempt||1):0,Number(row.job_attempt_count||0))||null;
 const stageLabel=(attempt>1&&['RUNNING','UPDATING_PREVIEW'].includes(state)?'Attempt '+attempt+' · '+(durable?'resuming saved rows':'restarting safely after rollback')+' · ':'')+(detailsPending?'Applying imported details and reorder settings':{preview:'Checking your saved preview; no inventory changes',preparing:'Preparing approved records',processing:'Applying products, stock and costs',verifying:'Checking stock and accounting totals',complete:'Inventory saved and verified',queued:row.waiting_for_import?'Waiting for the running import in this inventory':'Waiting for an available worker',paused:'Waiting for review',needs_review:'Review required',needs_input:'Resolve the preview questions',approved:'Approved and ready to start',awaiting_approval:'Review and approve the preview',cancelled:'Stopped'}[stage]||'Checking saved progress');
 return {id:row.id,sourceName:row.source_name,rows:Number(row.records_detected),readyRows:Number(revising?row.records_detected:row.records_valid),
  invalidRows:Number(row.records_invalid),state,label,reason,active:['QUEUED','RUNNING','UPDATING_PREVIEW'].includes(state),working:state==='RUNNING',
  verified,finished:!['QUEUED','RUNNING','UPDATING_PREVIEW'].includes(state),status:row.plan_status,
  createdAt:iso(row.created_at),queuedAt:iso(row.queued_at),startedAt:state==='QUEUED'?null:iso(row.started_at),
  completedAt:['QUEUED','RUNNING','UPDATING_PREVIEW'].includes(state)?null:iso(row.committed_at||row.job_finished_at||row.finished_at),
  stage,stageLabel,estimatedSeconds,estimateLabel,queuePosition,queueLabel,detailsPending,durable,savedRows,cataloguePrepared:checkpoint.cataloguePrepared===true,attempt,preparedRows:known&&Number.isSafeInteger(p.preparedRows)?p.preparedRows:null,preparedTotal:known?preparedTotal:null,processedRows:verified?Number(row.records_valid):durable?savedRows:known?p.processedRows:null,
  // One bar for the whole import: preparing fills the first quarter, saving
  // batches the rest, so the bar moves from the first prepared row.
  progressPercent:verified?100:preparing&&prepareGoal?Math.min(24,Math.floor(prepared/prepareGoal*25)):durable&&Number(row.records_valid)?25+Math.min(74,Math.floor(savedRows/Number(row.records_valid)*74)):known&&p.totalRows?Math.min(99,Math.floor(p.processedRows/p.totalRows*100)):null,
  lastUpdateAt:iso(revising?row.preview_updated_at:row.job_updated_at||row.finished_at||row.started_at||row.created_at),
  href:'/imports/'+encodeURIComponent(row.id)};
}

async function list(database,workspaceId,{id=null,limit=10,activeOnly=false}={}){
 if(!workspaceId)throw new TypeError('Import progress requires a workspace.');
 const rows=(await database.query(`SELECT p.id,p.source_name,p.records_detected,p.records_valid,p.records_invalid,
   p.status AS plan_status,p.approval_status,p.created_at,p.apply_checkpoint,p.integrity_hash,COALESCE(p.transformations::jsonb->>'dataset','inventory') AS dataset,
   EXISTS(SELECT 1 FROM stockchief_runtime.jobs other WHERE other.workspace_id=p.workspace_id AND other.kind='import.execute-approved'
     AND other.status='RUNNING' AND other.payload->>'planId'<>p.id) AS waiting_for_import,
   (SELECT count(*)::int FROM stockchief_runtime.jobs other WHERE other.workspace_id=p.workspace_id AND other.kind='import.execute-approved' AND other.status IN ('PENDING','RETRY','RUNNING') AND other.payload->>'planId'<>p.id AND (other.status='RUNNING' OR other.available_at<=floor(extract(epoch FROM clock_timestamp())*1000)) AND (other.status='RUNNING' OR (other.priority,other.created_at,other.id)<(j.priority,j.created_at,j.id))) AS queue_ahead,
   (p.status='READY' AND p.approval_status='AWAITING_APPROVAL' AND (
     p.records_valid=0 OR
     NOT (p.transformations::jsonb ? 'workbook') AND (p.transformations::jsonb->>'sheetCount')::int>1 AND COALESCE(p.transformations::jsonb#>>'{worksheetScope,confirmed}','false')<>'true' OR
     EXISTS(SELECT 1 FROM import_rows r WHERE r.workspace_id=p.workspace_id AND r.import_id=p.id AND r.status='INVALID' AND r.problems::jsonb @> '[{"code":"accounting_not_ready"}]'::jsonb) OR
     (p.transformations::jsonb->>'existingStockRows')::int>0 AND NULLIF(p.transformations::jsonb->>'importMode','') IS NULL OR
     p.records_invalid>0 AND COALESCE(p.transformations::jsonb->>'allowPartialImport','false')<>'true' OR
     p.conflicts::jsonb<>'[]'::jsonb OR
     NOT (p.field_mappings::jsonb ? 'name' OR p.field_mappings::jsonb ? 'code') OR
     (p.source_kind='image' OR p.transformations::jsonb->>'visualSource'='true') AND COALESCE(p.transformations::jsonb->>'imageReadingConfirmed','false')<>'true' OR
     p.records_invalid>0 AND (p.transformations::jsonb ? 'workbook' OR p.field_mappings::jsonb ? 'serialTracked' OR p.field_mappings::jsonb ? 'lotTracked'))) AS needs_source_review,
   r.status AS preview_status,r.result AS preview_result,r.updated_at AS preview_updated_at,
   j.status AS job_status,j.attempt_count AS job_attempt_count,j.last_error AS job_error,j.lease_expires_at,
   j.created_at AS queued_at,j.updated_at AS job_updated_at,j.completed_at AS job_finished_at,j.result AS job_result,COALESCE(j.started_at,e.started_at::timestamptz) AS started_at,e.status AS execution_status,e.stage AS execution_stage,e.error_message AS execution_error,
   e.finished_at,e.committed_at,v.verified,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS database_now
  FROM import_plans p
  LEFT JOIN LATERAL(SELECT job.status,job.result,job.updated_at FROM stockchief_runtime.jobs job
   WHERE job.workspace_id=p.workspace_id AND job.kind='import.revise-preview' AND job.payload->>'planId'=p.id
   ORDER BY job.created_at DESC,job.id DESC LIMIT 1)r ON true
  LEFT JOIN LATERAL(SELECT job.id,job.priority,job.status,job.attempt_count,job.last_error,job.lease_expires_at,job.created_at,job.started_at,job.completed_at,job.updated_at,job.result FROM stockchief_runtime.jobs job
   WHERE job.workspace_id=p.workspace_id AND job.kind='import.execute-approved' AND job.payload->>'planId'=p.id
   ORDER BY job.created_at DESC,job.id DESC LIMIT 1)j ON true
  LEFT JOIN LATERAL(SELECT run.id,run.status,run.stage,run.error_message,run.started_at,run.finished_at,run.committed_at FROM import_executions run
   WHERE run.workspace_id=p.workspace_id AND run.import_id=p.id ORDER BY run.started_at DESC,run.id DESC LIMIT 1)e ON true
  LEFT JOIN import_verifications v ON v.workspace_id=p.workspace_id AND v.execution_id=e.id
  WHERE p.workspace_id=$1 AND ($2::text IS NULL OR p.id=$2)
   AND ($2::text IS NOT NULL OR NOT EXISTS(SELECT 1 FROM record_removals x WHERE x.workspace_id=p.workspace_id AND x.kind='import' AND x.record_id=p.id AND x.status<>'FAILED'))
   AND ($3::boolean=false OR r.status IN ('PENDING','RETRY','RUNNING') OR j.status IN ('PENDING','RETRY','RUNNING') OR e.status='EXECUTING' OR p.status='READY' AND (p.apply_checkpoint->>'cataloguePrepared'='true' OR p.apply_checkpoint->>'catalogueStarted'='true'))
  ORDER BY p.created_at DESC,p.id DESC LIMIT $4`,[workspaceId,id,activeOnly,Math.min(50,Math.max(1,Number(limit)||10))])).rows;
 return rows.map(present);
}

async function get(database,workspaceId,id){
 const rows=await list(database,workspaceId,{id,limit:1});
 if(!rows.length)throw new NotFoundError('That import could not be found.');
 return rows[0];
}

async function record(database,job,value){
 if(!job.workspaceId||!job.leaseToken||!['preparing','processing','verifying'].includes(value.stage)||!Number.isSafeInteger(value.processedRows)||!Number.isSafeInteger(value.totalRows)||value.processedRows<0||value.processedRows>value.totalRows)throw new TypeError('Invalid import progress.');
 if(value.elapsedMs!==undefined&&(!Number.isSafeInteger(value.elapsedMs)||value.elapsedMs<0)||value.attemptStartRows!==undefined&&(!Number.isSafeInteger(value.attemptStartRows)||value.attemptStartRows<0||value.attemptStartRows>value.processedRows))throw new TypeError('Invalid import timing.');
 if(value.preparedRows!==undefined&&(!Number.isSafeInteger(value.preparedRows)||value.preparedRows<0||value.preparedRows>value.totalRows))throw new TypeError('Invalid prepared import progress.');
 if(value.preparedTotal!==undefined&&(!Number.isSafeInteger(value.preparedTotal)||value.preparedTotal<0||value.preparedTotal>value.totalRows))throw new TypeError('Invalid prepared import total.');
 return (await database.query(`UPDATE stockchief_runtime.jobs SET result=CASE WHEN
   result->'importProgress' IS NULL OR COALESCE((result->'importProgress'->>'attempt')::int,1)<$5
   OR COALESCE((result->'importProgress'->>'attempt')::int,1)=$5 AND COALESCE((result->'importProgress'->>'processedRows')::int,0)<=$6
   THEN jsonb_build_object('importProgress',$4::jsonb) ELSE result END
  WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND kind='import.execute-approved' AND status='RUNNING'
   AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken,JSON.stringify({stage:value.stage,processedRows:value.processedRows,totalRows:value.totalRows,attempt:value.attempt||1,durable:value.durable===true,...(value.elapsedMs===undefined?{}:{elapsedMs:value.elapsedMs,attemptStartRows:value.attemptStartRows}),...(value.preparedRows===undefined?{}:{preparedRows:value.preparedRows}),...(value.preparedTotal===undefined?{}:{preparedTotal:value.preparedTotal})}),value.attempt||1,value.processedRows])).rowCount===1;
}
module.exports={list,get,present,record};
