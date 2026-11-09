'use strict';
const policy=require('../commercial/agent-plan'),rules=require('./draft-authority');
const money=require('../domain/currency');
const activity={'sales_order.repeat':'repeat-sale','purchase_order.combine_drafts':'combine-purchases','purchase_order.split_draft':'split-purchase'};
async function candidates(db,ctx){
  const state=await policy.requireWorkspaceJob(db,ctx.workspaceId,206,'automatic');
  await require('../operations/postgres-warehouse-access').assertInventoryWide(db,ctx);
  const {rows}=await db.query(`WITH approvals AS (
    SELECT p.*,row_number() OVER(PARTITION BY p.action_type,p.payload#>>'{training,key}' ORDER BY p.executed_at DESC,p.id DESC) AS position,
      count(*) OVER(PARTITION BY p.action_type,p.payload#>>'{training,key}') AS examples
    FROM stockchief_runtime.assistant_action_proposals p JOIN users u ON u.workspace_id=p.workspace_id AND u.id=p.actor_user_id AND u.role='owner'
    WHERE p.workspace_id=$1 AND p.status='EXECUTED' AND p.payload#>>'{training,key}' IS NOT NULL AND p.action_type=ANY($2::text[])
      AND p.executed_at>=now()-interval '30 days' AND p.executed_at<=now()
      AND NOT EXISTS(SELECT 1 FROM stockchief_runtime.agent_draft_rules r WHERE r.workspace_id=p.workspace_id
        AND r.action_type=p.action_type AND r.scope_key=p.payload#>>'{training,key}')
  ) SELECT id,action_type,payload->'training' AS training,examples::int FROM approvals WHERE position=1 AND examples>=3
    ORDER BY examples DESC,id LIMIT 100`,[ctx.workspaceId,[...rules.jobs.keys()]]);
  const timings=(await db.query(`SELECT activity,count(*)::int samples,avg(review_minutes) AS minutes
    FROM stockchief_runtime.agent_time_samples WHERE workspace_id=$1 GROUP BY activity`,[ctx.workspaceId])).rows;
  return rows.filter(r=>policy.permits(state.plan,rules.jobs.get(r.action_type),'automatic',{trained:true})).map(r=>{
    const timing=timings.find(t=>t.activity===activity[r.action_type]);
    return {Routine:r.training.label,'Reviewed examples':r.examples,'Current example value':money.format(r.training.amountMinor,r.training.currency),
      'Potential hours per month':timing?Math.round(r.examples*Number(timing.minutes)/60*100)/100:null,
      Basis:timing?'Projected from '+timing.samples+' owner timing samples and '+r.examples+' completed approvals in the last 30 days.':'Record review-time samples to estimate potential hours.',
      'Next step':'Review an approved example and choose the maximum amount for a taught rule.',link:'/actions/'+r.id};
  });
}
async function generate(db,workspaceId){
  const state=await policy.accountState(db,workspaceId);
  if(!state.plan||!policy.usesAgentTerms(state)||!policy.permits(state.plan,206,'automatic'))return {held:true};
  const owner=(await db.query(`SELECT u.id FROM users u JOIN accounts a ON a.id=u.account_id
    LEFT JOIN platform_account_access x ON x.account_id=a.id WHERE u.workspace_id=$1 AND u.role='owner' AND x.disabled_at IS NULL ORDER BY u.id LIMIT 1`,[workspaceId])).rows[0];
  if(!owner)return {held:true};
  const month=(await require('../lib/business-time').today(db,workspaceId)).slice(0,7);
  const prior=await db.query('SELECT 1 FROM stockchief_runtime.agent_automation_opportunities WHERE workspace_id=$1 AND month=$2',[workspaceId,month]);
  if(prior.rowCount)return {duplicate:true};
  const rows=await candidates(db,{workspaceId,actorId:owner.id});
  await db.query(`INSERT INTO stockchief_runtime.agent_automation_opportunities(workspace_id,month,rows)
    VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,[workspaceId,month,JSON.stringify(rows)]);
  if(rows.length)await db.query(`INSERT INTO stockchief_runtime.agent_operational_notices(workspace_id,job_id,kind,reference,link,due,last_reminded)
    VALUES($1,206,'Automation',$2,'/autopilot/reviews/automation-opportunities',$3::date,$3::date) ON CONFLICT DO NOTHING`,[workspaceId,month,month+'-01']);
  return {month,candidates:rows.length};
}
async function review(db,ctx){
  const current=await candidates(db,ctx),snapshot=(await db.query('SELECT month FROM stockchief_runtime.agent_automation_opportunities WHERE workspace_id=$1 ORDER BY month DESC LIMIT 1',[ctx.workspaceId])).rows[0];
  return {rows:current,more:false,summary:(snapshot?'Monthly review '+snapshot.month+'. ':'')+
    'These routines have at least three completed owner approvals and require your rule and spending limit. Hours are potential future review time saved, based on your samples.'};
}
async function learned(db,ctx){
  await policy.requireWorkspaceJob(db,ctx.workspaceId,208,'automatic');
  const rows=(await db.query(`SELECT r.scope_label,r.currency,r.maximum_minor,r.action_type,r.revision,u.role FROM stockchief_runtime.agent_draft_rules r
    JOIN users u ON u.workspace_id=r.workspace_id AND u.id=r.authorized_by WHERE r.workspace_id=$1 ORDER BY r.scope_label,r.action_type LIMIT 101`,[ctx.workspaceId])).rows;
  const state=await policy.accountState(db,ctx.workspaceId);
  return {rows:rows.slice(0,100).map(r=>({Routine:r.scope_label,Limit:money.format(r.maximum_minor,r.currency),
    Status:r.role==='owner'&&policy.permits(state.plan,rules.jobs.get(r.action_type),'automatic',{trained:true})?'Approved rule saved':'Needs owner or plan review',
    Revision:r.revision,link:'/autopilot/job-modes'})),more:rows.length>100,
    summary:'Completed approvals provide examples for an owner-taught rule. Each run checks the current plan, authority, scope and amount again.'};
}
const definitions=[{id:206,key:'automation-opportunities',label:'Monthly automation opportunities',readPage:review},
  {id:208,key:'learned-routines',label:'Rules learned from approved examples',readPage:learned}];
module.exports={generate,definitions};
