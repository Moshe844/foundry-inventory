'use strict';
const currency=require('../domain/currency');
const {ValidationError}=require('../domain/errors');
function amount(value,code){return currency.toMinor(value,code,{label:'Carrier charge'});}
function total(parts){
 if(!Array.isArray(parts)||!parts.length)throw new ValidationError('The carrier did not return a charge or currency.');
 const code=currency.code(parts[0]?.currency);
 if(parts.some(part=>currency.code(part.currency)!==code))throw new ValidationError('The carrier returned charges in different currencies.');
 return {amountMinor:currency.sum(parts.map(part=>amount(part.amount,code)),'Carrier total'),currency:code};
}
function receipt(reference,read){
 try{return read();}catch(error){error.providerOutcomeUncertain=true;error.providerReference=reference;throw error;}
}
function approved(actual,input){if(input.currency&&actual.currency!==input.currency||input.approvedAmountMinor!=null&&actual.amountMinor>Number(input.approvedAmountMinor))throw new ValidationError('The carrier price increased or changed currency. Request fresh rates before purchasing.');return actual;}
module.exports={amount,total,receipt,approved};
