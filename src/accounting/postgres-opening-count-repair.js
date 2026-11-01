'use strict';
const ledger=require('./postgres-ledger');
// Reclassify only proven first-stock count entries. Never rewrite a journal,
// physical movement, source row, or inventory-cost record.
async function candidates(client,workspaceId,limit=500){
 return (await client.query(`SELECT e.id,e.posting_date,l.currency,sum(l.credit_minor) FILTER(WHERE a.system_key='INVENTORY_ADJUSTMENTS')::text amount_minor
 FROM accounting_journal_entries e JOIN import_rows r ON r.workspace_id=e.workspace_id AND r.id=e.source_record_id AND r.status='IMPORTED'
 JOIN movements m ON m.workspace_id=r.workspace_id AND m.id=(r.movement_ids::jsonb->>0)
 JOIN accounting_journal_lines l ON l.workspace_id=e.workspace_id AND l.entry_id=e.id
 JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id
 WHERE e.workspace_id=$1 AND e.status='POSTED' AND e.source_type='import_stock_count' AND e.source_record_type='import_row'
 AND (r.parsed::jsonb#>>'{inventoryBefore,physical}')::numeric=0 AND (r.parsed::jsonb#>>'{inventoryBefore,costed}')::numeric=0
 AND m.quantity_delta>0 AND m.balance_after=m.quantity_delta
 AND NOT EXISTS(SELECT 1 FROM movements before WHERE before.workspace_id=m.workspace_id AND before.sku_id=m.sku_id AND before.location_id=m.location_id AND before.seq<m.seq)
 AND NOT EXISTS(SELECT 1 FROM accounting_journal_entries correction WHERE correction.workspace_id=e.workspace_id AND (correction.source_key='opening-count-reclassification:'||e.id OR correction.reversal_of_entry_id=e.id))
 GROUP BY e.id,e.posting_date,l.currency HAVING count(*)=2
 AND sum(CASE WHEN a.system_key='INVENTORY_ASSET' THEN l.debit_minor-l.credit_minor ELSE 0 END)>0
 AND sum(CASE WHEN a.system_key='INVENTORY_ASSET' THEN l.debit_minor-l.credit_minor ELSE 0 END)=sum(CASE WHEN a.system_key='INVENTORY_ADJUSTMENTS' THEN l.credit_minor-l.debit_minor ELSE 0 END)
 ORDER BY e.id LIMIT $2`,[workspaceId,Math.min(500,Math.max(1,limit))])).rows;
}
async function repair(database,ctx,{dryRun=true,limit=500}={}){
 return database.transaction(async client=>{
  const rows=await candidates(client,ctx.workspaceId,limit);
  if(!dryRun&&rows.length)await ledger.postManyInTransaction(client,ctx,rows.map(r=>({postingDate:r.posting_date,currency:r.currency,sourceKey:'opening-count-reclassification:'+r.id,sourceType:'opening_count_correction',sourceRecordType:'journal_entry',sourceRecordId:r.id,
   description:'Correct first-stock import classification: opening stock is not profit',metadata:{originalEntryId:r.id,reason:'First positive stock movement imported into an empty catalogue'},
   lines:[{accountKey:'INVENTORY_ADJUSTMENTS',debitMinor:Number(r.amount_minor)},{accountKey:'OPENING_BALANCE_EQUITY',creditMinor:Number(r.amount_minor)}]})));
  return {dryRun,entries:rows.length,amountMinor:rows.reduce((n,r)=>n+Number(r.amount_minor),0)};
 },{isolation:'SERIALIZABLE',retrySafe:true});
}
module.exports={candidates,repair};
