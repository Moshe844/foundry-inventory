'use strict';
const {AsyncLocalStorage}=require('node:async_hooks');
const {ValidationError}=require('../domain/errors');
const held=new AsyncLocalStorage();
function key(clientId,shop){
 if(typeof clientId!=='string'||!clientId||!/^[-a-z0-9]+\.myshopify\.com$/.test(shop||''))throw new ValidationError('The Shopify authorization does not identify its application and store.');
 return 'shopify-public-install:'+clientId+':'+shop;
}
// Shopify keeps one current expiring token per application/store. Consent,
// refresh and owner linking must share the same session lock across commits.
// Nested credential reads reuse that session rather than deadlocking on it.
async function run(database,clientId,shop,operation){
 const lock=key(clientId,shop),current=held.getStore();
 if(current?.active&&current.key===lock)return operation(current.database);
 if(typeof database.withSessionLock!=='function')throw Object.assign(new ValidationError('Shopify authorization is temporarily unavailable. Your working connection is preserved.'),{code:'SHOPIFY_SESSION_LOCK_UNAVAILABLE',transient:true,retryable:true});
 const result=await database.withSessionLock(lock,async session=>{
   const lease={key:lock,database:session,active:true};
   try{return await held.run(lease,()=>operation(session));}finally{lease.active=false;}
 });
 if(result?.busy===true)throw Object.assign(new ValidationError('Shopify authorization is finishing for this store. Please try again in a moment. Your working connection is unchanged.'),{code:'SHOPIFY_AUTHORIZATION_BUSY',transient:true,retryable:true});
 return result;
}
module.exports={key,run};
