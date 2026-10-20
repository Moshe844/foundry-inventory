'use strict';
// Read the same connection and accounting state used by Settings. This never
// loads credentials, initializes a policy, calls a provider or enables writes.
const permissions=require('../actions/permissions'),connections=require('./postgres-service'),providers=require('./providers/registry');
async function inspect(database,ctx,{search=null}={}){
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 permissions.assertCan(actor,permissions.VIEW,'view connections');
 const administrative=permissions.can(actor,permissions.ADMIN),financial=permissions.can(actor,permissions.VIEW_ACCOUNTING);
 const all=await connections.list(database,ctx.workspaceId),matching=all.filter(c=>!search||[c.display_name,c.connector_key,c.provider_type].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))),rows=[];
 for(const c of matching.slice(0,100)){
  const row={id:c.id,name:c.display_name,provider:c.provider_type,status:c.status,health:c.publicStatus,
   lastSynced:c.last_synced_at||'Never',error:c.last_error?'This connection needs attention. Review its current setup details.':'',href:'/settings/connections/'+c.id};
  if(administrative){Object.assign(row,{setup:c.setup_status,paused:Boolean(c.paused_at),
   savedGrantedCapabilities:c.capabilities,productsMapped:c.productsMapped,locationsMapped:c.locationsMapped,
   productsAwaitingMapping:c.itemsNeedingMapping,openIssues:c.openIssues});
   if(providers.get(c.provider_type)?.integrationClass==='accounting'){
    if(!financial)row.accounting={available:false,reason:'Accounting visibility is not granted.'};
    else if(c.status!=='connected')row.accounting={available:false,reason:'This saved connection is disconnected; it cannot post.'};
    else{const state=await require('../accounting/postgres-integration-sync').state(database,ctx.workspaceId,c.id,{includeFinancialEntries:false});
     row.accounting=state?{available:true,requestedAuthority:state.policy.requested_authority,
      postingDirection:state.policy.posting_direction,stage:state.policy.stage,
      savedPostingScopeGranted:c.capabilities.includes('accounting:post'),providerHasWriteVerifier:state.canVerifyWrites,
      writeEnabledAt:state.policy.write_enabled_at||null,accountMappings:state.mappings.length,
      latestShadow:state.latestShadow?{status:state.latestShadow.status,current:state.latestShadow.isCurrent,
       differenceCount:state.latestShadow.differences.length,completedAt:state.latestShadow.completed_at||null}:null}:
      {available:false,reason:'The saved accounting setup could not be verified from current records.'};
    }
   }
  }
  rows.push(row);
 }
 return {rows,administrativeDetailsAvailable:administrative,
  coverage:{matchingConnections:matching.length,returnedConnections:rows.length,complete:rows.length===matching.length},
  verification:'Saved connection, authorization and canonical accounting setup state. This read does not contact a provider or prove current external access. Connected status or granted scope alone does not authorize posting; execution repeats current canonical gates.'};
}
module.exports={inspect};
