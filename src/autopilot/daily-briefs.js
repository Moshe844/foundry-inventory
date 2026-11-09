'use strict';

const time=require('../lib/business-time');
const {addDays}=require('../accounting/customer-money');
const policy=require('../commercial/agent-plan');
const {ValidationError}=require('../domain/errors');
const verbs={receive:'Stock receipts',issue:'Stock issues',transfer:'Transfers',adjust:'Count adjustments'};
async function deliver(db,workspaceId,account){
  if(!policy.usesAgentTerms(account)||!policy.permits(account.plan,156,'automatic'))return;
  const {calendarDate,timeZone}=await time.forWorkspace(db,workspaceId),day=addDays(calendarDate,-1);
  const team=policy.permits(account.plan,180,'automatic');
  const existing=(await db.query('SELECT summary::jsonb AS data FROM workspace_daily_digests WHERE workspace_id=$1 AND report_date=$2',[workspaceId,day])).rows[0]?.data;
  if(existing?.format==='agent-brief'&&(!team||existing.team))return;
  const bounds=[workspaceId,time.dayBoundary(day,timeZone),time.dayBoundary(calendarDate,timeZone)];
  const {rows:activity}=await db.query(`SELECT m.actor_user_id AS actor,coalesce(u.name,'Former team member') AS person,m.operation,count(DISTINCT m.group_id)::int AS n
    FROM movements m LEFT JOIN users u ON u.workspace_id=m.workspace_id AND u.id=m.actor_user_id
    WHERE m.workspace_id=$1 AND m.occurred_at::timestamptz>=$2 AND m.occurred_at::timestamptz<$3
    GROUP BY m.actor_user_id,u.name,m.operation ORDER BY u.name,m.actor_user_id,m.operation`,bounds);
  const sources=(await db.query(`SELECT
    ((SELECT count(*)::int FROM stockchief_runtime.assistant_action_proposals WHERE workspace_id=$1 AND status='EXECUTED' AND executed_at>=$2 AND executed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_supplier_term_sources WHERE workspace_id=$1 AND changed_count>0 AND processed_at>=$2 AND processed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_po_date_sources WHERE workspace_id=$1 AND changed AND instruction_hash IS NOT NULL AND processed_at>=$2 AND processed_at<$3)
     +(SELECT count(*)::int FROM stockchief_runtime.agent_container_runs WHERE workspace_id=$1 AND completed_at>=$2 AND completed_at<$3 AND (result->>'cartons')::int>0)) AS actions,
    (SELECT count(*)::int FROM stockchief_runtime.assistant_action_proposals p JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.actor_user_id AND u.role='owner'
      WHERE p.workspace_id=$1 AND p.status='PENDING') AS approvals,
    (SELECT count(*)::int FROM stockchief_runtime.agent_operational_notices WHERE workspace_id=$1 AND job_id=168 AND NOT resolved) AS overdue,
    (SELECT count(*)::int FROM work_items WHERE workspace_id=$1 AND execution_status='COMPLETED' AND verification_status='VERIFIED' AND completed_at::timestamptz>=$2 AND completed_at::timestamptz<$3) AS verified`,bounds)).rows[0];
  const totals={};for(const row of activity)totals[row.operation]=(totals[row.operation]||0)+row.n;
  const data={format:'agent-brief',day,deliveredOn:calendarDate,asOf:new Date().toISOString(),totals,...sources,...(team?{team:activity}:{})};
  await db.query(`INSERT INTO workspace_daily_digests AS d(workspace_id,report_date,generated_at,summary) VALUES($1,$2,$3,$4)
    ON CONFLICT(workspace_id,report_date) DO UPDATE SET summary=CASE WHEN d.summary::jsonb->>'format'='agent-brief' THEN
      (d.summary::jsonb||jsonb_build_object('team',excluded.summary::jsonb->'team'))::text ELSE excluded.summary END
    WHERE d.summary::jsonb->>'format' IS DISTINCT FROM 'agent-brief' OR (NOT (d.summary::jsonb ? 'team') AND excluded.summary::jsonb ? 'team')`,
    [workspaceId,day,data.asOf,JSON.stringify(data)]);
}
async function latest(db,ctx){
  const {rows:[r]}=await db.query("SELECT report_date FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief' ORDER BY report_date DESC LIMIT 1",[ctx.workspaceId]);
  if(!r)return null;
  const state=await policy.accountState(db,ctx.workspaceId);
  return policy.usesAgentTerms(state)&&policy.permits(state.plan,156,'automatic')?r.report_date:null;
}
async function report(db,ctx,{filter,team,page}){
  if(filter&&(!/^\d{4}-\d{2}-\d{2}$/.test(filter)||!Number.isFinite(Date.parse(filter))||new Date(filter).toISOString().slice(0,10)!==filter))throw new ValidationError('Choose a date in YYYY-MM-DD format.');
  const data=(await db.query(`SELECT summary::jsonb AS data FROM workspace_daily_digests WHERE workspace_id=$1 AND summary::jsonb->>'format'='agent-brief'
    AND ($2='' OR report_date=$2) ORDER BY report_date DESC LIMIT 1`,[ctx.workspaceId,filter])).rows[0]?.data;
  if(!data)return {rows:[],more:false,summary:'A briefing appears here after the scheduled stock check for a completed day.'};
  const dates='from='+data.day+'&to='+data.day;
  const pending=[{Activity:'Owner approvals waiting',Count:data.approvals,link:'/needs-you'},{Activity:'Overdue orders, shipments and invoices',Count:data.overdue,link:'/autopilot/reviews/overdue-work'}];
  const summary='Stock activity for '+data.day+'. Approvals and overdue records were counted when this briefing arrived on '+data.deliveredOn+'.';
  if(team){
    const rows=(data.team||[]).map(r=>({'Team member':r.person,Activity:verbs[r.operation],Count:r.n,link:'/activity?'+dates+'&user='+encodeURIComponent(r.actor)+'&operation='+r.operation}));
    rows.push({'Team member':'Inventory',...pending[1]});
    return {rows:rows.slice((page-1)*100,page*100),more:rows.length>page*100,summary:summary+(data.team?'':' A team breakdown was unavailable on the plan that received this briefing.')};
  }
  const rows=Object.entries(data.totals).map(([k,n])=>({Activity:verbs[k],Count:n,link:'/activity?'+dates+'&operation='+k}));
  rows.push({Activity:'Completed agent actions',Count:data.actions,link:'/activity'},{Activity:'Verified work items',Count:data.verified,link:'/autopilot'},...pending);
  return {rows,more:false,summary};
}
const definitions=[
  {id:156,key:'daily-briefing',label:'Daily briefing',filterLabel:'Business date (YYYY-MM-DD)',readPage:(db,ctx,o)=>report(db,ctx,{...o,team:false})},
  {id:180,key:'daily-team-summary',label:'Daily team activity and overdue work',filterLabel:'Business date (YYYY-MM-DD)',readPage:(db,ctx,o)=>report(db,ctx,{...o,team:true})}
];
module.exports={deliver,latest,definitions};
