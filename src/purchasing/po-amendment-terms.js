'use strict';

const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const money=require('../domain/currency');
const {ValidationError}=require('../domain/errors');

function stockUnits(line,value,label){
  return exact.canonical(stock.validate(line,value,{label,positive:false,total:true}));
}

function weight(line,value,label){
  const amount=stock.secondary(line,value,{label,positive:false,total:true});
  return amount===null?null:exact.canonical(amount);
}

function value(quantity,measured,unitCostMinor){
  return unitCostMinor===null?null:exact.costMinor(measured??quantity,unitCostMinor);
}

function purchaseQuantity(line,quantity){
  return exact.convert(quantity,{denominator:line.units_per_purchase_unit,precision:6});
}

function terms(line,quantity,secondary,price,packs=purchaseQuantity(line,quantity)){
  return {quantity,secondary,price,packs,totalMinor:value(quantity,secondary,price)};
}

function project(line,input,currency){
  const original=stockUnits(line,line.quantity_units,'Ordered stock quantity');
  const received=stockUnits(line,line.quantity_received_units,'Received stock quantity');
  const open=exact.subtract(original,received);
  if(exact.atoms(open,6,{signed:true})<=0)
    throw new ValidationError('This purchase line has no unreceived quantity to amend.');

  const measured=Boolean(line.secondary_unit_label);
  const originalWeight=measured?weight(line,line.secondary_quantity_ordered,'Ordered weight'):null;
  const receivedWeight=measured?weight(line,line.secondary_quantity_received,'Received weight'):null;
  const openWeight=measured?exact.subtract(originalWeight,receivedWeight):null;
  if(measured&&exact.atoms(openWeight,6,{signed:true})<=0)
    throw new ValidationError('The remaining pieces have no reliable ordered weight. Review the original order and receipts.');
  const beforePrice=money.toMinor(line.unit_cost,currency,{optional:true,label:'Current purchase price'});
  const nextPrice=input.price==null?beforePrice:money.toMinor(input.price,currency,{label:'Proposed purchase price'});
  const nextOpen=input.quantity==null?open:stockUnits(line,input.quantity,'Proposed remaining stock quantity');
  const nextOpenWeight=input.secondary==null?openWeight:weight(line,input.secondary,'Proposed remaining weight');
  const quantityChanged=nextOpen!==open;
  const weightChanged=nextOpenWeight!==openWeight;
  const priceChanged=nextPrice!==beforePrice;
  if(measured&&quantityChanged&&input.secondary==null)
    throw new ValidationError('Enter the revised remaining weight as well as the piece count.');
  if(measured&&(nextOpen==='0')!==(nextOpenWeight==='0'))
    throw new ValidationError('The revised remaining pieces and weight must both be positive or both be zero.');
  if(!measured&&input.secondary!=null)
    throw new ValidationError('This product has no separate weight for the purchase line.');
  const before=terms(line,original,originalWeight,beforePrice,exact.canonical(line.quantity_purchase_units));
  const originalRemaining={quantity:open,secondary:openWeight,price:beforePrice,totalMinor:value(open,openWeight,beforePrice)};
  const remaining={quantity:nextOpen,secondary:nextOpenWeight,price:nextPrice,totalMinor:value(nextOpen,nextOpenWeight,nextPrice)};
  if(!quantityChanged&&!weightChanged&&!priceChanged)return {before,originalRemaining,remaining,retained:before,replacement:null,closed:false,changed:false};

  // A revised price only applies to future arrivals. Keep the original line ID
  // and its old price on the quantities already received and used by bills.
  const split=priceChanged&&received!=='0'&&nextOpen!=='0';
  const closes=nextOpen==='0';
  const combined=exact.add(received,nextOpen);
  const combinedWeight=measured?exact.add(receivedWeight,nextOpenWeight):null;
  const retained=split||closes
    ?terms(line,received,receivedWeight,beforePrice)
    :terms(line,combined,combinedWeight,nextPrice,quantityChanged?undefined:before.packs);
  const replacement=split?terms(line,nextOpen,nextOpenWeight,nextPrice):null;
  return {before,originalRemaining,remaining,retained,replacement,closed:split||closes,changed:true};
}

module.exports={project};
