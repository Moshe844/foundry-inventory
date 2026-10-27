'use strict';
const {NotFoundError}=require('../domain/errors');
async function list(db,ctx,{limit=50}={}){
 const rows=(await db.query(`SELECT coalesce(checkpoint->>'chatId',id) AS chat_id,
  (array_agg(id ORDER BY created_at,id))[1] AS first_goal_id,
  (array_agg(original_request ORDER BY created_at,id))[1] AS original_request,
  min(created_at) AS created_at,max(updated_at) AS updated_at,count(*)::int AS request_count,
  bool_or(checkpoint->>'chatId' IS NOT NULL) AS grouped
  FROM stockchief_runtime.assistant_goals WHERE workspace_id=$1 AND actor_user_id=$2
   AND checkpoint->'sourceAutomation' IS NULL
  GROUP BY coalesce(checkpoint->>'chatId',id) ORDER BY max(updated_at) DESC,chat_id LIMIT $3`,[ctx.workspaceId,ctx.actorId,Math.min(100,Math.max(1,limit))])).rows;
 return rows.map(row=>({...row,id:row.first_goal_id,href:row.grouped?'/ask?chat='+encodeURIComponent(row.chat_id):'/ask/history?goal='+encodeURIComponent(row.first_goal_id)}));
}
async function owned(db,ctx,id){
 const row=(await db.query(`SELECT min(created_at) created_at FROM stockchief_runtime.assistant_goals
  WHERE workspace_id=$1 AND actor_user_id=$2 AND checkpoint->>'chatId'=$3`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
 if(!row?.created_at)throw new NotFoundError('That conversation is not in your saved work.');return row;
}
module.exports={list,owned};
