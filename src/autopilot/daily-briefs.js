'use strict';

// Job 156: the daily briefing, alone on every plan. The routine check writes
// what happened on the day that just ended; briefing-email.js delivers it in
// Needs you and by email on the owner's chosen schedule.

const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const policy=require('../commercial/agent-plan');
const installed=require('../db/schema-installed');
const staffTasks=require('../operations/agent-staff-tasks');
const {ValidationError}=require('../domain/errors');
const verbs={receive:'Stock receipts',issue:'Stock issues',transfer:'Transfers',adjust:'Count adjustments'};
const businessEvents=[
  ['Purchase orders placed','/purchasing/orders'],
  ['Customer orders confirmed','/orders'],
  ['Customer shipments sent','/fulfilment']
];

async function businessActivity(db,bounds){
  const {rows:[counts]}=await db.query(`SELECT
    (SELECT count(*)::int FROM purchase_orders WHERE workspace_id=$1
      AND ordered_at::timestamptz >= $2 AND ordered_at::timestamptz < $3) AS purchases,
    (SELECT count(*)::int FROM sales_orders WHERE workspace_id=$1
      AND confirmed_at::timestamptz >= $2 AND confirmed_at::timestamptz < $3) AS sales,
    (SELECT count(*)::int FROM sales_shipments WHERE workspace_id=$1 AND customer_return_id IS NULL
      AND shipped_at::timestamptz >= $2 AND shipped_at::timestamptz < $3) AS shipments`,bounds);
  return [counts.purchases,counts.sales,counts.shipments];
}

async function staffActivity(db,bounds,asOf){
  const {rows}=await db.query(`WITH events AS (
    SELECT coalesce(done_by,assignee_id) AS actor,done_by IS NOT NULL AS known,kind,'completed' AS state
    FROM ${staffTasks.table} WHERE workspace_id=$1 AND status='DONE' AND done_at>=$2 AND done_at<$3
    UNION ALL
    SELECT assignee_id,true,kind,'late'
    FROM ${staffTasks.table} WHERE workspace_id=$1 AND status='ASSIGNED' AND due_at<$4
  )
  SELECT CASE WHEN e.known THEN coalesce(u.name,'Former team member') ELSE 'Team member not recorded' END AS person,
    e.kind,e.state,count(*)::int AS n
  FROM events e LEFT JOIN users u ON u.workspace_id=$1 AND u.id=e.actor
  GROUP BY e.actor,e.known,u.name,e.kind,e.state ORDER BY e.state DESC,person,e.kind,e.actor`,[...bounds,asOf]);
  return rows;
}


// What happened from the start of `from` to the end of `to` (business days in
// the workspace's time zone), and what needs the owner now.
async function collect(db,workspaceId,from,to,timeZone,{team=false}={}){
  const bounds=[workspaceId,time.dayBoundary(from,timeZone),time.dayBoundary(addDays(to,1),timeZone)];
  const {rows:activity}=await db.query(`SELECT m.actor_user_id AS actor,coalesce(u.name,'Former team member') AS person,m.operation,count(DISTINCT m.group_id)::int AS n
    FROM movements m LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
    WHERE m.workspace_id=$1 AND m.occurred_at::timestamptz>=$2 AND m.occurred_at::timestamptz<$3
    GROUP BY m.actor_user_id,u.name,m.operation ORDER BY u.name,m.actor_user_id,m.operation`,bounds);
  const sources=(await db.query(`SELECT
    ((SELECT count(*)::int FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND status='EXECUTED' AND executed_at>=$2 AND executed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_supplier_term_sources WHERE workspace_id=$1 AND changed_count>0 AND processed_at>=$2 AND processed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_po_date_sources WHERE workspace_id=$1 AND changed AND instruction_hash IS NOT NULL AND processed_at>=$2 AND processed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND completed_at>=$2 AND completed_at<$3 AND (result->>'cartons')::int>0)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_supplier_shutdown_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2 AND p.purchase_created_at<$3 AND o.status<>'CANCELLED')
     +(SELECT count(*)::int FROM stockchief_runtime.agent_promotion_stock_plans p JOIN purchase_orders o ON o.workspace_id=p.workspace_id AND o.id=p.purchase_order_id WHERE p.workspace_id=$1 AND p.purchase_created_at>=$2 AND p.purchase_created_at<$3 AND o.status<>'CANCELLED')
     +(SELECT count(*)::int FROM stockchief_runtime.agent_rfq_deliveries d JOIN supplier_communications m ON m.workspace_id=d.workspace_id AND m.id=d.communication_id WHERE d.workspace_id=$1 AND m.status='SENT' AND m.sent_at::timestamptz>=$2 AND m.sent_at::timestamptz<$3 AND nullif(m.external_message_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=d.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'))
     +(SELECT count(*)::int FROM stockchief_runtime.agent_supplier_claims c JOIN supplier_communications m ON m.workspace_id=c.workspace_id AND m.id=c.communication_id WHERE c.workspace_id=$1 AND m.status='SENT' AND m.sent_at::timestamptz>=$2 AND m.sent_at::timestamptz<$3 AND nullif(m.external_message_id,'') IS NOT NULL AND EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects e WHERE e.workspace_id=c.workspace_id AND e.aggregate_id=m.id AND e.kind='mail.outbound.send' AND e.status='SUCCEEDED'))
     +(SELECT count(*)::int FROM stockchief_runtime.agent_quality_holds WHERE workspace_id=$1 AND automatic AND created_at>=$2 AND created_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_product_retirement_notices WHERE workspace_id=$1 AND applied_at>=$2 AND applied_at<$3 AND (result->>'changedCount')::int>0)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_team_procedure_versions v WHERE v.workspace_id=$1 AND v.created_at>=$2 AND v.created_at<$3 AND NOT EXISTS(
       SELECT 1 FROM stockchief_runtime.agent_team_procedure_versions older WHERE older.workspace_id=v.workspace_id AND older.procedure_id=v.procedure_id
        AND older.document_hash=v.document_hash AND (older.created_at,older.id)<(v.created_at,v.id)))) AS actions,
    (SELECT count(*)::int FROM stockchief_runtime.assistant_action_proposals p JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.actor_user_id AND u.role='owner'
      WHERE p.workspace_id=$1 AND p.status='PENDING') AS approvals,
    (SELECT count(*)::int FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=168 AND NOT resolved) AS overdue,
    (SELECT count(*)::int FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=168 AND kind='Customer order' AND NOT resolved) AS "lateOrders",
    (SELECT count(*)::int FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=166 AND kind='Out of stock' AND NOT resolved) AS "stockOuts",
    (SELECT count(*)::int FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=166 AND kind<>'Out of stock' AND NOT resolved) AS "runningLow",
    (SELECT count(*)::int FROM work_items WHERE workspace_id=$1 AND execution_status='COMPLETED' AND verification_status='VERIFIED' AND completed_at::timestamptz>=$2 AND completed_at::timestamptz<$3) AS verified`,bounds)).rows[0];
  const totals={};for(const row of activity)totals[row.operation]=(totals[row.operation]||0)+row.n;
  const business=await businessActivity(db,bounds);
  const staff=team&&await installed.has(db,staffTasks.table)?await staffActivity(db,bounds,new Date().toISOString()):null;
  return {totals,business,...(staff?{staffTasks:staff}:{}),...sources,...(team?{team:activity}:{})};
}

async function deliver(db,workspaceId,account,{now=new Date()}={}){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,156,'automatic'))return;
  const {calendarDate,timeZone}=await time.forWorkspace(db,workspaceId,now),day=addDays(calendarDate,-1);
  // Every business that gets a briefing has a delivery time (7:00 until the owner chooses).
  await require('./briefing-email').ensureSchedule(db,workspaceId,timeZone,now);
  const team=policy.permits(account.plan,180,'automatic');
  const existing=(await db.query('SELECT summary::jsonb AS data FROM workspace_daily_digests WHERE workspace_id=$1 AND report_date=$2',[workspaceId,day])).rows[0]?.data;
  if(existing?.format==='agent-brief'&&existing.business&&(!team||existing.team&&existing.staffTasks))return;
  const data={format:'agent-brief',day,deliveredOn:calendarDate,asOf:new Date().toISOString(),...await collect(db,workspaceId,day,day,timeZone,{team})};
  await db.query(`INSERT INTO workspace_daily_digests AS d(workspace_id,report_date,generated_at,summary) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,report_date) DO UPDATE SET summary=CASE WHEN d.summary::jsonb->>'format'='agent-brief' THEN
      (d.summary::jsonb||jsonb_build_object('business',excluded.summary::jsonb->'business')
        ||CASE WHEN excluded.summary::jsonb ? 'team' THEN jsonb_build_object('team',excluded.summary::jsonb->'team') ELSE '{}'::jsonb END
        ||CASE WHEN excluded.summary::jsonb ? 'staffTasks' THEN jsonb_build_object('staffTasks',excluded.summary::jsonb->'staffTasks') ELSE '{}'::jsonb END)::text
      ELSE excluded.summary END
    WHERE d.summary::jsonb->>'format' IS DISTINCT FROM 'agent-brief'
      OR NOT (d.summary::jsonb ? 'business')
      OR (NOT (d.summary::jsonb ? 'team') AND excluded.summary::jsonb ? 'team')
      OR (NOT (d.summary::jsonb ? 'staffTasks') AND excluded.summary::jsonb ? 'staffTasks')`,
    [workspaceId,day,data.asOf,JSON.stringify(data)]);
}
async function latest(db,ctx){
  const {rows:[r]}=await db.query("SELECT report_date FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief' ORDER BY report_date DESC LIMIT 1",[ctx.workspaceId]);
  if(!r)return null;
  const state=await policy.accountState(db,ctx.workspaceId);
  return policy.usesAgentTerms(state)&&policy.permits(state.plan,156,'automatic')
    ?{date:r.report_date,team:policy.permits(state.plan,180,'automatic')}:null;
}
async function report(db,ctx,{filter,team,page}){
  if(filter&&(!/^\d{4}-\d{2}-\d{2}$/.test(filter)||!Number.isFinite(Date.parse(filter))||new Date(filter).toISOString().slice(0,10)!==filter))throw new ValidationError('Choose a date in YYYY-MM-DD format.');
  const data=(await db.query(`SELECT summary::jsonb AS data FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief'
    AND ($2='' OR report_date=$2) ORDER BY report_date DESC LIMIT 1`,[ctx.workspaceId,filter])).rows[0]?.data;
  if(!data)return {rows:[],more:false,summary:'A briefing appears here after the scheduled stock check for a completed day.'};
  const dates='from='+data.day+'&to='+data.day;
  const pending=[{Activity:'Owner approvals waiting',Count:data.approvals,link:'/needs-you'},{Activity:'Overdue orders, shipments and invoices',Count:data.overdue,link:'/autopilot/reviews/overdue-work'}];
  // Briefings written since job 156 was finished also count stock-outs and low stock.
  if(data.stockOuts!=null)pending.push({Activity:'Out of stock',Count:data.stockOuts,link:'/autopilot/reviews/low-stock-alerts'},{Activity:'Running low',Count:data.runningLow,link:'/autopilot/reviews/low-stock-alerts'});
  const summary='Stock activity for '+data.day+'. Approvals and overdue records were counted when this briefing arrived on '+data.deliveredOn+'.';
  if(team){
    const rows=(data.staffTasks||[]).map(r=>({'Team member':r.person,
      Activity:staffTasks.specs[r.kind].plural+(r.state==='late'?' overdue':' completed'),Count:r.n,
      link:staffTasks.path+(r.state==='late'?'#open':'#done')}));
    for(const r of data.team||[])rows.push({'Team member':r.person,Activity:verbs[r.operation],Count:r.n,link:'/activity?'+dates+'&user='+encodeURIComponent(r.actor)+'&operation='+r.operation});
    rows.push({'Team member':'Inventory',...pending[1]});
    const teamSummary=data.staffTasks?' Completed warehouse tasks are listed by who did them. Overdue tasks are listed by who they were assigned to when the summary ran.':
      ' This briefing was recorded before staff tasks were included.';
    return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary:summary+teamSummary};
  }
  const rows=Object.entries(data.totals).map(([k,n])=>({Activity:verbs[k],Count:n,link:'/activity?'+dates+'&operation='+k}));
  if(data.business)businessEvents.forEach(([Activity,link],index)=>rows.push({Activity,Count:data.business[index],link}));
  rows.push({Activity:'Completed agent actions',Count:data.actions,link:'/activity'},{Activity:'Verified work items',Count:data.verified,link:'/autopilot'},...pending);
  return {rows,more:false,summary};
}
const definitions=[
  {id:156,key:'daily-briefing',label:'Daily briefing',filterLabel:'Business date (YYYY-MM-DD)',readPage:(db,ctx,o)=>report(db,ctx,{...o,team:false})}
];
module.exports={collect,deliver,latest,report,verbs,definitions};
