'use strict';
// Native SDK transport bookkeeping only. One SQL statement owns the scoped
// goal lock and a fresh actor row lock; no model/tool/business admission is
// granted here. All financial and canonical execution gates stay separate.
async function persist(database,{ctx,goalId,runToken,identity,operation,data}){
 if(!['native','request','pending','delivered','report'].includes(operation)||!identity?.actor||!identity.stamp)throw Error('INVALID_NATIVE_CHECKPOINT');
 const slot=data.slot||'codexDelivery';if(!['codexDelivery','helperDelivery'].includes(slot))throw Error('INVALID_NATIVE_CHECKPOINT');
 const encoded=JSON.stringify(data);if(Buffer.byteLength(encoded)>8*1024*1024)throw Error('SESSION_SIZE_LIMIT');
 return (await database.query(`WITH held AS MATERIALIZED (
   SELECT id,status,run_token,lease_until,expires_at,checkpoint
   FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE
  ), actor AS MATERIALIZED (
   SELECT jsonb_build_object('role',u.role,'permissions',u.permissions) AS current_actor
   FROM users u WHERE u.workspace_id=$1 AND u.id=$2 FOR SHARE OF u
  ), state AS MATERIALIZED (
   SELECT held.*,actor.current_actor,checkpoint#>>'{harness,candidate}' AS candidate,
    checkpoint#>>'{harness,authorityStamp}' AS stamp,
    checkpoint#>>ARRAY['harness',$9::text,'state'] AS delivery_state,
    checkpoint#>>ARRAY['harness',$9::text,'hash'] AS delivery_hash,
    CASE WHEN jsonb_typeof(checkpoint#>'{harness,codexRequests}')='number'
     THEN (checkpoint#>>'{harness,codexRequests}')::numeric ELSE 0 END AS requests,
    CASE $7::text
     WHEN 'native' THEN jsonb_set(checkpoint,'{harness,native}',COALESCE(checkpoint#>'{harness,native}','{}'::jsonb)||($8::jsonb->'native'))
     WHEN 'request' THEN jsonb_set(checkpoint,'{harness,codexRequests}',to_jsonb(COALESCE((checkpoint#>>'{harness,codexRequests}')::integer,0)+1))
     WHEN 'report' THEN jsonb_set(checkpoint,'{harness,pendingReport}',$8::jsonb->'report')
     WHEN 'pending' THEN jsonb_set(checkpoint,ARRAY['harness',$9::text],jsonb_build_object('hash',$8::jsonb->'hash','state','PENDING'))
     WHEN 'delivered' THEN jsonb_set(checkpoint,'{harness}',(checkpoint->'harness')||
      jsonb_build_object($9::text,jsonb_build_object('hash',$8::jsonb->'hash','state','SETTLED','packet',$8::jsonb->'packet'))||
      CASE WHEN $9='codexDelivery' THEN jsonb_build_object('lastCodexResponse',($8::jsonb->'outcome')||
       CASE WHEN checkpoint#>'{harness,codexRequests}' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('request',checkpoint#>'{harness,codexRequests}') END)
       ELSE '{}'::jsonb END)
    END AS next_checkpoint
   FROM held LEFT JOIN actor ON true
  ), changed AS (
   UPDATE stockchief_runtime.assistant_goals goal SET checkpoint=state.next_checkpoint,
    lease_until=now()+interval '10 minutes',updated_at=now()
   FROM state WHERE goal.id=state.id AND goal.workspace_id=$1 AND goal.actor_user_id=$2
    AND state.status='RUNNING' AND state.run_token=$4 AND state.lease_until>clock_timestamp() AND state.expires_at>clock_timestamp()
    AND state.candidate='codex' AND state.stamp=$5 AND state.current_actor=$6::jsonb
    AND jsonb_typeof(state.checkpoint#>'{harness,native}')='object'
    AND state.checkpoint#>>'{conversationState,phase}'=CASE WHEN state.checkpoint->>'lifecycleStage'='verification' THEN 'verification' ELSE 'working' END
    AND CASE $7 WHEN 'request' THEN state.requests<24
      WHEN 'pending' THEN state.delivery_state IS DISTINCT FROM 'PENDING'
      WHEN 'delivered' THEN state.delivery_state='PENDING' AND state.delivery_hash=$8::jsonb->>'hash'
      ELSE true END
    AND octet_length(state.next_checkpoint::text)<=8388608
   RETURNING goal.id
  ) SELECT state.status,state.run_token,state.lease_until,state.expires_at,state.candidate,state.stamp,
    state.current_actor,state.delivery_state,state.delivery_hash,state.requests,
    EXISTS(SELECT 1 FROM changed) AS changed
   FROM state`,[ctx.workspaceId,ctx.actorId,goalId,runToken,identity.stamp,JSON.stringify(identity.actor),operation,encoded,slot])).rows[0]||null;
}
module.exports={persist};
