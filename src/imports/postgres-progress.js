'use strict';

const {NotFoundError}=require('../domain/errors');

function present(row){
 const verified=row.plan_status==='SUCCEEDED'&&row.execution_status==='SUCCEEDED'&&Number(row.verified)===1;
 const running=row.job_status==='RUNNING'&&Number(row.lease_expires_at)>Number(row.database_now);
 let state,label;
 if(verified){state='VERIFIED';label='Import complete and verified';}
 else if(['PENDING','RETRY'].includes(row.job_status)){state='QUEUED';label='Import queued';}
 else if(running||!row.job_status&&row.execution_status==='EXECUTING'){state='RUNNING';label='Importing your inventory';}
 else if(row.plan_status==='CANCELLED'||row.job_status==='CANCELLED'){state='CANCELLED';label='Import stopped';}
 else if(['RUNNING','PAUSED'].includes(row.job_status)){state='PAUSED';label='Import paused before verification';}
 else if(['DEAD','COMPLETED'].includes(row.job_status)||['FAILED','SUCCEEDED'].includes(row.execution_status)||['FAILED','SUCCEEDED'].includes(row.plan_status)){state='NEEDS_REVIEW';label='Import needs review';}
 else if(row.approval_status==='APPROVED'){state='APPROVED';label='Approved — ready to start';}
 else if(row.needs_source_review===true){state='NEEDS_INPUT';label='Needs your answer';}
 else{state='AWAITING_APPROVAL';label='Waiting for your approval';}
 const iso=value=>value?new Date(value).toISOString():null;
 const detail=typeof row.job_result==='string'?JSON.parse(row.job_result):row.job_result;
 const p=detail?.importProgress,known=Boolean(p&&['preparing','processing','verifying'].includes(p.stage)&&Number.isSafeInteger(p.processedRows)&&Number.isSafeInteger(p.totalRows)&&p.processedRows>=0&&p.processedRows<=p.totalRows&&p.totalRows===Number(row.records_valid));
 const stage=verified?'complete':known&&state==='RUNNING'?p.stage:state==='RUNNING'?'processing':state.toLowerCase();
 const failure=row.job_error,reason=failure?.code==='57014'?'This attempt exceeded the database time limit and was rolled back. No stock or inventory value from this attempt was saved.':failure?.code==='import_lease_lost'?'The worker connection was interrupted before saving. The attempt was rolled back.':failure?'The import could not finish safely. Review its saved result before retrying.':null;
 const stageLabel=(known&&state==='RUNNING'&&p.attempt>1?'Attempt '+p.attempt+' · restarting safely after rollback · ':'')+({preparing:'Preparing approved records',processing:'Applying products, stock and costs',verifying:'Checking stock and accounting totals',complete:'Inventory saved and verified',queued:row.waiting_for_import?'Waiting for the running import in this inventory':'Waiting for an available worker',paused:'Waiting for review',needs_review:'Review required',needs_input:'Resolve the preview questions',approved:'Approved and ready to start',awaiting_approval:'Review and approve the preview',cancelled:'Stopped'}[stage]||'Checking saved progress');
 return {id:row.id,sourceName:row.source_name,rows:Number(row.records_detected),readyRows:Number(row.records_valid),
  invalidRows:Number(row.records_invalid),state,label,reason,active:['QUEUED','RUNNING'].includes(state),working:state==='RUNNING',
  verified,finished:!['QUEUED','RUNNING'].includes(state),status:row.plan_status,
  createdAt:iso(row.created_at),queuedAt:iso(row.queued_at),startedAt:state==='QUEUED'?null:iso(row.started_at),
  completedAt:['QUEUED','RUNNING'].includes(state)?null:iso(row.committed_at||row.job_finished_at||row.finished_at),
  stage,stageLabel,attempt:known?Number(p.attempt||1):null,processedRows:verified?Number(row.records_valid):known?p.processedRows:null,
  progressPercent:verified?100:known&&p.totalRows?Math.min(99,Math.floor(p.processedRows/p.totalRows*100)):null,
  lastUpdateAt:iso(row.job_updated_at||row.finished_at||row.started_at||row.created_at),
  href:'/imports/'+encodeURIComponent(row.id)};
}

async function list(database,workspaceId,{id=null,limit=10,activeOnly=false}={}){
 if(!workspaceId)throw new TypeError('Import progress requires a workspace.');
 const rows=(await database.query(`SELECT p.id,p.source_name,p.records_detected,p.records_valid,p.records_invalid,
   p.status AS plan_status,p.approval_status,p.created_at,
   EXISTS(SELECT 1 FROM stockchief_runtime.jobs other WHERE other.workspace_id=p.workspace_id AND other.kind='import.execute-approved'
     AND other.status='RUNNING' AND other.payload->>'planId'<>p.id) AS waiting_for_import,
   (p.status='READY' AND p.approval_status='AWAITING_APPROVAL' AND (
     p.records_valid=0 OR
     EXISTS(SELECT 1 FROM import_rows r WHERE r.workspace_id=p.workspace_id AND r.import_id=p.id AND r.problems::jsonb @> '[{"code":"accounting_not_ready"}]'::jsonb) OR
     (p.transformations::jsonb->>'existingStockRows')::int>0 AND NULLIF(p.transformations::jsonb->>'importMode','') IS NULL OR
     p.records_invalid>0 AND COALESCE(p.transformations::jsonb->>'allowPartialImport','false')<>'true' OR
     p.conflicts::jsonb<>'[]'::jsonb OR
     NOT (p.field_mappings::jsonb ? 'name' OR p.field_mappings::jsonb ? 'code') OR
     (p.source_kind='image' OR p.transformations::jsonb->>'visualSource'='true') AND COALESCE(p.transformations::jsonb->>'imageReadingConfirmed','false')<>'true' OR
     p.records_invalid>0 AND (p.transformations::jsonb ? 'workbook' OR p.field_mappings::jsonb ? 'serialTracked' OR p.field_mappings::jsonb ? 'lotTracked'))) AS needs_source_review,
   j.status AS job_status,j.last_error AS job_error,j.lease_expires_at,
   j.created_at AS queued_at,j.updated_at AS job_updated_at,j.completed_at AS job_finished_at,j.result AS job_result,COALESCE(j.started_at,e.started_at::timestamptz) AS started_at,e.status AS execution_status,
   e.finished_at,e.committed_at,v.verified,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS database_now
  FROM import_plans p
  LEFT JOIN LATERAL(SELECT job.status,job.last_error,job.lease_expires_at,job.created_at,job.started_at,job.completed_at,job.updated_at,job.result FROM stockchief_runtime.jobs job
   WHERE job.workspace_id=p.workspace_id AND job.kind='import.execute-approved' AND job.payload->>'planId'=p.id
   ORDER BY job.created_at DESC,job.id DESC LIMIT 1)j ON true
  LEFT JOIN LATERAL(SELECT run.id,run.status,run.started_at,run.finished_at,run.committed_at FROM import_executions run
   WHERE run.workspace_id=p.workspace_id AND run.import_id=p.id ORDER BY run.started_at DESC,run.id DESC LIMIT 1)e ON true
  LEFT JOIN import_verifications v ON v.workspace_id=p.workspace_id AND v.execution_id=e.id
  WHERE p.workspace_id=$1 AND ($2::text IS NULL OR p.id=$2)
   AND ($3::boolean=false OR j.status IN ('PENDING','RETRY','RUNNING') OR e.status='EXECUTING')
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
 return (await database.query(`UPDATE stockchief_runtime.jobs SET result=CASE WHEN
   result->'importProgress' IS NULL OR COALESCE((result->'importProgress'->>'attempt')::int,1)<$5
   OR COALESCE((result->'importProgress'->>'attempt')::int,1)=$5 AND COALESCE((result->'importProgress'->>'processedRows')::int,0)<=$6
   THEN jsonb_build_object('importProgress',$4::jsonb) ELSE result END
  WHERE workspace_id=$1 AND id=$2 AND lease_token=$3 AND kind='import.execute-approved' AND status='RUNNING'
   AND lease_expires_at>floor(extract(epoch FROM clock_timestamp())*1000)`,[job.workspaceId,job.id,job.leaseToken,JSON.stringify({stage:value.stage,processedRows:value.processedRows,totalRows:value.totalRows,attempt:value.attempt||1}),value.attempt||1,value.processedRows])).rowCount===1;
}
module.exports={list,get,present,record};
