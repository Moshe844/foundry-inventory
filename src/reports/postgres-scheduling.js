'use strict';

const reports=require('./postgres-service');
const jobs=require('../operations/postgres-job-queue');
const {newId}=require('../lib/util');
const config=require('../config');

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(character)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function scoped(client){return {query:(sql,values)=>client.query(sql,values),transaction:(fn)=>fn(client)};}
function deliveryMessage(template,result,origin){
  const visible=result.displayRows.slice(0,100),limited=result.hasMore||result.rows.length>100;
  const href=origin.startsWith('https://')?`${origin}/reports/saved/${encodeURIComponent(template.id)}`:null;
  const table=`<table border="1" cellpadding="5" cellspacing="0"><thead><tr>${result.columns.map((column)=>
    `<th>${escapeHtml((result.columnLabels?.[column]||column).replaceAll('_',' '))}</th>`).join('')}</tr></thead><tbody>${visible.map((row)=>
    `<tr>${result.columns.map((column)=>`<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const summary=limited?'First 100 rows shown. Open the saved report for the full result.':
    `${visible.length} matching rows.`;
  const findings=(result.insights||[]).map((entry)=>entry.text);
  const findingsHtml=findings.length?`<h2>What stands out</h2><ul>${findings.map((entry)=>
    `<li>${escapeHtml(entry)}</li>`).join('')}</ul><p>These are comparisons of recorded rows, not causes or forecasts.</p>`:'';
  const generated=new Intl.DateTimeFormat('en-US',{timeZone:template.schedule_time_zone||'UTC',dateStyle:'medium',timeStyle:'long'}).format(new Date(result.asOf));
  const message={to:template.delivery_email,subject:`StockChief report: ${result.config.title}`,
    html:`<h1>${escapeHtml(result.config.title)}</h1><p>Generated from your StockChief records at ${escapeHtml(generated)}.</p>`+
      `<p>${escapeHtml(summary)}</p>${findingsHtml}${table}${href?`<p><a href="${escapeHtml(href)}">Open saved report</a></p>`:''}`,
    text:[result.config.title,`Generated ${generated}`,summary,...findings,
      result.columns.map((column)=>result.columnLabels?.[column]||column).join('\t'),
      ...visible.map((row)=>result.columns.map((column)=>String(row[column]??'')).join('\t')),href||''].join('\n')};
  return {message,visibleCount:visible.length,limited};
}

async function enqueueDue(database,at){const work=client=>enqueueDueInTransaction(client,at);return typeof database.transaction==='function'?database.transaction(work,{isolation:'SERIALIZABLE',retrySafe:true}):work(database);}
async function enqueueDueInTransaction(client,at){const when=new Date(at),local=require('./local-schedule'),controls=require('./postgres-delivery-controls');let queued=0;
 const initialize=(await client.query("SELECT * FROM stockchief_runtime.report_templates WHERE next_send_at IS NULL AND schedule_frequency<>'none' AND NOT schedule_paused AND deleted_at IS NULL ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED")).rows;
 for(const t of initialize)await client.query('UPDATE stockchief_runtime.report_templates SET next_send_at=$2 WHERE id=$1',[t.id,local.next(local.fromTemplate(t),when)?.toISOString()||null]);
 const due=(await client.query("SELECT * FROM stockchief_runtime.report_templates WHERE next_send_at<=$1 AND schedule_frequency<>'none' AND NOT schedule_paused AND deleted_at IS NULL ORDER BY next_send_at,id LIMIT 500 FOR UPDATE SKIP LOCKED",[when.toISOString()])).rows;
 for(const t of due){const key=new Date(t.next_send_at).toISOString(),result=await controls.queue(client,{workspaceId:t.workspace_id},t,key);if(!result.replayed)queued++;await client.query('UPDATE stockchief_runtime.report_templates SET next_send_at=$2 WHERE id=$1',[t.id,local.next(local.fromTemplate(t),when).toISOString()]);}
  await client.query(`UPDATE stockchief_runtime.report_deliveries d
    SET status='FAILED',error_message=coalesce(j.last_error->>'message','Report generation failed.'),completed_at=now()
    FROM stockchief_runtime.jobs j WHERE j.workspace_id=d.workspace_id AND j.kind='report.generate-delivery'
      AND j.idempotency_key='report-delivery:'||d.template_id||':'||d.schedule_key
      AND j.payload->>'deliveryId'=d.id AND j.status='DEAD' AND d.status='PENDING' AND d.email_job_id IS NULL`);
  await client.query(`UPDATE stockchief_runtime.report_deliveries d SET
      status=CASE WHEN j.status='COMPLETED' AND EXISTS(SELECT 1 FROM commercial_email_deliveries e WHERE e.job_id=d.email_job_id AND e.provider_id IS NOT NULL AND e.accepted_at IS NOT NULL) THEN 'SENT' ELSE 'FAILED' END,
      provider_message_id=COALESCE((SELECT provider_id FROM commercial_email_deliveries
        WHERE job_id=d.email_job_id),provider_message_id),
      error_message=CASE WHEN j.status='DEAD' THEN COALESCE(j.last_error::text,'Email delivery failed') WHEN NOT EXISTS(SELECT 1 FROM commercial_email_deliveries e WHERE e.job_id=d.email_job_id AND e.provider_id IS NOT NULL AND e.accepted_at IS NOT NULL) THEN 'No verified email acceptance was recorded. Review this delivery before resending.' ELSE NULL END,
      completed_at=coalesce((SELECT accepted_at FROM commercial_email_deliveries e WHERE e.job_id=d.email_job_id AND e.provider_id IS NOT NULL),now())
    FROM stockchief_runtime.jobs j WHERE d.email_job_id=j.id AND d.status='PENDING'
      AND j.status IN ('COMPLETED','DEAD')`);
  await client.query(`UPDATE stockchief_runtime.report_templates t SET
      last_delivered_at=CASE WHEN d.status='SENT' THEN d.completed_at ELSE t.last_delivered_at END,
      last_error=CASE WHEN d.status='FAILED' THEN d.error_message ELSE NULL END
    FROM (SELECT DISTINCT ON (template_id) template_id,status,completed_at,error_message
      FROM stockchief_runtime.report_deliveries WHERE completed_at IS NOT NULL
      ORDER BY template_id,completed_at DESC) d
    WHERE d.template_id=t.id AND (t.last_delivered_at IS NULL OR t.last_delivered_at<=d.completed_at)`);
  return {queued};
}

async function recordEmailAcceptance(client,workspaceId,emailJobId){
 const accepted=await client.query(`UPDATE stockchief_runtime.report_deliveries d SET status='SENT',provider_message_id=e.provider_id,completed_at=e.accepted_at,error_message=NULL
 FROM commercial_email_deliveries e WHERE d.workspace_id=$1 AND d.email_job_id=$2 AND e.job_id=d.email_job_id AND d.status='PENDING' AND e.provider_id IS NOT NULL AND e.accepted_at IS NOT NULL RETURNING d.template_id,d.completed_at`,[workspaceId,emailJobId]);
 for(const d of accepted.rows)await client.query(`UPDATE stockchief_runtime.report_templates SET last_delivered_at=$3,last_error=NULL WHERE workspace_id=$1 AND id=$2 AND (last_delivered_at IS NULL OR last_delivered_at<=$3)`,[workspaceId,d.template_id,d.completed_at]);
 return {sent:accepted.rowCount};
}
async function emailStillWanted(db,workspaceId,emailJobId,recipient,revision){
  const {rows:[delivery]}=await db.query(`SELECT d.id,d.status,d.schedule_key,t.schedule_paused,t.deleted_at,t.definition,t.revision,
    coalesce(t.delivery_email,a.email) AS recipient,a.email,x.disabled_at AS platform_access_disabled_at,
    u.id AS actor_id,u.role,u.permissions,w.deletion_requested_at
    FROM stockchief_runtime.report_deliveries d
    JOIN stockchief_runtime.report_templates t ON t.workspace_id=d.workspace_id AND t.id=d.template_id
    JOIN workspaces w ON w.id=t.workspace_id
    LEFT JOIN users u ON u.workspace_id=t.workspace_id AND u.id=t.owner_user_id
    LEFT JOIN accounts a ON a.id=u.account_id
    LEFT JOIN platform_account_access x ON x.account_id=a.id
    WHERE d.workspace_id=$1 AND d.email_job_id=$2`,[workspaceId,emailJobId]);
  if(!delivery||delivery.status!=='PENDING')return false;
  if(delivery.deleted_at||delivery.deletion_requested_at||revision!=null&&revision!==Number(delivery.revision)||
    delivery.schedule_paused&&!delivery.schedule_key.startsWith('manual:')){
    await db.query(`UPDATE stockchief_runtime.report_deliveries SET status='CANCELLED',completed_at=now()
      WHERE workspace_id=$1 AND id=$2 AND status='PENDING'`,[workspaceId,delivery.id]);
    return false;
  }
  if(!delivery.actor_id||delivery.platform_access_disabled_at||!delivery.email||
    delivery.email.toLowerCase()!==String(recipient).toLowerCase()||delivery.recipient?.toLowerCase()!==delivery.email.toLowerCase()){
    throw Object.assign(new Error('The report recipient or their access changed. Review this report before sending.'),
      {code:'report_recipient_changed',retryable:false});
  }
  reports.normalize(delivery.definition,{role:delivery.role,permissions:delivery.permissions,email:delivery.email});
  return true;
}
async function generateDelivery(database,job){
  const {templateId,deliveryId}=job.payload||{};
  if(!job.workspaceId||!templateId||!deliveryId)throw new Error('A report delivery needs exact workspace and template identity.');
  const template=(await database.query(`SELECT t.*,a.id AS account_id,a.email,u.role,u.permissions,d.schedule_key,coalesce(t.delivery_email,a.email) delivery_email
    FROM stockchief_runtime.report_templates t JOIN users u ON u.id=t.owner_user_id
      AND u.workspace_id=t.workspace_id JOIN accounts a ON a.id=u.account_id
    JOIN stockchief_runtime.report_deliveries d ON d.template_id=t.id AND d.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND t.id=$2 AND d.id=$3 AND d.status='PENDING' AND t.deleted_at IS NULL AND (NOT t.schedule_paused OR d.schedule_key LIKE 'manual:%')`,
  [job.workspaceId,templateId,deliveryId])).rows[0];
  if(!template)return {skipped:'delivery_no_longer_pending'};
  if(!template.delivery_email||template.delivery_email.toLowerCase()!==template.email.toLowerCase())
    throw new Error('The verified recipient email changed. Review this report schedule before sending.');
  const actor={role:template.role,permissions:template.permissions,email:template.email};
  const result=await reports.run(database,{workspaceId:job.workspaceId},actor,template.definition,{limit:101});
  // Customer-facing email must use the same currency-formatted values as the
  // report builder/export, never raw money_minor database integers.
  const origin=String(config.connections.publicOrigin||'').replace(/\/$/,'');
  const {message,visibleCount,limited}=deliveryMessage(template,result,origin);
  return database.transaction(async client=>{const current=(await client.query("SELECT t.revision,d.email_job_id FROM stockchief_runtime.report_templates t JOIN stockchief_runtime.report_deliveries d ON d.workspace_id=t.workspace_id AND d.template_id=t.id WHERE t.workspace_id=$1 AND t.id=$2 AND d.id=$3 AND d.status='PENDING' AND t.deleted_at IS NULL AND (NOT t.schedule_paused OR d.schedule_key LIKE 'manual:%') FOR UPDATE OF t,d",[job.workspaceId,templateId,deliveryId])).rows[0];if(!current)return {skipped:'schedule_changed_before_delivery'};
   if(current.email_job_id)return {queued:true,emailJobId:current.email_job_id,replayed:true};
   if(Number(current.revision)!==Number(template.revision)){
    await client.query("UPDATE stockchief_runtime.report_deliveries SET status='CANCELLED',completed_at=now() WHERE workspace_id=$1 AND id=$2",[job.workspaceId,deliveryId]);
    return {skipped:'report_changed_before_delivery'};
   }
   const mail=await jobs.enqueue(scoped(client),{workspaceId:job.workspaceId,kind:'system.email-send',idempotencyKey:'scheduled-report-email:'+deliveryId,payload:{...message,accountId:template.account_id,messageType:'scheduled_report',reportRevision:Number(template.revision)},maxAttempts:3});await client.query("UPDATE stockchief_runtime.report_deliveries SET email_job_id=$4,row_count=$5 WHERE workspace_id=$1 AND template_id=$2 AND id=$3 AND status='PENDING'",[job.workspaceId,templateId,deliveryId,mail.job.id,visibleCount]);return {queued:true,rows:visibleCount,limited,emailJobId:mail.job.id};
  },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={enqueueDue,generateDelivery,deliveryMessage,recordEmailAcceptance,emailStillWanted};
