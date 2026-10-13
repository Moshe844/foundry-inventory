'use strict';
const {randomBytes,createHash}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const {localPath}=require('./agent-navigation-path');
const hash=value=>createHash('sha256').update(value).digest('hex');

function visible(goal){
 const n=goal.checkpoint.navigation;
 return goal.status==='WAITING_EVENT'&&n&&['PENDING','DELIVERING'].includes(n.state)
  ?{id:n.id,label:n.label,state:n.state}:null;
}
async function begin(db,ctx,id,{automatic=false}={}){
 await require('./postgres-codex-pilot').access(db,ctx,{enabled:true});
 return db.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM stockchief_runtime.assistant_goals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,id])).rows[0];
  const n=goal&&visible(goal);
  if(!n||new Date(goal.expires_at)<=new Date())throw new ValidationError('This page handoff is no longer available.');
  if(automatic&&n.state!=='PENDING')return null;
  const href=localPath(goal.checkpoint.navigation.href);if(!href)throw new ValidationError('Invalid page handoff.');
  await require('../../scripts/environment-agent-demo/waits').authority(client,ctx,goal.checkpoint.harness);
  const token=randomBytes(32).toString('hex');
  goal.checkpoint.navigation={...goal.checkpoint.navigation,state:'DELIVERING',tokenHash:hash(token)};
  await client.query(`UPDATE stockchief_runtime.assistant_goals SET checkpoint=$4::jsonb,updated_at=now()
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3`,[ctx.workspaceId,ctx.actorId,id,JSON.stringify(goal.checkpoint)]);
  return {goalId:id,navigationId:n.id,href,token,workspaceId:ctx.workspaceId,actorId:ctx.actorId};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
async function acknowledge(db,ctx,pending,token){
 if(!pending||pending.workspaceId!==ctx.workspaceId||pending.actorId!==ctx.actorId||
  !/^[a-f0-9]{64}$/.test(String(token))||token!==pending.token)throw new ValidationError('Invalid page arrival.');
 await require('./postgres-codex-pilot').access(db,ctx,{enabled:true});
 return db.transaction(async client=>{
  const goal=(await client.query(`SELECT * FROM stockchief_runtime.assistant_goals
   WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 FOR UPDATE`,[ctx.workspaceId,ctx.actorId,pending.goalId])).rows[0];
  const n=goal?.checkpoint.navigation;
  if(!n||n.id!==pending.navigationId||n.href!==pending.href||n.tokenHash!==hash(token))throw new ValidationError('The page handoff changed.');
  if(n.state==='DELIVERED'&&goal.status==='COMPLETED')return goal;
  if(goal.status!=='WAITING_EVENT'||n.state!=='DELIVERING')throw new ValidationError('This request is no longer waiting for a page.');
  await require('../../scripts/environment-agent-demo/waits').authority(client,ctx,goal.checkpoint.harness);
  n.state='DELIVERED';n.deliveredAt=new Date().toISOString();
  goal.checkpoint.harness.completionSource='user_browser_arrival';
  return (await client.query(`UPDATE stockchief_runtime.assistant_goals SET status='COMPLETED',checkpoint=$4::jsonb,
   answer=$5,updated_at=now() WHERE workspace_id=$1 AND actor_user_id=$2 AND id=$3 RETURNING *`,
   [ctx.workspaceId,ctx.actorId,pending.goalId,JSON.stringify(goal.checkpoint),
    [n.resultAnswer,`Opened ${n.label} in your browser.`].filter(Boolean).join('\n\n')])).rows[0];
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={visible,begin,acknowledge};
