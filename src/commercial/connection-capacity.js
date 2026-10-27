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
const groups={sales_channels:['shopify','woocommerce','bigcommerce','square','clover'],shipping_accounts:['shippo','easypost','shipengine','shipstation','shipstation_v2','shipstation_custom_store','veeqo','easyship']};
function countQuery(meter){const types=groups[meter];if(!types)throw Error('Unknown connection group');return `SELECT count(*) AS used FROM workspace_connectors connector JOIN workspaces workspace ON workspace.id=connector.workspace_id WHERE workspace.owner_account_id=$1 AND workspace.deletion_requested_at IS NULL AND ${predicate} AND connector.provider_type IN (${types.map(t=>"'"+t+"'").join(',')})`;}
async function assertActivation(database,scope,type,delta){const entitlements=require('./entitlements');await entitlements.assertMeterCapacity(database,scope,'connections',delta);for(const [meter,types]of Object.entries(groups))if(types.includes(type))await entitlements.assertMeterCapacity(database,scope,meter,delta);}
module.exports={predicate,activationDelta,countQuery,assertActivation};
