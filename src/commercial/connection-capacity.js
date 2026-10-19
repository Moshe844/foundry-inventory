'use strict';
// Connected systems (including paused/reconnect-required systems) keep their
// slot. An abandoned consent window is a temporary reservation, not a lifetime
// connection. Use the same predicate for the meter and final activation.
const predicate=`((connector.status<>'disconnected' AND NOT (
 connector.setup_status IN ('AUTHORIZING','AUTHORIZATION_FAILED')
 AND connector.credential_ref IS NULL AND connector.provider_account_id IS NULL))
 OR (connector.setup_status='AUTHORIZING' AND EXISTS (
 SELECT 1 FROM connection_authorization_states consent
 WHERE consent.workspace_id=connector.workspace_id AND consent.connector_id=connector.id
 AND consent.used_at IS NULL AND consent.expires_at::timestamptz>now())))`;
async function activationDelta(database,workspaceId,connectorId){
 const row=(await database.query(`SELECT ${predicate} AS occupied FROM workspace_connectors connector
  WHERE connector.workspace_id=$1 AND connector.id=$2`,[workspaceId,connectorId])).rows[0];
 return row?.occupied?0:1;
}
module.exports={predicate,activationDelta};
