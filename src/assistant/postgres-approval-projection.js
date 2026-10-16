'use strict';
const {digest,snapshot}=require('./approval-revision');

// Actor-private durable approvals belong in the existing decision inbox too.
// This projection is SELECT-only. In particular, do not call inbox()/stage(),
// acknowledge a card, or turn a frozen mission into an execution grant here.
async function pending(database,workspaceId,actorId){
 if(!actorId||!require('./postgres-codex-pilot').configured({workspaceId}))return [];
 const emails=String(process.env.STOCKCHIEF_CODEX_PILOT_EMAILS||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
 if(!emails.length)return [];
 const rows=(await database.query(`SELECT g.id AS goal_id,g.created_at,d.key AS delivery_key,d.value AS delivery,
   CASE d.value->>'kind' WHEN 'business' THEN to_jsonb(p) WHEN 'rule' THEN to_jsonb(r) END AS proposal,
   m.id AS mission_id,m.plan_hash,m.approved_steps,m.approval_status,m.authorization_mode,m.steps AS mission_steps
  FROM stockchief_runtime.assistant_goals g
  JOIN users u ON u.workspace_id=g.workspace_id AND u.id=g.actor_user_id
  JOIN accounts a ON a.id=u.account_id
  JOIN stockchief_runtime.codex_pilots pilot ON pilot.workspace_id=g.workspace_id
    AND pilot.authorized_actor_ids ? g.actor_user_id
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(g.checkpoint#>'{harness,approvalDeliveries}')='object'
    THEN g.checkpoint#>'{harness,approvalDeliveries}' ELSE '{}'::jsonb END) d
  LEFT JOIN stockchief_runtime.assistant_action_proposals p ON d.value->>'kind'='business'
    AND p.id=d.value->>'proposalId' AND p.workspace_id=g.workspace_id AND p.actor_user_id=g.actor_user_id AND p.status='PENDING'
  LEFT JOIN operating_instruction_proposals r ON d.value->>'kind'='rule'
    AND r.id=d.value->>'proposalId' AND r.workspace_id=g.workspace_id AND r.created_by_user_id=g.actor_user_id AND r.status='PENDING'
  LEFT JOIN LATERAL(SELECT id,plan_hash,approved_steps,approval_status,authorization_mode,steps FROM stockchief_runtime.assistant_capability_plans m
    WHERE m.workspace_id=g.workspace_id AND m.actor_user_id=g.actor_user_id AND m.goal_id=g.id
      AND m.waiting_proposal_id=p.id AND m.status IN ('WAITING','ADVANCING','WAITING_USER','BLOCKED')
      AND m.approval_status IN ('PENDING','APPROVED')
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1) m ON true
  WHERE g.workspace_id=$1 AND g.actor_user_id=$2 AND lower(a.email)=ANY($3::text[])
    AND g.checkpoint->>'runtime'='codex-staging' AND g.status='WAITING_APPROVAL' AND g.expires_at>now()
    AND (p.id IS NOT NULL OR r.id IS NOT NULL)
  ORDER BY g.created_at,g.id,d.key`,[workspaceId,actorId,emails])).rows;
 const decisions=new Set(),items=new Map();
 for(const row of rows){
  const card=row.delivery,p=row.proposal;
  if(!p||!['business','rule'].includes(card?.kind))continue;
  const revision=digest(snapshot(card.kind,p)),key=JSON.stringify([row.goal_id,card.kind,p.id,revision]);
  // A stale or edited delivery is not an actionable approval. The existing
  // Ask review path remains responsible for staging a changed proposal.
  if(card.sha256!==revision)continue;
  if(card.decision){decisions.add(key);continue;}
  if(card.canonicalStatus!=='PENDING'||card.id!==row.delivery_key||card.id!==row.goal_id+':approval:'+revision)continue;
  let missionOption=null,recordedMission=null;
  if(row.mission_id&&Array.isArray(row.approved_steps)&&row.approved_steps.length>1&&
    require('./postgres-capability-plans').planHash(row.approved_steps)===row.plan_hash){
   const scope={id:row.mission_id,sha256:row.plan_hash,count:row.approved_steps.length};
   if(row.approval_status==='PENDING')missionOption=scope;
   else if(row.authorization_mode==='MISSION')recordedMission=scope;
  }
  const incompleteScope=recordedMission&&(row.mission_steps||[]).some(s=>s.proposalId===p.id&&s.reason==='mission_scope_incomplete');
  // A recorded mission approval is not a missing approval for every later
  // step. Conversely it does not prove a changed/underspecified step fits.
  // Expose recovery for review, never infer a new grant or auto-execute here.
  const recovery=Boolean(recordedMission&&!incompleteScope);
  items.set(key,{kind:recovery?'recovery':'approval',importance:'Important',priority:85,title:p.summary,
   happened:p.summary,why:recovery?'This workflow has a recorded approval, but its execution is unfinished. Review its current scope and recovery status.':
     incompleteScope?'The frozen workflow was approved, but this step needs additional scope before it can continue.':'This proposed change still needs your decision.',
   recommendation:recovery?'Open the saved workflow to review its recorded authority and unfinished work.':
     missionOption?`Review this change or its frozen ${missionOption.count}-step plan in Ask StockChief.`:
     'Review the prepared change in Ask StockChief.',
   href:'/ask?goal='+encodeURIComponent(row.goal_id)+'#focused-goal',actionLabel:recovery?'Review workflow':'Review approval',at:card.createdAt||row.created_at,
   approval:{goalId:row.goal_id,proposalId:p.id,kind:card.kind,revision,scope:recovery?'review_existing_mission':'single_operation',missionOption,recordedMission}});
 }
 return [...items].filter(([key])=>!decisions.has(key)).map(([,item])=>item);
}
module.exports={pending};
