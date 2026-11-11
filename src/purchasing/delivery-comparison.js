'use strict';

const {ValidationError}=require('../domain/errors');
const exact=require('../domain/exact-quantity');
const stock=require('../domain/stock-quantity');
const {matchLine}=require('./supplier-line-match');

function compare(lines,observations){
  if(!Array.isArray(observations)||!observations.length||observations.length>500)
    throw new ValidationError('Enter one to 500 actual delivery rows.');
  const totals=new Map();
  const unexpected=[];
  const original=[];
  for(const raw of observations){
    const code=String(raw.code||'').trim();
    if(!code||code.length>120||/[\u0000-\u001f\u007f]/.test(code))
      throw new ValidationError('Enter each actual product code from the goods or delivery note.');
    const basis=raw.basis||'stock';
    if(!['stock','purchase'].includes(basis))throw new ValidationError('Choose stock units or supplier packs for every delivery row.');
    const quantity=exact.canonical(raw.quantity,{scale:6});
    const line=matchLine(lines,{skuCode:code});
    const selected=raw.lineId?lines.find(candidate=>candidate.id===raw.lineId):line;
    const matching=selected&&matchLine([selected],{skuCode:code});
    const source={code,quantity,basis,secondaryQuantity:raw.secondaryQuantity==null||raw.secondaryQuantity===''?null:
      exact.canonical(raw.secondaryQuantity,{scale:6}),unit:String(raw.unit||'').trim().slice(0,40)};
    original.push(source);
    if(!matching){
      unexpected.push({...source,issue:'This product code does not identify one exact ordered line. Check the wrong item or choose its exact repeated order line.'});
      continue;
    }
    const amount=basis==='purchase'?exact.convert(quantity,{numerator:matching.units_per_purchase_unit,
      precision:Number(matching.quantity_precision)}):quantity;
    const units=stock.validate(matching,amount,{positive:false,label:'Actually delivered quantity'});
    let weight=null;
    if(matching.secondary_unit_label&&source.secondaryQuantity!==null)
      weight=stock.secondary(matching,source.secondaryQuantity,{positive:units>0});
    else if(!matching.secondary_unit_label&&source.secondaryQuantity!==null)
      throw new ValidationError(matching.code+' does not have a separate weight measure.');
    if(source.unit&&source.unit.toLowerCase()!==String(basis==='purchase'?matching.purchase_unit:matching.unit_label).toLowerCase())
      throw new ValidationError('The stated unit for '+code+' differs from the exact stock unit or saved supplier pack.');
    source.lineId=matching.id;
    const total=totals.get(matching.id)||{quantity:'0',weight:'0',missingWeight:false};
    total.quantity=exact.add(total.quantity,units);
    if(weight!==null)total.weight=exact.add(total.weight,weight);
    total.missingWeight=total.missingWeight||Boolean(matching.secondary_unit_label&&units>0&&weight===null);
    totals.set(matching.id,total);
  }
  const rows=lines.map(line=>{
    const actual=totals.get(line.id)||{quantity:'0',weight:'0',missingWeight:false};
    const remaining=exact.subtract(line.quantity_units,line.quantity_received_units);
    const expected=Number(remaining)>0?remaining:'0';
    const difference=exact.safeNumber(exact.subtract(expected,actual.quantity),{signed:true});
    const remainingWeight=line.secondary_quantity_ordered==null?null:exact.subtract(line.secondary_quantity_ordered,line.secondary_quantity_received||0);
    const expectedWeight=remainingWeight===null?null:Number(remainingWeight)>0?remainingWeight:'0';
    const weight=expectedWeight===null||actual.missingWeight?null:actual.weight;
    const weightDifference=weight===null?null:exact.safeNumber(exact.subtract(expectedWeight,weight),{signed:true});
    const findings=[];
    if(difference>0)findings.push('Short by '+difference+' '+line.unit_label);
    if(difference<0)findings.push('Extra '+(-difference)+' '+line.unit_label);
    if(actual.missingWeight)findings.push('Actual '+line.secondary_unit_label+' is missing');
    if(weightDifference!==null&&weightDifference>0)findings.push(weightDifference+' '+line.secondary_unit_label+' still due');
    if(weightDifference!==null&&weightDifference<0)findings.push('Extra '+(-weightDifference)+' '+line.secondary_unit_label);
    return {lineId:line.id,code:line.code,name:line.name,trackingMode:line.tracking_mode,unit:line.unit_label,
      pack:line.purchase_unit,unitsPerPack:line.units_per_purchase_unit,weightUnit:line.secondary_unit_label,
      expected,observed:actual.quantity,short:Math.max(0,difference),extra:Math.max(0,-difference),expectedWeight,observedWeight:weight,
      findings,agrees:findings.length===0};
  });
  return {version:1,original,rows,unexpected,agrees:unexpected.length===0&&rows.every(row=>row.agrees)};
}

function hasShortage(row){
  return row.short>0||row.expectedWeight!=null&&row.observedWeight!=null&&
    Number(exact.subtract(row.expectedWeight,row.observedWeight))>0;
}

module.exports={compare,hasShortage};
