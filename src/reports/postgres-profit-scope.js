'use strict';

// Resolve identities in the report's own read-only snapshot. Supplying their
// values lets PostgreSQL distinguish rare profit lines from common opening
// asset/equity lines; a correlated account variable loses that skew information.
async function accountIds(database,workspaceId,config){
 const needed=config.dataset==='profit_activity'||config.metrics?.some(m=>m.dataset==='profit_activity');
 if(!needed)return null;
 return (await database.query("SELECT id FROM accounting_accounts WHERE workspace_id=$1 AND account_type IN('INCOME','COGS','EXPENSE') ORDER BY id",[workspaceId])).rows.map(r=>r.id);
}
function bind(source,values,ids){
 if(!source.includes('/*profit-account-scope*/')||!Array.isArray(ids))return source;
 values.push(ids);
 return source.replaceAll('/*profit-account-scope*/',`AND l.account_id=ANY($${values.length}::text[])`);
}
module.exports={accountIds,bind};
