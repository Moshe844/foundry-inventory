'use strict';
const {AsyncLocalStorage}=require('node:async_hooks'),{createHash}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const held=new AsyncLocalStorage();
function key(clientId){
 if(typeof clientId!=='string'||!clientId||clientId.length>256)
  throw new ValidationError('Xero authorization does not identify its application.');
 return 'xero-grant:'+createHash('sha256').update(clientId).digest('hex');
}
// A Xero user grant can cover several organizations, and the consent callback
// does not identify its tenant until after token exchange. Serialize application
// grant changes, including consent, before consuming OAuth state or rotating a
// refresh token. Ordinary accounting reads do not retain this session lock.
async function run(database,clientId,operation){
 const lock=key(clientId),current=held.getStore();
 if(current?.active&&current.key===lock)return operation(current.database);
 if(typeof database.withSessionLock!=='function')throw Object.assign(new ValidationError('Xero authorization is temporarily unavailable. Your saved connection is preserved.'),
  {code:'XERO_SESSION_LOCK_UNAVAILABLE',transient:true,retryable:true});
 const result=await database.withSessionLock(lock,async session=>{
  const lease={key:lock,database:session,active:true};
  try{return await held.run(lease,()=>operation(session));}finally{lease.active=false;}
 });
 if(result?.busy===true)throw Object.assign(new ValidationError('Another Xero authorization update is finishing. Please try again shortly. Your saved connection is preserved.'),
  {code:'XERO_AUTHORIZATION_BUSY',transient:true,retryable:true});
 return result;
}
module.exports={key,run};
