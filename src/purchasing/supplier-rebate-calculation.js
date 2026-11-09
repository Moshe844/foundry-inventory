'use strict';
const {ValidationError}=require('../domain/errors');
const scale=1000000n,maxMoney=9223372036854775807n;
function whole(value,label,max=maxMoney){const text=String(value??'');if(typeof value==='number'&&!Number.isSafeInteger(value)||!/^(?:0|[1-9]\d*)$/.test(text)||BigInt(text)>max)throw new ValidationError(label+' must be an exact non-negative whole amount.');return BigInt(text);}
function quantity(value){const text=String(value??'');if(typeof value==='number'&&!Number.isSafeInteger(value*1000000)||!/^\d{1,12}(?:\.\d{1,6})?$/.test(text))throw new ValidationError('Use an exact stock quantity with no more than six decimal places.');const [a,b='']=text.split('.');return BigInt(a)*scale+BigInt(b.padEnd(6,'0'));}
function showQuantity(value){const a=value/scale,b=(value%scale).toString().padStart(6,'0').replace(/0+$/,'');return a.toString()+(b?'.'+b:'');}
function round(numerator,denominator,mode){return mode==='half_up'?(numerator+denominator/2n)/denominator:numerator/denominator;}
function normalize(input){
 const {basis,benefit,method,rounding}=input||{};
 if(!['net_spend','stock_units'].includes(basis)||!['percentage','unit_price'].includes(benefit)||!['retroactive','incremental'].includes(method)||!['half_up','floor'].includes(rounding))throw new ValidationError('Confirm the agreed eligibility basis, benefit, tier method and rounding rule explicitly.');
 if(benefit==='unit_price'&&(basis!=='stock_units'||method!=='retroactive')||basis==='stock_units'&&method==='incremental')throw new ValidationError('Review progressive quantity terms and price discounts without an exact stock-unit basis individually.');
 if(!Array.isArray(input.tiers)||!input.tiers.length||input.tiers.length>20)throw new ValidationError('Record one to twenty exact agreed rebate tiers.');
 const pricePerUnits=benefit==='unit_price'?quantity(input.pricePerUnits):null;if(pricePerUnits===0n)throw new ValidationError('Confirm a positive stock quantity for the agreed price unit.');
 let previous=-1n,previousValue=null;
 const tiers=input.tiers.map(tier=>{
  const threshold=basis==='net_spend'?whole(tier.threshold,'Spend threshold'):quantity(tier.threshold),value=benefit==='percentage'?whole(tier.rateBasisPoints,'Percentage in basis points',10000n):whole(tier.unitPriceMinor,'Agreed unit price');
  if(threshold<=previous)throw new ValidationError('Record tiers in increasing order with no duplicate threshold.');
  if(previousValue!==null&&(benefit==='percentage'?value<previousValue:value>previousValue))throw new ValidationError('Higher-volume tiers must not reduce the agreed discount.');
  previous=threshold;previousValue=value;
  return {threshold:basis==='net_spend'?threshold.toString():showQuantity(threshold),...(benefit==='percentage'?{rateBasisPoints:Number(value)}:{unitPriceMinor:value.toString()})};
 });
 return {basis,benefit,method,rounding,tiers,...(pricePerUnits===null?{}:{pricePerUnits:showQuantity(pricePerUnits)})};
}
function calculate(input,totals){
 const contract=normalize(input),net=whole(totals?.netMinor,'Eligible net purchases'),units=quantity(totals?.quantity??'0'),measure=contract.basis==='net_spend'?net:units;
 const thresholds=contract.tiers.map(tier=>contract.basis==='net_spend'?BigInt(tier.threshold):quantity(tier.threshold));
 let selected=-1;for(let n=0;n<thresholds.length;n++)if(measure>=thresholds[n])selected=n;
 let amount=0n;
 if(selected>=0){
  const tier=contract.tiers[selected];
  if(contract.benefit==='unit_price'){
   const expected=round(units*BigInt(tier.unitPriceMinor),quantity(contract.pricePerUnits),contract.rounding);amount=net>expected?net-expected:0n;
  }else if(contract.method==='retroactive')amount=round(net*BigInt(tier.rateBasisPoints),10000n,contract.rounding);
  else{
   let numerator=0n;
   for(let n=0;n<=selected;n++){const upper=n+1<thresholds.length&&thresholds[n+1]<measure?thresholds[n+1]:measure;if(upper>thresholds[n])numerator+=(upper-thresholds[n])*BigInt(contract.tiers[n].rateBasisPoints);}
   amount=round(numerator,10000n,contract.rounding);
  }
 }
 const next=selected+1<contract.tiers.length?selected+1:null,remaining=next===null?null:thresholds[next]-measure,format=value=>contract.basis==='net_spend'?value.toString():showQuantity(value);
 return {eligibleMeasure:format(measure),eligibleNetMinor:net.toString(),eligibleQuantity:showQuantity(units),tierIndex:selected<0?null:selected,tier:selected<0?null:contract.tiers[selected],potentialBenefitMinor:amount.toString(),nextThreshold:next===null?null:format(thresholds[next]),remainingToNext:remaining===null?null:format(remaining),contract};
}
module.exports={normalize,calculate};
