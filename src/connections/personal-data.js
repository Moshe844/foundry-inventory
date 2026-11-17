'use strict';
// Used only for expired working copies, never for stock, prices or ledger facts.
const privateKeys=new Set(['email','customeremail','customername','customercompany','phone','phonenumber','shippingaddress','billingaddress','shiptoaddress','address','address1','address2','firstname','lastname','contactname','recipientname','notes']);
function workingCopy(value,parent=''){
 if(Array.isArray(value))return value.map(entry=>workingCopy(entry,parent));
 if(!value||typeof value!=='object')return value;
 const result={};for(const [key,entry] of Object.entries(value)){
  const normalized=key.replaceAll('_','').toLowerCase();
  if(privateKeys.has(normalized)||(['customer','recipient','shipping','billing'].includes(parent)&&['name','company','city','region','country','postalcode','zip'].includes(normalized)))continue;
  result[key]=workingCopy(entry,key.toLowerCase());
 }return result;
}
module.exports={workingCopy};
