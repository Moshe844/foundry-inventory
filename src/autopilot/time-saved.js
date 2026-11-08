'use strict';

const { ValidationError, AuthorizationError } = require('../domain/errors');
const policy = require('../commercial/agent-plan');
const activities = new Map([
  ['repeat-order','Prepare and send a repeat purchase order'],
  ['supplier-response','File a supplier confirmation or document']
]);

async function access(db, ctx) {
  const member = await db.query("SELECT 1 FROM users WHERE id=$1 AND workspace_id=$2 AND role='owner'",[ctx.actorId,ctx.workspaceId]);
  if (!member.rowCount) throw new AuthorizationError('The business owner can view this report.');
  return policy.requireWorkspaceJob(db,ctx.workspaceId,161,'automatic');
}

async function sample(db, ctx, input) {
  await access(db,ctx);
  const minutes = [input.manualMinutes,input.reviewMinutes];
  if (!activities.has(input.activity) || !minutes.every(v => /^(?:0|[1-9]\d{0,3})(?:\.\d{1,2})?$/.test(String(v)) && Number(v)<=1440) ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.requestKey || '')) throw new ValidationError('Choose a task and enter both timed samples in minutes.');
  await db.query(`INSERT INTO stockchief_runtime.agent_time_samples(id,workspace_id,recorded_by,activity,manual_minutes,review_minutes)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (workspace_id,id) DO NOTHING`,
    [input.requestKey,ctx.workspaceId,ctx.actorId,input.activity,...minutes]);
}

async function report(db,ctx,window='week') {
  await access(db,ctx);
  if (!['week','month'].includes(window)) throw new ValidationError('Choose the last seven or thirty days.');
  const days = window==='week' ? 7 : 30;
  const completed = (await db.query(`WITH first_send AS (
    SELECT m.purchase_order_id,min(m.sent_at::timestamptz) AS occurred FROM supplier_communications m
    WHERE m.workspace_id=$1 AND m.status='SENT' AND m.external_message_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM work_items w WHERE w.workspace_id=m.workspace_id AND w.purchase_order_id=m.purchase_order_id
      AND w.source='postgres_autopilot' AND w.approval_requirement='NONE' AND w.outcome::jsonb->>'communicationId'=m.id)
    GROUP BY m.purchase_order_id
  ), responses AS (
    SELECT l.purchase_order_id,s.kind,s.fingerprint,min(s.created_at) AS occurred
    FROM stockchief_runtime.supplier_link_submissions s JOIN stockchief_runtime.supplier_order_links l
    ON l.workspace_id=s.workspace_id AND l.token_hash=s.token_hash WHERE s.workspace_id=$1
    GROUP BY l.purchase_order_id,s.kind,s.fingerprint
  ), events AS (
    SELECT 'repeat-order' AS activity,occurred FROM first_send UNION ALL
    SELECT 'supplier-response',occurred FROM responses
  )
  SELECT activity,count(*)::integer AS n FROM events
  WHERE occurred>=CURRENT_TIMESTAMP-($2::int * interval '24 hours') AND occurred<=CURRENT_TIMESTAMP GROUP BY activity`,[ctx.workspaceId,days])).rows;
  const timings = (await db.query(`SELECT activity,count(*)::integer AS n,avg(manual_minutes-review_minutes) AS net_minutes
    FROM stockchief_runtime.agent_time_samples WHERE workspace_id=$1 GROUP BY activity`,[ctx.workspaceId])).rows;
  const rows = [...activities].map(([key,label])=>{
    const count=completed.find(r=>r.activity===key)?.n || 0, time=timings.find(r=>r.activity===key);
    return {key,label,count,samples:time?.n || 0,minutes:time ? count*Number(time.net_minutes) : null};
  });
  return {days,rows,minutes:rows.some(r=>r.samples>0)?rows.reduce((n,r)=>n+(r.minutes??0),0):null};
}
module.exports = { report,sample };
