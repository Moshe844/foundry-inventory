'use strict';
// Retry only explicitly transient READ failures. Never a provider call,
// business mutation, approval, or an uncertain external effect.
const TRANSIENT=new Set(['40001','40P01','08006','08003','57P01','53300','ECONNRESET','ETIMEDOUT']);
async function freshRead(operation,onRetry=()=>{}){
 try{return await operation();}catch(error){
  if(!TRANSIENT.has(error.code)&&error.retryableRead!==true)throw error;
  await onRetry({code:error.code||'TRANSIENT_READ'});
  return operation();
 }
}
function query(database,sql,values,onRetry){
 // Only an individual SELECT on a pool is replayed; never a canonical tool
 // which could internally use a model, nor a statement in an aborted transaction.
 const read=()=>database.query(sql,values);
 return /^\s*SELECT\b/i.test(sql)?freshRead(read,onRetry):read();
}
module.exports={freshRead,query};
