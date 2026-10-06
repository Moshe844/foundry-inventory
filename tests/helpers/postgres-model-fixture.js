'use strict';
// Expand legacy test shorthand into the actual production request schema. This
// helper is test-only; production model output must pass validation unchanged.
function part(value,message){return {requestText:message,continuesPrevious:false,clarifyingQuestion:'',intent:'clarify',view:null,action:null,search:null,sku:null,skuReference:'',
 location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,
 reference:null,recipient:'',recipientKind:'',subject:'',body:'',mailbox:'',customer:'',supplier:'',deliveryMethod:'',
 shipToAddress:'',neededBy:'',purchaseOrder:'',supplierBill:'',receiptReference:'',paymentMethod:'',paymentDate:'',...value};}
const PRICED_MODEL='claude-haiku-4-5-20251001';
function pricedUsage(usage={}){return {...usage,provider:'anthropic',model:PRICED_MODEL,
 providerVersion:'2023-06-01',inputTokens:usage.inputTokens??20,outputTokens:usage.outputTokens??10};}
function fixture(provider){return {...provider,name:'anthropic',model:PRICED_MODEL,async complete(request){
 let result;try{result=await provider.complete(request);}catch(error){
  error.usage=pricedUsage(error.usage||{});throw error;}
 if(request.schemaName==='stockchief_postgres_request'){
  const message=JSON.parse(request.prompt).message;
  result.data={parts:(result.data.parts||[result.data]).map(value=>part(value,message))};}
 return {...result,usage:pricedUsage(result.usage||{})};}};}
module.exports={fixture,part,pricedUsage,PRICED_MODEL};
