'use strict';
const {newId,nowIso}=require('../lib/util');
const {AuthenticationError}=require('../domain/errors');
// This is a server-owned consent intent, not a saved business connection.
const TTL_MS=30*60*1000;
function draft(workspaceId,actorId,provider,metadata={}){
 const id=newId('con'),at=nowIso();
 return {id,workspace_id:workspaceId,provider_type:provider,display_name:metadata.name||provider,
  connector_key:provider+':'+id,provides:metadata.provides||[],capabilities:[],
  config:metadata.config||{},expected_interval_minutes:1,authorized_by_user_id:actorId,
  created_at:at,updated_at:at,_pending:true};
}
async function connectionForState(database,state){
 if(state.connector_id)return require('./postgres-service').get(database,state.workspace_id,state.connector_id);
 const pending=state.metadata?.pendingConnection;
 if(!pending?._pending||pending.workspace_id!==state.workspace_id||pending.authorized_by_user_id!==state.actor_id||
    pending.provider_type!==(state.provider_type==='stripe_connect'?'stripe':state.provider_type))
  throw new AuthenticationError('This connection request is unavailable. Please start again.');
 return pending;
}
async function insert(database,connection){
 await database.query(`INSERT INTO workspace_connectors
  (id,workspace_id,connector_key,display_name,provider_type,status,capabilities,provides,config,
   expected_interval_minutes,setup_status,authorized_by_user_id,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'disconnected',$6,$7,$8,$9,'AUTHORIZING',$10,$11,$11)`,
 [connection.id,connection.workspace_id,connection.connector_key,connection.display_name,connection.provider_type,
  JSON.stringify(connection.capabilities||[]),JSON.stringify(connection.provides||[]),JSON.stringify(connection.config||{}),
  connection.expected_interval_minutes||1,connection.authorized_by_user_id,connection.created_at]);
}
module.exports={TTL_MS,draft,connectionForState,insert};
