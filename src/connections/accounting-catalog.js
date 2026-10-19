'use strict';
const money=require('../domain/currency'),{ValidationError}=require('../domain/errors');
function product({id,code,name,currency,price,tracked,quantity,locationId}){
 if(!id)throw new ValidationError('The accounting provider returned a product without a stable identity.');
 const numeric=quantity===null||quantity===undefined?null:Number(quantity);
 const valid=tracked&&numeric!==null&&Number.isSafeInteger(numeric)&&numeric>=0;
 return {entityType:'sku',externalId:String(id),code:code||null,displayName:name||code||String(id),providerData:{
  itemName:name||code||String(id),variationName:null,
  priceMoney:price===null||price===undefined||price===''?null:{amount:money.toMinor(String(price),currency),currency:money.code(currency)},
  inventoryCounts:valid?[{externalLocationId:locationId,state:'IN_STOCK',quantity:numeric}]:[],
  inventoryCountUnavailable:tracked&&!valid?'The provider quantity is missing, negative or fractional; opening stock requires review.':null,
  stockGranularity:'organization',trackedInventory:Boolean(tracked),
 }};
}
function location(id,name){return {entityType:'location',externalId:id,displayName:name+' inventory',providerData:{kind:'other',stockGranularity:'organization',aggregated:true}};}
module.exports={product,location};
