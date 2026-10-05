'use strict';
// Expand legacy test shorthand into the actual production request schema. This
// helper is test-only; production model output must pass validation unchanged.
function part(value,message){return {requestText:message,intent:'clarify',view:null,action:null,search:null,sku:null,
 location:null,fromLocation:null,toLocation:null,quantity:null,countedQuantity:null,amount:null,currency:null,reason:null,
 reference:null,recipient:'',recipientKind:'',subject:'',body:'',mailbox:'',customer:'',supplier:'',deliveryMethod:'',
 shipToAddress:'',neededBy:'',purchaseOrder:'',supplierBill:'',receiptReference:'',paymentMethod:'',paymentDate:'',...value};}
function fixture(provider){return {...provider,async complete(request){const result=await provider.complete(request);
 if(request.schemaName==='stockchief_postgres_request'){
  const message=JSON.parse(request.prompt).message;
  result.data={parts:(result.data.parts||[result.data]).map(value=>part(value,message))};}
 return result;}};}
module.exports={fixture,part};
