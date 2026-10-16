'use strict';
const {ValidationError}=require('../domain/errors');
const labels=Object.freeze({READY:'Queued',RUNNING:'Working',WAITING_APPROVAL:'Needs approval',WAITING_EVENT:'Awaiting confirmation',
 WAITING_USER:'Needs your answer',COMPLETED:'Completed',BLOCKED:'Stopped before completion',CANCELLED:'Stopped by you'});
const pageSize=20;
function cursor(value){
 if(!value)return null;
 try{
  if(typeof value!=='string'||value.length>400)throw Error();
  const v=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
  if(!Array.isArray(v)||v.length!==2||typeof v[0]!=='string'||!/^\d{4}-\d\d-\d\dT/.test(v[0])||!Number.isFinite(Date.parse(v[0]))||
    typeof v[1]!=='string'||!v[1]||v[1].length>160)throw Error();
  return v;
 }catch{throw new ValidationError('That history page is unavailable. Open saved requests again.');}
}
// Only canonical records associated by durable IDs count as recorded effects.
// Neither a model's answer nor an approval delivery's cached status is proof.
async function effects(database,ctx,ids){
 if(!ids.length)return new Map();
 const rows=(await database.query(`WITH owned AS (
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
 ORDER BY goal_id,kind,id`,[ctx.workspaceId,ctx.actorId,ids])).rows;
 const result=new Map(ids.map(id=>[id,[]]));
 for(const row of rows)result.get(row.goal_id).push({kind:row.kind,id:row.id,summary:row.summary,status:row.status,
  href:(row.kind==='rule'?'/operating-instructions/':'/actions/')+encodeURIComponent(row.id)});
 return result;
}
async function list(database,ctx,{before=null,status=''}={}){
 const after=cursor(before);
 if(typeof status!=='string'||status&&!Object.hasOwn(labels,status))throw new ValidationError('Choose an available request status.');
 return database.transaction(async client=>{
  const total=Number((await client.query(`SELECT count(*) AS n FROM stockchief_runtime.assistant_goals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3='' OR status=$3)`,[ctx.workspaceId,ctx.actorId,status])).rows[0].n);
  const rows=(await client.query(`SELECT id,original_request,status,created_at,updated_at,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time FROM stockchief_runtime.assistant_goals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND ($3='' OR status=$3)
    AND ($4::timestamptz IS NULL OR (created_at,id)<($4::timestamptz,$5::text))
   ORDER BY created_at DESC,id DESC LIMIT $6`,[ctx.workspaceId,ctx.actorId,status,after?.[0]||null,after?.[1]||null,pageSize+1])).rows;
  const hasMore=rows.length>pageSize,visible=rows.slice(0,pageSize),recorded=await effects(client,ctx,visible.map(g=>g.id)),last=visible.at(-1);
  return {total,status,pageSize,hasMore,rows:visible.map(g=>({...g,label:labels[g.status],effects:recorded.get(g.id)||[]})),
   next:hasMore?Buffer.from(JSON.stringify([last.cursor_time,last.id])).toString('base64url'):null};
 },{isolation:'REPEATABLE READ',readOnly:true});
}
module.exports={list,effects,labels};
