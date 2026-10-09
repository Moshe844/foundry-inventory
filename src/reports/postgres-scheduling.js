'use strict';

const reports=require('./postgres-service');
const jobs=require('../operations/postgres-job-queue');
const {newId}=require('../lib/util');
const config=require('../config');

function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,(character)=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));}
function scoped(client){return {query:(sql,values)=>client.query(sql,values),transaction:(fn)=>fn(client)};}

async function enqueueDue(client,at){
  const when=new Date(at),hour=when.getUTCHours(),day=when.toISOString().slice(0,10);
  const monday=when.getUTCDay()===1;
  const due=(await client.query(`SELECT id,workspace_id FROM stockchief_runtime.report_templates
    WHERE schedule_hour_utc=$1 AND (schedule_frequency='daily'
      OR (schedule_frequency='weekly' AND $2::boolean)) ORDER BY id LIMIT 500`,[hour,monday])).rows;
  let queued=0;
  for(const template of due){
    const inserted=await client.query(`INSERT INTO stockchief_runtime.report_deliveries
      (id,workspace_id,template_id,schedule_key,status)
      VALUES($1,$2,$3,$4,'PENDING') ON CONFLICT(template_id,schedule_key) DO NOTHING RETURNING id`,
    [newId('reportdelivery'),template.workspace_id,template.id,day]);
    if(!inserted.rows.length)continue;
    await jobs.enqueue(scoped(client),{workspaceId:template.workspace_id,kind:'report.generate-delivery',
      idempotencyKey:`report-delivery:${template.id}:${day}`,
      payload:{templateId:template.id,deliveryId:inserted.rows[0].id},maxAttempts:3});
    queued++;
  }
  await client.query(`UPDATE stockchief_runtime.report_deliveries d SET
      status=CASE WHEN j.status='COMPLETED' THEN 'SENT' ELSE 'FAILED' END,
      provider_message_id=COALESCE((SELECT provider_id FROM commercial_email_deliveries
        WHERE job_id=d.email_job_id),provider_message_id),
      error_message=CASE WHEN j.status='DEAD' THEN COALESCE(j.last_error::text,'Email delivery failed') ELSE NULL END,
      completed_at=now()
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

async function generateDelivery(database,job){
  const {templateId,deliveryId}=job.payload||{};
  if(!job.workspaceId||!templateId||!deliveryId)throw new Error('A report delivery needs exact workspace and template identity.');
  const template=(await database.query(`SELECT t.*,a.id AS account_id,a.email,u.role,u.permissions
    FROM stockchief_runtime.report_templates t JOIN users u ON u.id=t.owner_user_id
      AND u.workspace_id=t.workspace_id JOIN accounts a ON a.id=u.account_id
    JOIN stockchief_runtime.report_deliveries d ON d.template_id=t.id AND d.workspace_id=t.workspace_id
    WHERE t.workspace_id=$1 AND t.id=$2 AND d.id=$3 AND d.status='PENDING'`,
  [job.workspaceId,templateId,deliveryId])).rows[0];
  if(!template)return {skipped:'delivery_no_longer_pending'};
  if(!template.delivery_email||template.delivery_email.toLowerCase()!==template.email.toLowerCase())
    throw new Error('The verified recipient email changed. Review this report schedule before sending.');
  const actor={role:template.role,permissions:template.permissions,email:template.email};
  const result=await reports.run(database,{workspaceId:job.workspaceId},actor,template.definition,{limit:101});
  // Customer-facing email must use the same currency-formatted values as the
  // report builder/export, never raw money_minor database integers.
  const visible=result.displayRows.slice(0,100),limited=result.hasMore||result.rows.length>100;
  const origin=String(config.connections.publicOrigin||'').replace(/\/$/,'');
  const href=origin.startsWith('https://')?`${origin}/reports/saved/${encodeURIComponent(template.id)}`:null;
  const table=`<table border="1" cellpadding="5" cellspacing="0"><thead><tr>${result.columns.map((column)=>
    `<th>${escapeHtml(column.replaceAll('_',' '))}</th>`).join('')}</tr></thead><tbody>${visible.map((row)=>
    `<tr>${result.columns.map((column)=>`<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const summary=limited?'First 100 rows shown. Open the saved report for the full result.':
    `${visible.length} matching rows.`;
  const message={to:template.delivery_email,subject:`StockChief report: ${result.config.title}`,
    html:`<h1>${escapeHtml(result.config.title)}</h1><p>Generated from your StockChief records at ${escapeHtml(result.asOf)}.</p>`+
      `<p>${escapeHtml(summary)}</p>${table}${href?`<p><a href="${escapeHtml(href)}">Open saved report</a></p>`:''}`,
    text:[result.config.title,`Generated ${result.asOf}`,summary,result.columns.join('\t'),
      ...visible.map((row)=>result.columns.map((column)=>String(row[column]??'')).join('\t')),href||''].join('\n')};
  const mail=await jobs.enqueue(database,{workspaceId:job.workspaceId,kind:'system.email-send',
    idempotencyKey:`scheduled-report-email:${deliveryId}`,
    payload:{...message,accountId:template.account_id,messageType:'scheduled_report'},maxAttempts:3});
  await database.query(`UPDATE stockchief_runtime.report_deliveries
    SET email_job_id=$4,row_count=$5 WHERE workspace_id=$1 AND template_id=$2 AND id=$3
      AND status='PENDING'`,[job.workspaceId,templateId,deliveryId,mail.job.id,visible.length]);
  return {queued:true,rows:visible.length,limited,emailJobId:mail.job.id};
}
module.exports={enqueueDue,generateDelivery};
