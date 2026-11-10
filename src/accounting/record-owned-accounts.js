'use strict';
// Accounts whose balance is the sum of records StockChief keeps: invoices,
// bills, payments, deposits, returns and stock. A hand-made entry on one, or an
// isolated reversal of an entry one of those records made, would leave the
// books disagreeing with the records with nothing on the record to say why. So
// they change only through the records themselves: void the payment, credit
// the invoice, count the stock.
const {ValidationError}=require('../domain/errors');
const {DEFAULT_ACCOUNTS}=require('./chart');

const KEPT=new Map(DEFAULT_ACCOUNTS.filter(account=>account.keptBy).map(account=>[account.systemKey,account.keptBy]));
const HAND_MADE='manual_adjustment',REVERSAL='journal_reversal';
const PAYMENT_SOURCES=new Set(['customer_payment','supplier_payment','customer_deposit']);

function keptBy(systemKey){return KEPT.get(systemKey)||null;}

// Why an existing entry cannot be corrected from the entry screen, or null if
// it can. `lines` carry each line's account `system_key` and `account_name`.
function reversalBlocker(entry,lines){
  if(!entry||entry.source_type===HAND_MADE||entry.reversal_of_entry_id)return null;
  const kept=lines.find(line=>keptBy(line.system_key));if(!kept)return null;
  if(entry.source_type==='payment_void')return {kind:'record',message:'This entry voids a payment, and a void is final. If the payment was real after all, record it again on its invoice.'};
  if(PAYMENT_SOURCES.has(entry.source_type))return {kind:'payment',message:'This entry belongs to a payment. Void the payment instead, so the payment, its invoice or bill, and your books all change together.'};
  return {kind:'record',message:`This entry was made by a ${String(entry.source_type||'business record').replaceAll('_',' ')} and changes ${kept.account_name}, which is kept in step with your ${keptBy(kept.system_key)}. Change that record instead, so the record and your books stay the same.`};
}

// Called by the ledger before posting. Only hand-made entries and entry-screen
// reversals are checked; records post through their own engines.
async function assertHandEntries(client,workspaceId,rows){
  for(const {input,lines} of rows){
    if(input.sourceType===HAND_MADE){
      const ids=[...new Set(lines.map(line=>line.accountId).filter(Boolean))],keys=[...new Set(lines.map(line=>line.accountKey).filter(Boolean))];
      const accounts=(await client.query('SELECT name,system_key FROM accounting_accounts WHERE workspace_id=$1 AND (id=ANY($2::text[]) OR system_key=ANY($3::text[]))',[workspaceId,ids,keys])).rows;
      const kept=accounts.find(account=>keptBy(account.system_key));
      if(kept)throw new ValidationError(`${kept.name} is kept in step with your ${keptBy(kept.system_key)}, so it can't take a hand-made entry. Make the change on those records instead.`);
    }
    if(input.sourceType===REVERSAL&&input.reversalOfEntryId){
      const entry=(await client.query('SELECT id,source_type,reversal_of_entry_id FROM accounting_journal_entries WHERE workspace_id=$1 AND id=$2',[workspaceId,input.reversalOfEntryId])).rows[0];
      const entryLines=entry?(await client.query(`SELECT a.name AS account_name,a.system_key FROM accounting_journal_lines l
        JOIN accounting_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id WHERE l.workspace_id=$1 AND l.entry_id=$2`,[workspaceId,entry.id])).rows:[];
      const blocker=reversalBlocker(entry,entryLines);
      if(blocker)throw new ValidationError(blocker.message);
    }
  }
}

module.exports={keptBy,reversalBlocker,assertHandEntries,keptAccountKeys:()=>[...KEPT.keys()]};
