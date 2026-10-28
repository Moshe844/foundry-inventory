'use strict';
async function dueDate(db,workspaceId,customerId,issueDate){const terms=(await db.query('SELECT kind,net_days FROM customer_payment_terms WHERE workspace_id=$1 AND (customer_id=$2 OR customer_id IS NULL) ORDER BY (customer_id IS NOT NULL) DESC LIMIT 1',[workspaceId,customerId])).rows[0];return require('./customer-money').addDays(issueDate,terms?.kind&&terms.kind!=='ON_ACCOUNT'?0:terms?.net_days??30);}
module.exports={dueDate};
