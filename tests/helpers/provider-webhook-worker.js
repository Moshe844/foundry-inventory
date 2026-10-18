'use strict';
const assert=require('node:assert/strict'),queue=require('../../src/operations/postgres-job-queue');
async function drain(database,providers){
 const all=require('../../src/operations/postgres-runtime-handlers').create(providers),handlers={'provider.webhook-process':all['provider.webhook-process']};
 for(let i=0;i<100;i++){const job=await queue.processOne(database,handlers,{owner:'webhook-certification-worker'});if(!job)return;assert.equal(job.status,'COMPLETED',JSON.stringify(job.lastError));}
 throw new Error('The bounded webhook fixture queue did not drain.');
}
async function result(database,response,providers){
 const acknowledgement=await response.clone().json();assert(acknowledgement.receiptId,'The actual HTTP acknowledgement must identify its persisted receipt');
 await drain(database,providers);
 const row=(await database.query('SELECT status,result,error_code,error_message FROM connection_webhook_receipts WHERE id=$1',[acknowledgement.receiptId])).rows[0];assert(row);assert(row.result,JSON.stringify(row));
 return row.result;
}
module.exports={drain,result};
