'use strict';

const {ValidationError}=require('../domain/errors');
const SOURCE='BIGCOMMERCE_OWNER_TEST_STORE_V1';
const identity=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
function appId(){return String(process.env.BIGCOMMERCE_CLIENT_ID||'');}
function pilots(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||!appId()||!process.env.BIGCOMMERCE_CLIENT_SECRET)return {};
 try{
  const input=JSON.parse(process.env.STOCKCHIEF_PRODUCTION_BIGCOMMERCE_PILOTS||'null'),result=Object.create(null),seen=new Set();
  if(!input||input.appId!==appId()||!input.stores||typeof input.stores!=='object'||Array.isArray(input.stores))return {};
  for(const [workspace,stores] of Object.entries(input.stores)){
   if(!identity(workspace)||!Array.isArray(stores)||!stores.length)return {};
   for(const store of stores){if(typeof store!=='string'||!/^[a-z0-9]{1,64}$/.test(store)||seen.has(store))return {};seen.add(store);}
   result[workspace]=[...stores];
  }
  return result;
 }catch{return {};}
}
function allowed(workspaceId){return Object.hasOwn(pilots(),workspaceId||'');}
function expected(workspaceId,input={}){
 const store=typeof input.storeUrl==='string'?require('./providers/bigcommerce').normalizeStore(input.storeUrl):input.storeHash;
 if(!pilots()[workspaceId]?.includes(store))throw new ValidationError('This BigCommerce test is approved only for the store assigned to this inventory.');
 return store;
}
function evidence(result,workspaceId,ownerId){
 if(!identity(ownerId)||result.credentials?.storeHash!==result.accountId||result.credentials?.bigcommerceClientId!==appId())
  throw new ValidationError('BigCommerce did not confirm the registered application and approved test store.');
 return {source:SOURCE,appId:appId(),workspaceId,storeHash:expected(workspaceId,{storeHash:result.accountId}),approvedByUserId:ownerId,qualificationOnly:true};
}
module.exports={SOURCE,appId,pilots,allowed,expected,evidence};
