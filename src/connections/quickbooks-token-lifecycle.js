'use strict';
const {AsyncLocalStorage}=require('node:async_hooks'),{createHash}=require('node:crypto');
const {ValidationError}=require('../domain/errors');
const held=new AsyncLocalStorage();
function key(clientId,realmId){
 if(typeof clientId!=='string'||!clientId||clientId.length>256||typeof realmId!=='string'||!realmId||realmId.length>256)
  throw new ValidationError('QuickBooks authorization does not identify its application and company.');
 return 'quickbooks-grant:'+createHash('sha256').update(JSON.stringify([clientId,realmId])).digest('hex');
}
// Consent, refresh and revocation affect the same Intuit application/company
// grant. Hold one session lock across provider traffic and local commits.
async function run(database,clientId,realmId,operation){
 const lock=key(clientId,realmId),current=held.getStore();
 if(current?.active&&current.key===lock)return operation(current.database);
 if(typeof database.withSessionLock!=='function')throw Object.assign(new ValidationError('QuickBooks authorization is temporarily unavailable. Your saved connection is preserved.'),
  {code:'QUICKBOOKS_SESSION_LOCK_UNAVAILABLE',transient:true,retryable:true});
 const result=await database.withSessionLock(lock,async session=>{
  const lease={key:lock,database:session,active:true};
  try{return await held.run(lease,()=>operation(session));}finally{lease.active=false;}
 });
 if(result?.busy===true)throw Object.assign(new ValidationError('Another QuickBooks authorization update is finishing. Please try again shortly. Your saved connection is preserved.'),
  {code:'QUICKBOOKS_AUTHORIZATION_BUSY',transient:true,retryable:true});
 return result;
}
module.exports={key,run};
