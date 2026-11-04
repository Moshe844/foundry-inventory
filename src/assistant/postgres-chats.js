'use strict';
const {NotFoundError,ValidationError}=require('../domain/errors');
const source=`SELECT id,original_request,created_at,updated_at,coalesce(checkpoint->>'chatId',id) AS chat_id,checkpoint->>'chatId' IS NOT NULL AS grouped FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND checkpoint->'sourceAutomation' IS NULL
 UNION ALL SELECT id,message AS original_request,created_at,created_at AS updated_at,intent->>'chatId' AS chat_id,true AS grouped FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 AND actor_user_id=$2 AND intent->>'chatId' IS NOT NULL AND intent->>'parentGoalId' IS NULL AND intent->>'batchId' IS NULL`;
const preferences='stockchief_runtime.assistant_chat_preferences';
const notDeleted=chatId=>`NOT EXISTS(SELECT 1 FROM ${preferences} deleted WHERE deleted.workspace_id=$1 AND deleted.actor_user_id=$2 AND deleted.chat_id=${chatId} AND deleted.deleted_at IS NOT NULL)`;
async function list(db,ctx,{limit=50,offset=0,q=''}={}){const term=String(q||'').trim().slice(0,200);
 const rows=(await db.query(`WITH requests AS (${source}),chats AS (SELECT chat_id,(array_agg(id ORDER BY created_at,id))[1] AS first_goal_id,(array_agg(original_request ORDER BY created_at,id))[1] AS original_request,min(created_at) AS created_at,max(updated_at) AS updated_at,count(*)::int AS request_count,bool_or(grouped) AS grouped,bool_or(position(lower($5) in lower(original_request))>0) AS matched FROM requests GROUP BY chat_id)
  SELECT chats.*,pref.title,pref.pinned_at FROM chats LEFT JOIN ${preferences} pref ON pref.workspace_id=$1 AND pref.actor_user_id=$2 AND pref.chat_id=chats.chat_id
  WHERE pref.deleted_at IS NULL AND ($5='' OR chats.matched OR position(lower($5) in lower(coalesce(pref.title,'')))>0)
  ORDER BY pref.pinned_at DESC NULLS LAST,chats.updated_at DESC,chats.chat_id LIMIT $3 OFFSET $4`,[ctx.workspaceId,ctx.actorId,Math.min(100,Math.max(1,limit)),Math.max(0,offset),term])).rows;
 return rows.map(row=>({...row,id:row.first_goal_id,label:row.title||row.original_request,href:row.grouped?'/ask?chat='+encodeURIComponent(row.chat_id):'/ask/history?goal='+encodeURIComponent(row.first_goal_id)}));}
async function owned(db,ctx,id){const row=(await db.query(`WITH requests AS (${source}) SELECT min(created_at) created_at FROM requests WHERE chat_id=$3 AND ${notDeleted('$3')}`,[ctx.workspaceId,ctx.actorId,id])).rows[0];if(!row?.created_at)throw new NotFoundError('That conversation is not in your saved work.');return row;}
async function isDeleted(db,ctx,id){return (await db.query(`SELECT 1 FROM ${preferences} WHERE workspace_id=$1 AND actor_user_id=$2 AND chat_id=$3 AND deleted_at IS NOT NULL`,[ctx.workspaceId,ctx.actorId,id])).rowCount>0;}
async function setPreference(db,ctx,id,column,value){await owned(db,ctx,id);
 await db.query(`INSERT INTO ${preferences}(workspace_id,actor_user_id,chat_id,${column}) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,actor_user_id,chat_id) DO UPDATE SET ${column}=excluded.${column},updated_at=now()`,[ctx.workspaceId,ctx.actorId,id,value]);}
async function rename(db,ctx,id,title){const name=String(title||'').trim();if(name.length>120)throw new ValidationError('Use a conversation name of up to 120 characters.');await setPreference(db,ctx,id,'title',name||null);}
async function pin(db,ctx,id,pinned){await setPreference(db,ctx,id,'pinned_at',pinned?new Date().toISOString():null);}
// Work still running or waiting on the person would disappear from where they answer it.
async function remove(db,ctx,id){const active=(await db.query("SELECT 1 FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND coalesce(checkpoint->>'chatId',id)=$3 AND status NOT IN ('COMPLETED','CANCELLED','BLOCKED') LIMIT 1",[ctx.workspaceId,ctx.actorId,id])).rowCount;
 if(active)throw new ValidationError('This conversation still has work in progress or waiting for you. Finish or stop it first.');
 await setPreference(db,ctx,id,'deleted_at',new Date().toISOString());}
async function transcript(db,ctx,id){await owned(db,ctx,id);return (await db.query(`SELECT message,answer,created_at FROM (SELECT original_request AS message,answer,created_at FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2 AND coalesce(checkpoint->>'chatId',id)=$3
  UNION ALL SELECT message,answer,created_at FROM stockchief_runtime.assistant_interactions WHERE workspace_id=$1 AND actor_user_id=$2 AND intent->>'chatId'=$3 AND intent->>'parentGoalId' IS NULL AND intent->>'batchId' IS NULL) turns ORDER BY created_at`,[ctx.workspaceId,ctx.actorId,id])).rows;}
// Pinned first, then by how recently each was used, in the business's own days.
function groups(rows,timeZone='UTC',now=new Date()){
 const day=value=>new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value)),age=value=>Math.round((Date.parse(day(now))-Date.parse(day(value)))/86400000);
 const sets=[{label:'Pinned',rows:rows.filter(r=>r.pinned_at)},{label:'Today',rows:[]},{label:'Yesterday',rows:[]},{label:'Previous 7 days',rows:[]},{label:'Older',rows:[]}];
 for(const row of rows.filter(r=>!r.pinned_at)){const a=age(row.updated_at);sets[a<=0?1:a===1?2:a<=7?3:4].rows.push(row);}
 return sets.filter(set=>set.rows.length);}
module.exports={list,owned,isDeleted,rename,pin,remove,transcript,groups};
