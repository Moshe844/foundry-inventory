'use strict';

// This is a private, non-billable merchant qualification permit, not approval
// to distribute Clover publicly or to change a StockChief subscription.
const SOURCE='CLOVER_NONBILLABLE_TEST_MERCHANT_V1';
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
function evidence(result){return {source:SOURCE,appId:process.env.CLOVER_CLIENT_ID,merchantId:result.accountId,isBillable:false,verifiedAt:new Date().toISOString()};}
module.exports={SOURCE,merchantId,pilots,allowed,expected,evidence};
