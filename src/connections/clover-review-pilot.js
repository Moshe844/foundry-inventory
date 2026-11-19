'use strict';

// This is a private, non-billable merchant qualification permit, not approval
// to distribute Clover publicly or to change a StockChief subscription.
const SOURCE='CLOVER_NONBILLABLE_TEST_MERCHANT_V1';
const OWNER_SOURCE='CLOVER_OWNER_APPROVED_TEST_MERCHANT_V1';
const merchantId=value=>typeof value==='string'&&/^[A-Z0-9]{13}$/.test(value);
function pilots(){
 if(process.env.STOCKCHIEF_RUNTIME_ENV!=='production'||process.env.CLOVER_ENVIRONMENT!=='production'||!merchantId(process.env.CLOVER_CLIENT_ID))return {};
 try{
  const input=JSON.parse(process.env.STOCKCHIEF_PRODUCTION_CLOVER_PILOTS||'{}'),result=Object.create(null),seen=new Set();
  if(!input||typeof input!=='object'||Array.isArray(input))return {};
  for(const [workspace,ids] of Object.entries(input)){
   if(!/^[A-Za-z0-9_-]{1,200}$/.test(workspace)||!Array.isArray(ids)||!ids.length||ids.some(id=>!merchantId(id)||seen.has(id)))return {};
   result[workspace]=[...new Set(ids)];for(const id of ids)seen.add(id);
  }
  return result;
 }catch{return {};}
}
function allowed(workspaceId){return Object.hasOwn(pilots(),workspaceId||'');}
function expected(workspaceId,input={}){
 const ids=pilots()[workspaceId]||[];
 const supplied=input.expectedMerchantId||input.merchantId;
 const selected=supplied||(ids.length===1?ids[0]:null);
 if(!merchantId(selected)||!ids.includes(selected))throw new (require('../domain/errors').ValidationError)(
  'This Clover test is approved only for the test merchant assigned to this inventory.');
 return selected;
}
function ownerPermit(workspaceId,ownerId,input={}){
 if(typeof ownerId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(ownerId))throw new (require('../domain/errors').ValidationError)('A current owner must approve this Clover test.');
 return {source:OWNER_SOURCE,workspaceId,ownerId,appId:process.env.CLOVER_CLIENT_ID,merchantId:expected(workspaceId,input)};
}
function ownerPermitMatches(permit,workspaceId,merchant,ownerId){
 if(!permit||permit.source!==OWNER_SOURCE||permit.workspaceId!==workspaceId||permit.ownerId!==ownerId||
   permit.appId!==process.env.CLOVER_CLIENT_ID||permit.merchantId!==merchant)return false;
 try{return expected(workspaceId,{merchantId:merchant})===merchant;}catch{return false;}
}
function evidence(result,workspaceId,ownerId){
 const base={appId:process.env.CLOVER_CLIENT_ID,merchantId:result.accountId,verifiedAt:new Date().toISOString()};
 if(result.credentials?.isBillable===false)return {source:SOURCE,...base,isBillable:false};
 if(result.credentials?.isBillable==null&&result.credentials?.billingEvidence?.isBillable===null&&
   result.credentials?.providerBillingFieldsOmitted===true&&ownerPermitMatches(result.credentials.testMerchantPermit,workspaceId,result.accountId,ownerId))
  return {source:OWNER_SOURCE,...base,workspaceId,approvedByUserId:ownerId,ownerApprovedTestMerchant:true,providerBillingFlagsMissing:true};
 throw new (require('../domain/errors').ValidationError)('This Clover test merchant has not been approved for this inventory.');
}
module.exports={SOURCE,OWNER_SOURCE,merchantId,pilots,allowed,expected,ownerPermit,ownerPermitMatches,evidence};
