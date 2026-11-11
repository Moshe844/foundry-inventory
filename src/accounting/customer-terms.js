'use strict';
async function dueDate(db,workspaceId,customerId,issueDate){
  const terms=require('../sales/customer-commercial-terms');
  return terms.dueFrom(await terms.current(db,workspaceId,customerId),issueDate);
}
module.exports={dueDate};
