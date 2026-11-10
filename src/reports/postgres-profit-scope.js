'use strict';

// Resolve identities in the report's own read-only snapshot. Supplying their
// values lets PostgreSQL distinguish rare report lines from common opening
// asset/equity lines; a correlated account variable loses that skew information.
const predicates=Object.freeze({
 profit_activity:"account_type IN('INCOME','COGS','EXPENSE')",
 posted_sales_activity:"system_key IN('SALES_REVENUE','SALES_RETURNS','COST_OF_GOODS_SOLD')",
 tax_activity:"subtype='TAX'",
 expenses:"account_type='EXPENSE'",
});
function conditions(config){return [...new Set([config.dataset,...(config.metrics||[]).map(m=>m.dataset)].map(key=>predicates[key]).filter(Boolean))];}
function required(config){return conditions(config).length>0;}
async function accountIds(database,workspaceId,config){
 const selected=conditions(config);if(!selected.length)return null;
 // Predicates come only from this fixed server-side map, never report text.
 return (await database.query('SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND ('+selected.map(p=>'('+p+')').join(' OR ')+') ORDER BY id',[workspaceId])).rows.map(r=>r.id);
}
function bind(source,values,ids){
 if(!/\/\*(?:profit|ledger)-account-scope\*\//.test(source)||!Array.isArray(ids))return source;
 values.push(ids);
 return source.replaceAll(/\/\*(?:profit|ledger)-account-scope\*\//g,`AND l.account_id=ANY($${values.length}::text[])`);
}
// Whether a profit report's period is quiet enough to read entry by entry (see
// profitActivityByEntry): both ends of the posting date are fixed dates and no
// more than ENTRY_LIMIT posted entries fall between them. Counting stops at the
// limit and walks the date index in order, so the check costs a few
// milliseconds even on a large history.
const ENTRY_LIMIT=2000,DAY=/^\d{4}-\d{2}-\d{2}$/;
async function byEntry(database,workspaceId,config){
 if(config.dataset!=='profit_activity')return false;
 const dates=(config.filters||[]).filter(f=>f.field==='posting_date');
 const from=dates.find(f=>['after','at_least'].includes(f.operator))?.value,to=dates.find(f=>['before','at_most'].includes(f.operator))?.value;
 if(!DAY.test(String(from||''))||!DAY.test(String(to||'')))return false;
 const n=(await database.query(`SELECT count(*)::int AS n FROM (SELECT 1 FROM accounting_journal_entries
   WHERE workspace_id=$1 AND posting_date>=$2 AND posting_date<=$3 AND status='POSTED' ORDER BY posting_date LIMIT ${ENTRY_LIMIT+1}) x`,[workspaceId,from,to])).rows[0].n;
 return n<=ENTRY_LIMIT;
}
module.exports={accountIds,bind,required,byEntry,ENTRY_LIMIT};
