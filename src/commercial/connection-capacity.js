'use strict';
// Connected systems (including paused/reconnect-required systems) keep their
// slot. Consent attempts never occupy one. Callback admission and the meter
// use the same predicate; serializable entitlement locks protect the last slot.
const predicate=`((connector.status<>'disconnected' AND NOT (
 connector.setup_status IN ('AUTHORIZING','AUTHORIZATION_FAILED')
 AND connector.credential_ref IS NULL AND connector.provider_account_id IS NULL)))`;
async function activationDelta(database,workspaceId,connectorId){
 const row=(await database.query(`SELECT ${predicate} AS occupied FROM workspace_connectors connector
  WHERE connector.workspace_id=$1 AND connector.id=$2`,[workspaceId,connectorId])).rows[0];
 return row?.occupied?0:1;
}
module.exports={predicate,activationDelta};
