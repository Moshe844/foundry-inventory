'use strict';

// Reconcile the exact frozen source identities in bounded key batches. A final
// whole-import join can otherwise sort or rescan every freshly written record
// while its committed statistics still describe an empty inventory.
async function totals(client,workspaceId,rowIds){
 let value=0n,posted=0n,movements=0;
 const accounts=(await client.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='INVENTORY_ASSET'",[workspaceId])).rows.map(row=>row.id);
 for(let start=0;start<rowIds.length;start+=500){const ids=rowIds.slice(start,start+500);
  const cost=(await client.query(`SELECT COALESCE(sum(cost_delta_minor),0)::text AS value,count(*)::int AS movements
   FROM accounting_inventory_cost_movements WHERE workspace_id=$1
    AND cost_source_type IN ('opening_inventory','import_stock_count') AND cost_source_record_id=ANY($2::text[])`,[workspaceId,ids])).rows[0];
  value+=BigInt(cost.value);movements+=Number(cost.movements);
  const entries=(await client.query(`SELECT id FROM accounting_journal_entries WHERE workspace_id=$1
   AND source_type IN ('opening_inventory','import_stock_count') AND source_record_type='import_row'
   AND source_record_id=ANY($2::text[])`,[workspaceId,ids])).rows.map(row=>row.id);
  for(let offset=0;offset<entries.length;offset+=500){const lines=(await client.query(`SELECT COALESCE(sum(debit_minor-credit_minor),0)::text AS value
   FROM accounting_journal_lines WHERE workspace_id=$1 AND entry_id=ANY($2::text[]) AND account_id=ANY($3::text[])`,[workspaceId,entries.slice(offset,offset+500),accounts])).rows[0];posted+=BigInt(lines.value);}
 }
 return {value:{value:value.toString(),movements},posted:{value:posted.toString()}};
}
module.exports={totals};
