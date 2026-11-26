'use strict';

const {ValidationError}=require('../domain/errors');
const pilot=require('./bigcommerce-review-pilot');
const SOURCE='BIGCOMMERCE_CUSTOMER_COHORT_V1';
// This is a bounded admission list, not a public-launch switch. Credentials
// alone never enable it. Distribution and commercial review must be recorded
// against the exact app before an operator adds any customer inventory/store.
function cohort(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||!pilot.appId()||!process.env.BIGCOMMERCE_CLIENT_SECRET)return null;
 try{
  const value=JSON.parse(process.env.STOCKCHIEF_BIGCOMMERCE_CUSTOMER_COHORT||'null');
  if(!value||value.appId!==pilot.appId()||value.distributionApproved!==true||value.commercialApproved!==true||
   typeof value.approvalReference!=='string'||!value.approvalReference.trim()||value.approvalReference.length>500||
   !value.stores||typeof value.stores!=='object'||Array.isArray(value.stores))return null;
  const stores=Object.create(null),seen=new Set();
  for(const [workspace,hashes] of Object.entries(value.stores)){
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(workspace)||!Array.isArray(hashes)||!hashes.length)return null;
   for(const hash of hashes){if(typeof hash!=='string'||!/^[a-z0-9]{1,64}$/.test(hash)||seen.has(hash))return null;seen.add(hash);}
   stores[workspace]=[...hashes];
  }
  if(!seen.size||seen.size>10)return null;
  return {appId:value.appId,approvalReference:value.approvalReference.trim(),stores};
 }catch{return null;}
}
function allowed(workspaceId){return Object.hasOwn(cohort()?.stores||{},workspaceId||'');}
function expected(workspaceId,input={}){
 const store=typeof input.storeUrl==='string'?require('./providers/bigcommerce').normalizeStore(input.storeUrl):input.storeHash;
 if(!cohort()?.stores[workspaceId]?.includes(store))throw new ValidationError('This BigCommerce store is not included in the approved customer rollout for this inventory.');
 return store;
}
function evidence(result,workspaceId,ownerId){
 const approved=cohort();
 if(!approved||typeof ownerId!=='string'||!ownerId||result.credentials?.storeHash!==result.accountId||result.credentials?.bigcommerceClientId!==approved.appId)
  throw new ValidationError('BigCommerce did not confirm the approved customer application and store.');
 return {source:SOURCE,appId:approved.appId,workspaceId,storeHash:expected(workspaceId,{storeHash:result.accountId}),
  approvedByUserId:ownerId,approvalReference:approved.approvalReference,qualificationOnly:false};
}
module.exports={SOURCE,cohort,allowed,expected,evidence};
