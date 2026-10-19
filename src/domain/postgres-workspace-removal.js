'use strict';
const {AuthorizationError,NotFoundError,ValidationError}=require('./errors');
async function owned(db,accountId,workspaceId,{lock=false}={}){
 const row=(await db.query(`SELECT w.*,u.id AS actor_id,u.role FROM workspaces w JOIN users u ON u.workspace_id=w.id AND u.account_id=$1
  WHERE w.id=$2 ${lock?'FOR UPDATE OF w':''}`,[accountId,workspaceId])).rows[0];
 if(!row)throw new NotFoundError('That inventory could not be found.');if(row.role!=='owner')throw new AuthorizationError('Only an owner can delete an inventory.');return row;
}
async function describe(db,accountId,workspaceId){const workspace=await owned(db,accountId,workspaceId);
 const summary=(await db.query(`SELECT
  (SELECT count(*) FROM items WHERE workspace_id=$1) AS products,
  (SELECT count(*) FROM locations WHERE workspace_id=$1) AS locations,
  (SELECT coalesce(sum(on_hand),0) FROM balances WHERE workspace_id=$1) AS units,
  (SELECT count(*) FROM workspace_connectors WHERE workspace_id=$1 AND status='connected') AS connections,
  (SELECT count(*) FROM users WHERE workspace_id=$1) AS members`,[workspaceId])).rows[0];return {workspace,summary};}
async function remove(db,accountId,workspaceId,input={}){return db.transaction(async client=>{
 const workspace=await owned(client,accountId,workspaceId,{lock:true});
 if(String(input.confirmName||'').trim()!==workspace.name.trim())throw new ValidationError('Type the inventory name exactly to confirm deletion.');
 if(workspace.deletion_requested_at)return {name:workspace.name,replayed:true};
 const pending=(await client.query(`SELECT
  EXISTS(SELECT 1 FROM stockchief_runtime.jobs WHERE workspace_id=$1 AND status='RUNNING') OR
  EXISTS(SELECT 1 FROM commercial_model_cost_holds WHERE workspace_id=$1 AND status IN ('RESERVED','UNKNOWN')) OR
  EXISTS(SELECT 1 FROM stockchief_runtime.codex_pilot_calls WHERE workspace_id=$1 AND state IN ('RESERVED','UNKNOWN')) OR
  EXISTS(SELECT 1 FROM stockchief_runtime.provider_effects WHERE workspace_id=$1 AND status IN ('RUNNING','AMBIGUOUS')) AS blocked`,[workspaceId])).rows[0];
 if(pending.blocked)throw new ValidationError('Current work or an unverified external result must finish before this inventory can be deleted. Its records have not changed.');
 const {summary}=await describe(client,accountId,workspaceId);
 await client.query('INSERT INTO stockchief_runtime.workspace_removals(workspace_id,requested_by_account_id,requested_by_actor_id,summary) VALUES($1,$2,$3,$4::jsonb)',[workspaceId,accountId,workspace.actor_id,JSON.stringify(summary)]);
 await client.query('UPDATE workspaces SET deletion_requested_at=$2 WHERE id=$1',[workspaceId,new Date().toISOString()]);
 await client.query("UPDATE workspace_connectors SET paused_at=$2,status='disconnected',updated_at=$2 WHERE workspace_id=$1",[workspaceId,new Date().toISOString()]);
 await client.query('DELETE FROM connection_credentials WHERE workspace_id=$1',[workspaceId]);
 await client.query('UPDATE public_api_clients SET revoked_at=$2 WHERE workspace_id=$1 AND revoked_at IS NULL',[workspaceId,new Date().toISOString()]);
 await client.query("UPDATE stockchief_runtime.assistant_goals SET status='CANCELLED',run_token=NULL,lease_until=NULL,answer='This inventory was deleted. Existing business history is retained.',updated_at=now() WHERE workspace_id=$1 AND status NOT IN ('COMPLETED','CANCELLED')",[workspaceId]);
 await client.query("UPDATE stockchief_runtime.jobs SET status='CANCELLED',completed_at=now(),updated_at=now() WHERE workspace_id=$1 AND status IN ('PENDING','RETRY','PAUSED')",[workspaceId]);
 await client.query("UPDATE stockchief_runtime.provider_effects SET status='CANCELLED',updated_at=now() WHERE workspace_id=$1 AND status='PENDING'",[workspaceId]);
 await client.query('UPDATE accounts SET last_workspace_id=NULL WHERE last_workspace_id=$1',[workspaceId]);
 return {name:workspace.name,replayed:false};
 },{isolation:'SERIALIZABLE',retrySafe:true});}
module.exports={describe,remove};
