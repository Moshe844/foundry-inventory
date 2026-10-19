'use strict';

// Only fixed relations and join columns are eligible for this maintenance.
// No source text, record values, permissions or business rows are changed.
const INVENTORY_TABLES=[
 ['skus','id,workspace_id,item_id,is_active'],['balances','workspace_id,sku_id,location_id'],
 ['accounting_journal_entries','id,workspace_id,source_type,source_record_type,source_record_id'],
 ['accounting_journal_lines','entry_id,workspace_id,account_id'],['items','id,workspace_id,is_active'],
 ['item_location_balances','workspace_id,item_id,location_id'],['item_catalog_rollups','workspace_id,item_id'],
 ['sku_prices','workspace_id,sku_id,source'],['sku_option_values','sku_id,option_id'],
 ['item_options','id,workspace_id,item_id'],['movements','id,workspace_id,sku_id,location_id'],
 ['accounting_inventory_cost_balances','workspace_id,sku_id,location_id'],
 ['accounting_inventory_cost_movements','workspace_id,inventory_movement_id,cost_source_type,cost_source_record_id']
];

async function refreshAfterImport(database,result){
 const rows=Number(result?.rowsImported);
 if(!result?.verified||!Number.isSafeInteger(rows)||rows<500)return {state:'NOT_REQUIRED',refreshed:[],deferred:[]};
 const tables=result.suppliersCreated!==undefined?[['suppliers','id,workspace_id']]:INVENTORY_TABLES;
 const refreshed=[],deferred=[],deadline=Date.now()+20000;
 for(const [name,columns]of tables){
  if(Date.now()>=deadline){deferred.push({table:name,reason:'maintenance_budget'});continue;}
  try{
   await database.transaction(client=>client.query(`ANALYZE public.${name} (${columns})`),
     {isolation:'READ COMMITTED',statementTimeoutMs:4000,lockTimeoutMs:500});
   refreshed.push(name);
  }catch(error){deferred.push({table:name,reason:error.code||'maintenance_unavailable'});}
 }
 return {state:deferred.length?'DEFERRED':'COMPLETE',refreshed,deferred};
}

module.exports={refreshAfterImport};
