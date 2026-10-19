WITH owned AS (
  SELECT id,checkpoint FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=ANY($3::text[])
 ), interactions AS (
  SELECT parent.id AS goal_id,i.intent->>'proposalId' AS proposal_id
   FROM stockchief_runtime.assistant_interactions i
   JOIN LATERAL(SELECT g.id FROM stockchief_runtime.assistant_goals g
    WHERE g.workspace_id=i.workspace_id AND g.actor_user_id=i.actor_user_id
     AND (g.id=i.intent->>'parentGoalId' OR g.id=i.intent->>'batchId'
      OR left(i.intent->>'batchId',length(g.id)+1)=g.id||':')
    ORDER BY g.created_at DESC,g.id DESC LIMIT 1) parent ON true
   JOIN owned g ON g.id=parent.id
   WHERE i.workspace_id=$1 AND i.actor_user_id=$2
 ), refs AS (
  SELECT g.id AS goal_id,d.value->>'kind' AS kind,d.value->>'proposalId' AS proposal_id FROM owned g
   CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(g.checkpoint#>'{harness,approvalDeliveries}')='object'
    THEN g.checkpoint#>'{harness,approvalDeliveries}' ELSE '{}'::jsonb END) d
  UNION
  SELECT g.id,'business',s.value->>'proposalId' FROM owned g
   JOIN stockchief_runtime.assistant_capability_plans m ON m.goal_id=g.id AND m.workspace_id=$1 AND m.actor_user_id=$2
   CROSS JOIN LATERAL jsonb_array_elements(m.steps) s
  UNION SELECT goal_id,'business',proposal_id FROM interactions
  UNION SELECT goal_id,'rule',proposal_id FROM interactions
 ) SELECT refs.goal_id,'business' AS kind,p.id,p.summary,p.status FROM refs
  JOIN stockchief_runtime.assistant_action_proposals p ON refs.kind='business' AND p.id=refs.proposal_id
   AND p.workspace_id=$1 AND p.actor_user_id=$2 AND p.status='EXECUTED'
 UNION
 SELECT refs.goal_id,'rule',r.id,r.summary,r.status FROM refs
  JOIN operating_instruction_proposals r ON refs.kind='rule' AND r.id=refs.proposal_id
   AND r.workspace_id=$1 AND r.created_by_user_id=$2 AND r.status='APPROVED'
 ORDER BY goal_id,kind,id
