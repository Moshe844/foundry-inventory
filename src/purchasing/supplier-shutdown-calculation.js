'use strict';
const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity');
const DAY=86400000;
function date(value,label){
 const s=String(value||'');if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s))||new Date(s).toISOString().slice(0,10)!==s)throw new ValidationError('Enter the exact '+label+' date.');return s;
}
function input(raw){
 const supplierId=String(raw.supplierId||''),locationId=String(raw.locationId||''),reference=String(raw.reference||'').trim();
 const skuIds=Array.isArray(raw.skuIds)?raw.skuIds.map(String):String(raw.skuIds||'').split(/\s*,\s*/).filter(Boolean);
 if(!supplierId||!locationId||!reference||reference.length>200||/[\x00-\x1f]/.test(reference)||!skuIds.length||skuIds.length>250||new Set(skuIds).size!==skuIds.length)throw new ValidationError('Choose a known supplier, one owned warehouse, its shutdown notice and one to 250 exact products.');
 const lastOrderDate=date(raw.lastOrderDate,'last accepted order'),closedFrom=date(raw.closedFrom,'closure start'),closedThrough=date(raw.closedThrough,'closure end'),nextArrivalDate=date(raw.nextArrivalDate,'next possible delivery');
 if(lastOrderDate>closedFrom||closedFrom>closedThrough||closedThrough>=nextArrivalDate)throw new ValidationError('The last order date must precede the shutdown, and the next delivery must follow its end.');
 const extra=String(raw.extraCoverDays??'');if(!/^\d{1,2}$/.test(extra)||Number(extra)>90)throw new ValidationError('Enter extra coverage days explicitly, from zero to ninety.');
 if((Date.parse(nextArrivalDate)-Date.parse(lastOrderDate))/DAY>365)throw new ValidationError('Review supplier shutdowns spanning more than one year separately.');
 return {supplierId,locationId,reference,lastOrderDate,closedFrom,closedThrough,nextArrivalDate,extraCoverDays:Number(extra),skuIds:[...skuIds].sort()};
}
function whole(value,label,{positive=false}={}){
 const s=exact.canonical(value,{label});if(!/^\d+$/.test(s))throw new ValidationError(label+' must be whole stock units.');const n=BigInt(s);if(positive&&n===0n)throw new ValidationError(label+' must be above zero.');return n;
}
function safe(n,label){if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError(label+' exceeds the exact supported range.');return Number(n);}
function calculate(scope,today,rows){
 today=date(today,'business day');const days=Math.max(0,(Date.parse(scope.nextArrivalDate)-Date.parse(today))/DAY)+scope.extraCoverDays;
 if(days>455)throw new ValidationError('The next delivery is too far away for this planning window.');
 const output=rows.map(row=>{
  const issued=whole(row.issued,'Recorded demand'),onHand=whole(row.onHand,'On-hand stock'),committed=whole(row.committed,'Promised stock'),incoming=whole(row.incoming,'Timely incoming stock');
  const pack=whole(row.unitsPerPurchaseUnit,'Supplier pack',{positive:true}),multiple=whole(row.orderMultiple,'Order multiple',{positive:true}),minimum=whole(row.minimumOrderQuantity,'Minimum purchase quantity');
  const price=whole(row.unitCostMinor,'Recorded stock-unit cost');
  if(!Number.isSafeInteger(row.issueEvents)||row.issueEvents<2)throw new ValidationError('At least two recorded issue events are needed for each product. No demand is invented.');
  const expected=(issued*BigInt(days)+89n)/90n,available=onHand+incoming>committed?onHand+incoming-committed:0n,uncovered=committed>onHand+incoming?committed-onHand-incoming:0n;
  const needed=expected+uncovered>available?expected+uncovered-available:0n;
  let purchaseUnits=needed?(needed+pack*multiple-1n)/(pack*multiple)*multiple:0n;
  if(purchaseUnits&&purchaseUnits<minimum)purchaseUnits=(minimum+multiple-1n)/multiple*multiple;
  const quantity=purchaseUnits*pack,total=quantity*price;
  return {skuId:row.skuId,expectedUnits:safe(expected,'Expected demand'),availableUnits:safe(available,'Available stock'),uncoveredCommittedUnits:safe(uncovered,'Uncovered promises'),neededUnits:safe(needed,'Required stock'),purchaseUnits:safe(purchaseUnits,'Purchase quantity'),quantityUnits:safe(quantity,'Stock quantity'),totalMinor:safe(total,'Order value')};
 });
 const total=output.reduce((sum,r)=>sum+BigInt(r.totalMinor),0n);
 return {coverageDays:days,deadlinePassed:scope.lastOrderDate<today,rows:output,totalMinor:safe(total,'Total order value'),method:'Average recorded physical issues over 90 days, plus current uncovered promises; whole supplier packs and minimums. This is a planning estimate, not a demand guarantee.'};
}
module.exports={input,calculate,date};
