'use strict';
async function dueDate(db,workspaceId,customerId,issueDate,{orderId}={}){const terms=await require('../sales/postgres-payment-terms').forOrder(db,workspaceId,orderId,customerId);return require('./customer-money').addDays(issueDate,terms?.kind&&terms.kind!=='ON_ACCOUNT'?0:terms?.net_days??30);}
module.exports={dueDate};
