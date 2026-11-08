'use strict';
const {ValidationError}=require('../domain/errors');
// Reconcile a bounded source batch in one statement. Materialized canonical
// rows are shared by the cost, posted-value and per-row identity checks. The
// Durable batch receipts carry these checks into final reconciliation. Use a
// hashed selected-row set for membership checks: ANY(parameter-array) applied
// to every journal line otherwise compares each line with the whole batch.
const SQL=`WITH selected_rows AS MATERIALIZED (
 SELECT DISTINCT unnest($2::text[]) AS row_id
), costs AS MATERIALIZED (
 SELECT cost_source_record_id AS row_id,sku_id,location_id,journal_entry_id,cost_delta_minor
 FROM accounting_inventory_cost_movements WHERE workspace_id=$1
 AND cost_source_type IN('opening_inventory','import_stock_count') AND cost_source_record_id=ANY($2::text[])
), entries AS MATERIALIZED (
 SELECT id,source_record_type FROM accounting_journal_entries WHERE workspace_id=$1
 AND id=ANY(ARRAY(SELECT DISTINCT journal_entry_id FROM costs WHERE journal_entry_id IS NOT NULL))
 AND source_type IN('opening_inventory','import_stock_count')
 AND ((source_record_type='import_row' AND source_record_id IN(SELECT row_id FROM selected_rows)) OR source_record_type='import_batch')
), lines AS MATERIALIZED (
 SELECT l.entry_id,l.sku_id,l.location_id,l.metadata::jsonb->>'importRowId' AS row_id,
 l.debit_minor-l.credit_minor AS amount,e.source_record_type
 FROM accounting_journal_lines l JOIN entries e ON e.id=l.entry_id
 WHERE l.workspace_id=$1 AND l.entry_id=ANY(ARRAY(SELECT id FROM entries))
 AND l.account_id=ANY(ARRAY(SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND system_key='INVENTORY_ASSET'))
), selected_lines AS MATERIALIZED (
 -- Keep membership in a materialized projection. Turning it into a semi-join
 -- lets fresh-table estimates choose a nested scan of every selected ID for
 -- every line; the independent subplan hashes the bounded ID set once.
 SELECT l.*,l.row_id IN(SELECT row_id FROM selected_rows) AS row_selected FROM lines l
), expected AS (
 SELECT row_id,sku_id,location_id,journal_entry_id AS entry_id,sum(cost_delta_minor) AS amount
 FROM costs WHERE journal_entry_id=ANY(ARRAY(SELECT id FROM entries WHERE source_record_type='import_batch'))
 GROUP BY row_id,sku_id,location_id,journal_entry_id
), actual AS (
 SELECT row_id,sku_id,location_id,entry_id,sum(amount) AS amount,count(*) AS lines
 FROM selected_lines WHERE source_record_type='import_batch' AND row_selected
 GROUP BY row_id,sku_id,location_id,entry_id
)
SELECT (SELECT coalesce(sum(cost_delta_minor),0)::text FROM costs) AS value,
 (SELECT count(*)::int FROM costs) AS movements,
 (SELECT coalesce(sum(amount),0)::text FROM selected_lines WHERE source_record_type='import_row' OR row_selected) AS posted,
 (SELECT count(*)::int FROM expected e FULL JOIN actual a USING(row_id,sku_id,location_id,entry_id)
 WHERE e.amount IS NULL OR a.amount IS NULL OR e.amount<>a.amount OR a.lines<>1) AS mismatches
`;
async function totals(client,workspaceId,rowIds){
 let value=0n,posted=0n,movements=0;
 for(let start=0;start<rowIds.length;start+=2000){
  const row=(await client.query(SQL,[workspaceId,rowIds.slice(start,start+2000)])).rows[0];
  if(row.mismatches)throw new ValidationError('The imported source rows and their recorded receipt values do not match. The current batch was not saved.');
  value+=BigInt(row.value);posted+=BigInt(row.posted);movements+=Number(row.movements);
 }
 return {value:{value:value.toString(),movements},posted:{value:posted.toString()}};
}
module.exports={totals};
