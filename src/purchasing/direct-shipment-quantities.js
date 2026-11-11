'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const {pack}=require('./agent-reorder-workflows');

function profileSnapshot(profile){
  return {...stock.profile({},profile),trackingMode:profile.tracking_mode};
}

function remaining(line){
  const quantity=exact.subtract(exact.subtract(line.quantity_ordered,line.quantity_fulfilled||0),line.direct_committed_quantity||0);
  const secondary=line.secondary_quantity_ordered==null?null:exact.subtract(
    exact.subtract(line.secondary_quantity_ordered,line.secondary_quantity_fulfilled||0),line.direct_committed_secondary_quantity||0);
  if(exact.safeNumber(quantity,{signed:true})<0||secondary!==null&&exact.safeNumber(secondary,{signed:true})<0)
    throw new ValidationError('Review the order’s fulfilled and supplier-promised quantities before buying more.');
  return {quantity,secondary};
}

function claim(line,profile,offer,input){
  const open=remaining(line);
  const quantity=stock.validate(profile,input.quantity,{label:'Supplier-direct quantity'});
  if(quantity>Number(open.quantity))throw new ValidationError('The direct purchase exceeds the customer quantity still unpromised.');
  const secondary=stock.secondary(profile,input.secondaryQuantity??(quantity===Number(open.quantity)?open.secondary:null));
  if(secondary!==null&&(secondary>Number(open.secondary)||(quantity===Number(open.quantity))!==(secondary===Number(open.secondary))))
    throw new ValidationError('The direct purchase pieces and weight must match the customer’s remaining agreed measures.');
  const purchase=pack(offer,String(quantity),profile);
  if(exact.canonical(purchase.quantity)!==exact.canonical(quantity))
    throw new ValidationError('The supplier’s packs, minimum or multiple exceed this exact customer quantity. Agree the customer quantity or supplier pack before preparing this direct purchase.');
  return {quantity,secondaryQuantity:secondary,purchaseUnits:purchase.purchaseUnits,
    unitCostMinor:purchase.unitCostMinor,totalMinor:secondary===null?purchase.totalMinor:exact.costMinor(secondary,purchase.unitCostMinor)};
}

function identifiers(raw,label,maximum=240){
  const value=String(raw||'').trim();
  if(!value||value.length>maximum||/[\u0000-\u001f\u007f]/.test(value))
    throw new ValidationError('Enter the exact '+label+' from the supplier’s shipping record.');
  return value;
}

function expiry(raw,shippedDay){
  if(raw==null||String(raw).trim()==='')return null;
  const value=String(raw).trim(),parsed=new Date(value+'T00:00:00Z');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value||value<shippedDay)
    throw new ValidationError('Confirm a valid, unexpired supplier batch date.');
  return value;
}

function serials(profile,input,quantity,secondaryQuantity,shippedDay){
  if(!Array.isArray(input.serials)||input.serials.length!==quantity||input.serials.length>500)
    throw new ValidationError('Provide one actual supplier serial number for every shipped piece.');
  const units=input.serials.map(unit=>{
    const value=typeof unit==='string'?{serial:unit}:unit;
    if(!value||typeof value!=='object')throw new ValidationError('Confirm every actual supplier serial number.');
    return {serial:identifiers(value.serial,'supplier serial number'),
      lotCode:value.lotCode?identifiers(value.lotCode,'supplier batch code'):null,expiresAt:expiry(value.expiresAt,shippedDay),
      weight:stock.secondary(profile,value.weight,{label:'Actual weight for '+value.serial})};
  });
  if(new Set(units.map(unit=>unit.serial.toLowerCase())).size!==units.length)
    throw new ValidationError('Each shipped serial number must appear once.');
  if(secondaryQuantity!==null&&exact.canonical(units.reduce((total,unit)=>exact.add(total,unit.weight),'0'))!==exact.canonical(secondaryQuantity))
    throw new ValidationError('The actual weights of the individual serials must add up to the shipment weight.');
  return units;
}

function lots(profile,input,quantity,secondaryQuantity,shippedDay){
  if(!Array.isArray(input.lots)||!input.lots.length||input.lots.length>100)
    throw new ValidationError('Provide the actual supplier batches and their shipped quantities.');
  const batches=input.lots.map(batch=>({lotCode:identifiers(batch.lotCode,'supplier batch code'),
    quantity:stock.validate(profile,batch.quantity,{label:'Shipped batch quantity'}),
    secondaryQuantity:stock.secondary(profile,batch.secondaryQuantity),expiresAt:expiry(batch.expiresAt,shippedDay)}));
  if(new Set(batches.map(batch=>batch.lotCode.toLowerCase())).size!==batches.length)
    throw new ValidationError('Combine each supplier batch into one shipment line.');
  if(exact.canonical(batches.reduce((total,batch)=>exact.add(total,batch.quantity),'0'))!==exact.canonical(quantity)||
    secondaryQuantity!==null&&exact.canonical(batches.reduce((total,batch)=>exact.add(total,batch.secondaryQuantity),'0'))!==exact.canonical(secondaryQuantity))
    throw new ValidationError('The supplier batches must add up to the exact shipment quantity and weight.');
  return batches;
}

function dispatch(profile,input,open,shippedDay){
  const quantity=stock.validate(profile,input.quantity,{label:'Actually shipped quantity'});
  const secondaryQuantity=stock.secondary(profile,input.secondaryQuantity);
  if(quantity>Number(open.quantity)||secondaryQuantity!==null&&(secondaryQuantity>Number(open.secondary)||
    (quantity===Number(open.quantity))!==(secondaryQuantity===Number(open.secondary))))
    throw new ValidationError('The supplier shipment exceeds the exact remaining purchase measures or leaves unmatched pieces and weight.');
  const serialUnits=profile.tracking_mode==='serial'?serials(profile,input,quantity,secondaryQuantity,shippedDay):[];
  const batches=profile.tracking_mode==='lot'?lots(profile,input,quantity,secondaryQuantity,shippedDay):[];
  if(profile.tracking_mode!=='serial'&&input.serials?.length||profile.tracking_mode!=='lot'&&input.lots?.length)
    throw new ValidationError('The supplier’s tracking details do not match this product’s tracking method.');
  return {quantity,secondaryQuantity,serials:serialUnits,lots:batches};
}

module.exports={remaining,claim,dispatch,identifiers,expiry,profileSnapshot};
