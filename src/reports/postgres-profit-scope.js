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
module.exports={accountIds,bind,required};
