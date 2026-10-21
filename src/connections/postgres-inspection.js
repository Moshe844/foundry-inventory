'use strict';
// Read the same connection and accounting state used by Settings. This never
// loads credentials, initializes a policy, calls a provider or enables writes.
const permissions=require('../actions/permissions'),connections=require('./postgres-service'),providers=require('./providers/registry');
async function inspect(database,ctx,{search=null}={}){
 const checkedAt=Date.now();
 const actor=(await database.query('SELECT role,permissions FROM users WHERE workspace_id=$1 AND id=$2',[ctx.workspaceId,ctx.actorId])).rows[0];
 permissions.assertCan(actor,permissions.VIEW,'view connections');
 const administrative=permissions.can(actor,permissions.ADMIN),financial=permissions.can(actor,permissions.VIEW_ACCOUNTING);
 const all=await connections.list(database,ctx.workspaceId,{now:checkedAt}),matching=all.filter(c=>!search||[c.display_name,c.connector_key,c.provider_type].some(v=>String(v||'').toLowerCase().includes(search.toLowerCase()))),rows=[];
 const selected=matching.slice(0,100),ids=selected.map(c=>c.id),recorded=administrative&&ids.length?(await database.query(`SELECT connector_id,'catalogue'::text source,entity_type kind,mapping_status status,count(*)::text n
  FROM connection_external_records WHERE workspace_id=$1 AND connector_id=ANY($2::text[]) AND selected=1 GROUP BY connector_id,entity_type,mapping_status
  UNION ALL SELECT connector_id,'sync_run',sync_kind,status,count(*)::text FROM connection_sync_runs
   WHERE workspace_id=$1 AND connector_id=ANY($2::text[]) GROUP BY connector_id,sync_kind,status
  UNION ALL SELECT connector_id,'webhook_receipt','incoming',status,count(*)::text FROM connection_webhook_receipts
   WHERE workspace_id=$1 AND connector_id=ANY($2::text[]) GROUP BY connector_id,status
  UNION ALL SELECT connector_id,'feed_event','normalized',status,count(*)::text FROM connector_feed_events
   WHERE workspace_id=$1 AND connector_id=ANY($2::text[]) GROUP BY connector_id,status
  ORDER BY connector_id,source,kind,status`,[ctx.workspaceId,ids])).rows:[];
 for(const c of selected){
  const row={id:c.id,name:c.display_name,provider:c.provider_type,status:c.status,health:c.publicStatus,
   lastSynced:c.last_synced_at||'Never',error:c.last_error?'This connection needs attention. Review its current setup details.':'',href:'/settings/connections/'+c.id};
  if(administrative){Object.assign(row,{setup:c.setup_status,paused:Boolean(c.paused_at),
   savedGrantedCapabilities:c.capabilities,productsMapped:c.productsMapped,locationsMapped:c.locationsMapped,
   recordsAwaitingMapping:c.itemsNeedingMapping,openIssues:c.openIssues,
   recordedHealth:connections.publicHealth(c,checkedAt)});
   const states=recorded.filter(r=>r.connector_id===c.id).map(({source,kind,status,n})=>{
    const count=Number(n);if(!Number.isSafeInteger(count)||count<0)throw Error('CONNECTION_STATE_COUNT_PRECISION');
    return {source,kind,status,count};});
   row.selectedCatalogueStates=states.filter(r=>r.source==='catalogue').map(({kind,status,count})=>({entityType:kind,status,count}));
   row.productsAwaitingMapping=row.selectedCatalogueStates.find(r=>r.entityType==='sku'&&r.status==='UNMAPPED')?.count||0;
   row.locationsAwaitingMapping=row.selectedCatalogueStates.find(r=>r.entityType==='location'&&r.status==='UNMAPPED')?.count||0;
   row.recordedSynchronizationStates=states.filter(r=>r.source!=='catalogue');
   row.stockAndPriceSynchronization=await require('./postgres-commerce-sync').list(database,ctx.workspaceId,c.id);
   if(providers.get(c.provider_type)?.integrationClass==='accounting'){
    if(!financial)row.accounting={available:false,reason:'Accounting visibility is not granted.'};
    else if(c.status!=='connected')row.accounting={available:false,reason:'This saved connection is disconnected; it cannot post.'};
    else{const state=await require('../accounting/postgres-integration-sync').state(database,ctx.workspaceId,c.id,{includeFinancialEntries:false});
     row.accounting=state?{available:true,requestedAuthority:state.policy.requested_authority,
      postingDirection:state.policy.posting_direction,stage:state.policy.stage,
      savedPostingScopeGranted:c.capabilities.includes('accounting:post'),providerHasWriteVerifier:state.canVerifyWrites,
      writeEnabledAt:state.policy.write_enabled_at||null,accountMappings:state.mappings.length,
      postingEnablement:require('../accounting/postgres-integration-sync').postingRequirements({current:state.policy,canVerifyWrites:state.canVerifyWrites,capabilities:c.capabilities,shadowStatus:state.currentShadowStatus}),
      latestShadow:state.latestShadow?{status:state.latestShadow.status,current:state.latestShadow.isCurrent,
       differenceCount:state.latestShadow.differences.length,completedAt:state.latestShadow.completed_at||null}:null}:
      {available:false,reason:'The saved accounting setup could not be verified from current records.'};
    }
   }
  }
  rows.push(row);
 }
 return {rows,administrativeDetailsAvailable:administrative,
  savedStateCoverage:{available:administrative,complete:administrative,scope:'Selected cached catalogue records, saved synchronization runs, incoming webhook receipts and normalized feed events for each returned connection. Sources are separate representations and their counts must not be added together. Sync-run counts cover saved history; a past failed run alone does not establish a current failure. Recorded processing states do not prove that a worker is currently executing. Absent state combinations have zero saved records within these sources. This does not inspect external provider queues, arbitrary background jobs or current authorization validity.'},
  coverage:{matchingConnections:matching.length,returnedConnections:rows.length,complete:rows.length===matching.length},
  verification:'Saved connection, authorization and canonical accounting setup state. This read does not contact a provider or prove current external access. Connected status or granted scope alone does not authorize posting; execution repeats current canonical gates.'};
}
module.exports={inspect};
