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
 else{state='AWAITING_APPROVAL';label='Waiting for your approval';}
 const iso=value=>value?new Date(value).toISOString():null;
 return {id:row.id,sourceName:row.source_name,rows:Number(row.records_detected),readyRows:Number(row.records_valid),
  invalidRows:Number(row.records_invalid),state,label,active:['QUEUED','RUNNING'].includes(state),working:state==='RUNNING',
  verified,finished:!['QUEUED','RUNNING'].includes(state),status:row.plan_status,
  createdAt:iso(row.created_at),queuedAt:iso(row.queued_at),startedAt:iso(row.started_at),completedAt:iso(row.finished_at),
  href:'/imports/'+encodeURIComponent(row.id)};
}

async function list(database,workspaceId,{id=null,limit=10,activeOnly=false}={}){
 if(!workspaceId)throw new TypeError('Import progress requires a workspace.');
 const rows=(await database.query(`SELECT p.id,p.source_name,p.records_detected,p.records_valid,p.records_invalid,
   p.status AS plan_status,p.approval_status,p.created_at,j.status AS job_status,j.lease_expires_at,
   j.created_at AS queued_at,COALESCE(e.started_at::timestamptz,j.started_at) AS started_at,e.status AS execution_status,
   e.finished_at,v.verified,floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS database_now
  FROM import_plans p
  LEFT JOIN LATERAL(SELECT job.status,job.lease_expires_at,job.created_at,job.started_at FROM stockchief_runtime.jobs job
   WHERE job.workspace_id=p.workspace_id AND job.kind='import.execute-approved' AND job.payload->>'planId'=p.id
   ORDER BY job.created_at DESC,job.id DESC LIMIT 1)j ON true
  LEFT JOIN LATERAL(SELECT run.id,run.status,run.started_at,run.finished_at FROM import_executions run
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

module.exports={list,get,present};
