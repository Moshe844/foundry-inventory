'use strict';
function status(connection){
  if(!connection||connection.status==='disconnected')return 'Not connected';
  if(connection.status==='error'||['AUTHORIZATION_FAILED','REAUTHORIZATION_REQUIRED'].includes(connection.setup_status))return 'Error';
  if(connection.status==='connected')return 'Connected';
  return 'Not connected';
}
function cards(catalog,connections){
  return catalog.map(provider=>{
    const records=connections.filter(c=>c.provider_type===provider.type&&c.status!=='disconnected');
    const connection=records.find(c=>status(c)==='Connected')||records[0]||null;
    const state=status(connection);
    return {provider,connection,records,state,lastSync:connection?.last_synced_at||null,
      action:connection?'Manage':'Connect',href:connection?'/settings/connections/'+encodeURIComponent(connection.id):null,
      needsMatching:Number(connection?.itemsNeedingMapping||0)+Number(connection?.locationsNeedingMapping||0)};
  });
}
module.exports={status,cards};
