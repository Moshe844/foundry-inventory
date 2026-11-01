'use strict';
const {ValidationError}=require('../domain/errors');

// Reconcile the exact frozen source identities in bounded key batches. A final
// whole-import join can otherwise sort or rescan every freshly written record
// while its committed statistics still describe an empty inventory.
async function totals(client,workspaceId,rowIds){
 let value=0n,posted=0n,movements=0;
 const accounts=(await client.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='INVENTORY_ASSET'",[workspaceId])).rows.map(row=>row.id);
 for(let start=0;start<rowIds.length;start+=500){const ids=rowIds.slice(start,start+500);
  const cost=(await client.query(`SELECT COALESCE(sum(cost_delta_minor),0)::text AS value,count(*)::int AS movements,array_remove(array_agg(DISTINCT journal_entry_id),NULL) AS journal_ids
   FROM accounting_inventory_cost_movements WHERE workspace_id=$1
    AND cost_source_type IN ('opening_inventory','import_stock_count') AND cost_source_record_id=ANY($2::text[])`,[workspaceId,ids])).rows[0];
  value+=BigInt(cost.value);movements+=Number(cost.movements);
  const entries=cost.journal_ids?.length?(await client.query(`SELECT id,source_record_type FROM accounting_journal_entries WHERE workspace_id=$1
   AND id=ANY($2::text[]) AND source_type IN ('opening_inventory','import_stock_count')
   AND ((source_record_type='import_row' AND source_record_id=ANY($3::text[])) OR source_record_type='import_batch')`,[workspaceId,cost.journal_ids,ids])).rows:[];
  for(let offset=0;offset<entries.length;offset+=500){const page=entries.slice(offset,offset+500),legacy=page.filter(e=>e.source_record_type==='import_row').map(e=>e.id),batches=page.filter(e=>e.source_record_type==='import_batch').map(e=>e.id),lines=(await client.query(`SELECT COALESCE(sum(debit_minor-credit_minor),0)::text AS value
   FROM accounting_journal_lines WHERE workspace_id=$1 AND entry_id=ANY($2::text[]) AND account_id=ANY($3::text[])
   AND (entry_id=ANY($4::text[]) OR (entry_id=ANY($5::text[]) AND metadata::jsonb->>'importRowId'=ANY($6::text[])))`,[workspaceId,page.map(e=>e.id),accounts,legacy,batches,ids])).rows[0];posted+=BigInt(lines.value);
   if(batches.length){const mismatch=(await client.query(`WITH expected AS(
    SELECT cost_source_record_id row_id,sku_id,location_id,journal_entry_id entry_id,sum(cost_delta_minor) amount
    FROM accounting_inventory_cost_movements WHERE workspace_id=$1 AND cost_source_record_id=ANY($2::text[]) AND journal_entry_id=ANY($3::text[])
     AND cost_source_type IN('opening_inventory','import_stock_count') GROUP BY cost_source_record_id,sku_id,location_id,journal_entry_id
   ),actual AS(
    SELECT metadata::jsonb->>'importRowId' row_id,sku_id,location_id,entry_id,sum(debit_minor-credit_minor) amount,count(*) lines
    FROM accounting_journal_lines WHERE workspace_id=$1 AND entry_id=ANY($3::text[]) AND account_id=ANY($4::text[]) AND metadata::jsonb->>'importRowId'=ANY($2::text[])
    GROUP BY metadata::jsonb->>'importRowId',sku_id,location_id,entry_id
   ) SELECT count(*)::int n FROM expected e FULL JOIN actual a USING(row_id,sku_id,location_id,entry_id)
   WHERE e.amount IS NULL OR a.amount IS NULL OR e.amount<>a.amount OR a.lines<>1`,[workspaceId,ids,batches,accounts])).rows[0];if(mismatch.n)throw new ValidationError('The imported source rows and their recorded receipt values do not match. The current batch was not saved.');}
  }
 }
 return {value:{value:value.toString(),movements},posted:{value:posted.toString()}};
}
module.exports={totals};
