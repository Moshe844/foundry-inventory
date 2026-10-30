'use strict';
const {ValidationError}=require('../domain/errors'),money=require('../domain/currency'),pricing=require('../pricing/postgres-service');
const array=v=>Array.isArray(v)?v:[v];
function input(body,{today,currency}){
 const ids=array(body.skuId),quantities=array(body.quantity),prices=array(body.unitPrice),weights=array(body.secondaryQuantity),overrides=array(body.priceOverride);
 if(ids.length>500)throw new ValidationError('An order supports at most 500 lines.');
 const lines=ids.map((skuId,index)=>{const label=`Line ${index+1}`,quantity=require('../domain/exact-quantity').safeNumber(quantities[index],{positive:true,label:label+' quantity'});
  if(!skuId)throw new ValidationError(label+': choose a product.');
  if(quantity<=0||quantity>1000000000)throw new ValidationError(label+': quantity must be above zero and at most 1,000,000,000.');
  const manual=overrides[index]===undefined?String(prices[index]??'').trim()!=='':overrides[index]==='1';
  let unitPriceMinor=null;try{if(manual)unitPriceMinor=pricing.toMinor(prices[index],label+' selling price',currency);}catch(e){throw new ValidationError(label+': '+e.message);}
  if(manual&&unitPriceMinor===null)throw new ValidationError(label+': enter a selling price.');
  return {skuId,quantity,...(weights[index]!=null&&String(weights[index]).trim()!==''?{secondaryQuantity:weights[index]}:{}),priceOverride:manual,unitPriceMinor};});
 return {customerId:body.customerId,customerEmail:body.customerEmail,customerPhone:body.customerPhone,orderNumber:body.orderNumber,
  orderDate:body.orderDate||today,neededBy:body.neededBy||null,fulfillmentLocationId:body.fulfillmentLocationId||null,
  deliveryMethod:body.deliveryMethod||'SHIP',shipToAddress:body.customerShippingAddress??body.shipToAddress??null,
  currency,notes:body.notes||null,reference:body.reference||null,allocationPriority:body.allocationPriority,
  discountMinor:pricing.toMinor(body.discount,'Discount',currency)||0,taxMinor:pricing.toMinor(body.tax,'Tax',currency)||0,
  taxRateId:body.taxRateId||null,codes:String(body.couponCodes||'').split(',').map(s=>s.trim()).filter(Boolean),priceListId:body.priceListId||null,lines};
}
function formFromOrder(order,lines,quote){return {customerId:order.customer_id,customerEmail:order.contact_email||'',customerPhone:order.contact_phone||'',
 customerShippingAddress:order.ship_to_address||'',deliveryMethod:order.delivery_method,fulfillmentLocationId:order.fulfillment_location_id||'',
 orderDate:order.order_date,neededBy:order.needed_by||'',notes:order.notes||'',reference:order.reference||'',
 skuId:lines.map(l=>l.sku_id),quantity:lines.map(l=>l.quantity_ordered),secondaryQuantity:lines.map(l=>l.secondary_quantity_ordered??''),unitPrice:lines.map(l=>money.fromMinor(l.unit_price_minor||0,order.currency)),
 priceOverride:lines.map(l=>l.pricing_snapshot?.priceOverride?'1':'0'),discount:money.fromMinor(quote?.manualDiscountMinor??0,order.currency),
 taxRateId:quote?.taxRate?.id||'',tax:quote?.taxRate?'':money.fromMinor(order.tax_minor||0,order.currency),couponCodes:(quote?.codes||[]).join(', '),priceListId:quote?.priceListId||''};}
module.exports={input,formFromOrder};
