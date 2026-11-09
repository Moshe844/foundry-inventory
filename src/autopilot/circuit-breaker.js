'use strict';
const policy=require('../commercial/agent-plan');
const money=require('../domain/currency');
const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const prefix='Unusual automatic activity';

async function observations(db,workspaceId){
  const {calendarDate:today,timeZone}=await time.forWorkspace(db,workspaceId);
  const scales=Object.fromEntries([...Intl.supportedValuesOf('currency'),'CLF','UYW'].map(code=>[code,money.exponent(code)]));
  const totals=require('../operations/postgres-team-access').purchaseTotalsSql('p.workspace_id','p.id',"power(10::numeric,($6::jsonb->>p.currency)::int)");
  const result=await db.query(`WITH events AS (
    SELECT w.approved_at::timestamptz AS at,p.currency,
      CASE WHEN t.priced THEN t.lines+t.charges END AS spend
    FROM work_items w LEFT JOIN purchase_orders p ON p.workspace_id=w.workspace_id AND p.id=w.purchase_order_id
    LEFT JOIN LATERAL (${totals}) t ON p.id IS NOT NULL
    WHERE w.workspace_id=$1 AND w.source='postgres_autopilot' AND w.approval_requirement='NONE' AND w.execution_status IN ('COMPLETED','EXECUTING')
      AND w.approved_at::timestamptz BETWEEN $2 AND now()
    UNION ALL SELECT t.completed_at::timestamptz,t.currency,t.amount_minor FROM shipping_label_transactions t
    JOIN stockchief_runtime.provider_effects e ON e.workspace_id=t.workspace_id AND e.kind='shipping.label.purchase'
      AND e.payload->>'transactionId'=t.id AND e.payload->>'agentPostageScope'='automatic'
    WHERE t.workspace_id=$1 AND t.operation='PURCHASE' AND t.status='SUCCEEDED' AND t.completed_at::timestamptz BETWEEN $2 AND now()
  ), daily AS (
    SELECT (at AT TIME ZONE $3)::date AS day,'Count' AS metric,count(*)::numeric AS total FROM events
    WHERE at<$5 OR at>coalesce((SELECT anomaly_acknowledged_at FROM workspace_autopilot WHERE workspace_id=$1),'-infinity') GROUP BY 1
    UNION ALL SELECT (at AT TIME ZONE $3)::date,currency,sum(spend) FROM events
    WHERE spend>=0 AND currency IS NOT NULL AND (at<$5 OR at>coalesce((SELECT anomaly_acknowledged_at FROM workspace_autopilot WHERE workspace_id=$1),'-infinity')) GROUP BY 1,2
  ), basis AS (
    SELECT metric,count(*) AS days,percentile_cont(0.25) WITHIN GROUP(ORDER BY total) AS q1,
      percentile_cont(0.5) WITHIN GROUP(ORDER BY total) AS median,percentile_cont(0.75) WITHIN GROUP(ORDER BY total) AS q3
    FROM daily WHERE day<$4::date GROUP BY metric HAVING count(*)>=4
  ) SELECT d.metric,d.total,b.days,greatest(2*b.median,b.q3+1.5*(b.q3-b.q1)) AS threshold
    FROM daily d JOIN basis b USING(metric) WHERE d.day=$4::date AND d.total>greatest(2*b.median,b.q3+1.5*(b.q3-b.q1))
    ORDER BY d.metric`,[workspaceId,time.dayBoundary(addDays(today,-28),timeZone),timeZone,today,time.dayBoundary(today,timeZone),JSON.stringify(scales)]);
  return result.rows;
}
async function refresh(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!policy.usesAgentTerms(state)||!policy.permits(state.plan,201,'automatic')||state.shadow)return;
  const configured=(await db.query('SELECT mode,paused FROM workspace_autopilot WHERE workspace_id=$1',[workspaceId])).rows[0];
  if(configured?.mode!=='POLICY_AUTOMATED'||Number(configured.paused))return;
  const signals=await observations(db,workspaceId);
  if(!signals.length)return;
  const summary=signals.map(s=>s.metric==='Count'?s.total+' automatic actions':money.format(Number(s.total),s.metric)+' committed').join(' and ');
  const reason=prefix+' today. '+summary+' exceeds the usual daily range. The owner can review the activity and resume.';
  const latched=await db.query(`UPDATE workspace_autopilot SET paused=1,paused_at=now()::text,paused_by_user_id=NULL,paused_reason=$2,updated_at=now()::text
    WHERE workspace_id=$1 AND mode='POLICY_AUTOMATED' AND paused=0 RETURNING workspace_id`,[workspaceId,reason]);
  if(latched.rowCount)await require('../operations/postgres-security-audit').record(db,{workspaceId},{action:'Paused unusual automatic activity',after:{reason}});
  return reason;
}
const definition={id:201,key:'unusual-automatic-activity',label:'Review unusual automatic activity',read:async(db,ctx)=>{
  const rows=await observations(db,ctx.workspaceId);
  return {summary:'Automatic purchase commitments, transfers and purchased labels are compared with the previous 28 days in your inventory’s time zone. A spike in count or same-currency spend pauses routine work once four active days establish a comparison.',
    rows:rows.map(r=>({Measure:r.metric==='Count'?'Actions':r.metric+' spend',Today:r.metric==='Count'?r.total:money.format(Number(r.total),r.metric),
      'Active comparison days':Number(r.days)}))};
}};
module.exports={refresh,observations,definition};
