'use strict';
const {ValidationError}=require('../domain/errors');
// Quote each physical package, then offer only services available for all of them.
// This also supports carriers that cannot issue a native multi-piece label.
function combine(groups){
 if(!groups.length)return {providerShipmentIds:[],rates:[]};
 const key=r=>JSON.stringify([r.carrier,r.service,r.currency,r.carrierAccount||null]);
 let rates=new Map((groups[0].rates||[]).map(r=>[key(r),{...r,rateIds:r.rateIds||[r.rateId]}]));
 for(const group of groups.slice(1)){
  const matches=new Map((group.rates||[]).map(r=>[key(r),r]));
  for(const [k,r] of rates){const match=matches.get(k);if(!match){rates.delete(k);continue;}
   r.amountMinor+=match.amountMinor;if(!Number.isSafeInteger(r.amountMinor))throw new ValidationError('The combined carrier price exceeds the supported amount.');
   r.rateIds.push(...(match.rateIds||[match.rateId]));
   r.deliveryDays=r.deliveryDays==null||match.deliveryDays==null?null:Math.max(r.deliveryDays,match.deliveryDays);
   r.deliveryDate=r.deliveryDate&&match.deliveryDate?[r.deliveryDate,match.deliveryDate].sort().at(-1):null;
   r.guaranteed=Boolean(r.guaranteed&&match.guaranteed);
  }
 }
 return {providerShipmentIds:groups.flatMap(g=>g.providerShipmentIds||[]),rates:[...rates.values()]};
}
module.exports={combine};
