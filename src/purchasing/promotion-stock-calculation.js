'use strict';
const {ValidationError}=require('../domain/errors'),exact=require('../domain/exact-quantity'),{date}=require('./supplier-shutdown-calculation');
const DAY=86400000;
function input(raw){
 const supplierId=String(raw.supplierId||''),locationId=String(raw.locationId||''),reference=String(raw.reference||'').trim();
 const skuIds=Array.isArray(raw.skuIds)?raw.skuIds.map(String):String(raw.skuIds||'').split(/\s*,\s*/).filter(Boolean);
 if(!supplierId||!locationId||!reference||reference.length>200||/[\x00-\x1f]/.test(reference)||!skuIds.length||skuIds.length>250||new Set(skuIds).size!==skuIds.length)throw new ValidationError('Choose one known supplier, an owned warehouse, a promotion reference and one to 250 exact products.');
 const orderByDate=date(raw.orderByDate,'last order'),arrivalDate=date(raw.arrivalDate,'planned arrival'),startsOn=date(raw.startsOn,'promotion start'),endsOn=date(raw.endsOn,'promotion end');
 if(orderByDate>arrivalDate||arrivalDate>startsOn||startsOn>endsOn||(Date.parse(endsOn)-Date.parse(orderByDate))/DAY>365)throw new ValidationError('Order by the planned arrival, arrive by the promotion start, and choose an end within one year.');
 const uplift=String(raw.upliftPercent??'');if(!/^\d{1,4}$/.test(uplift)||Number(uplift)>1000)throw new ValidationError('Enter your chosen extra demand percentage explicitly, from zero to 1000. It is an assumption, not a forecast guarantee.');
 return {supplierId,locationId,reference,orderByDate,arrivalDate,startsOn,endsOn,upliftPercent:Number(uplift),skuIds:[...skuIds].sort()};
}
function whole(value,label,{positive=false}={}){const s=exact.canonical(value,{label});if(!/^\d+$/.test(s))throw new ValidationError(label+' must be whole stock units.');const n=BigInt(s);if(positive&&!n)throw new ValidationError(label+' must be above zero.');return n;}
function safe(n,label){if(n<0n||n>BigInt(Number.MAX_SAFE_INTEGER))throw new ValidationError(label+' exceeds the exact supported range.');return Number(n);}
function calculate(scope,today,rows){
 today=date(today,'business day');if(scope.endsOn<today)throw new ValidationError('This promotion has ended. Record the next actual promotion.');
 const coverageDays=(Date.parse(scope.endsOn)-Date.parse(today))/DAY+1,promotionDays=(Date.parse(scope.endsOn)-Date.parse(scope.startsOn>today?scope.startsOn:today))/DAY+1;
 if(coverageDays>366)throw new ValidationError('Choose a promotion ending within one year.');
 const weightedDays=BigInt(coverageDays)*100n+BigInt(promotionDays)*BigInt(scope.upliftPercent);
 const output=rows.map(row=>{
  if(!Number.isSafeInteger(row.issueEvents)||row.issueEvents<2)throw new ValidationError('Each promotion product needs at least two recorded issue events. New products need a separate demand review.');
  const issued=whole(row.issued,'Recorded demand'),onHand=whole(row.onHand,'On-hand stock'),committed=whole(row.committed,'Promised stock'),incoming=whole(row.incoming,'Timely incoming stock'),pack=whole(row.unitsPerPurchaseUnit,'Supplier pack',{positive:true}),multiple=whole(row.orderMultiple,'Order multiple',{positive:true}),minimum=whole(row.minimumOrderQuantity,'Minimum purchase quantity'),price=whole(row.unitCostMinor,'Recorded stock-unit cost');
  const expected=(issued*weightedDays+8999n)/9000n,available=onHand+incoming>committed?onHand+incoming-committed:0n,uncovered=committed>onHand+incoming?committed-onHand-incoming:0n,needed=expected+uncovered>available?expected+uncovered-available:0n;
  let purchaseUnits=needed?(needed+pack*multiple-1n)/(pack*multiple)*multiple:0n;if(purchaseUnits&&purchaseUnits<minimum)purchaseUnits=(minimum+multiple-1n)/multiple*multiple;
  return {skuId:row.skuId,expectedUnits:safe(expected,'Expected use'),availableUnits:safe(available,'Available stock'),uncoveredCommittedUnits:safe(uncovered,'Uncovered promises'),neededUnits:safe(needed,'Required stock'),purchaseUnits:safe(purchaseUnits,'Purchase quantity'),quantityUnits:safe(purchaseUnits*pack,'Stock quantity'),totalMinor:safe(purchaseUnits*pack*price,'Goods value')};
 });
 return {coverageDays,promotionDays,deadlinePassed:scope.orderByDate<today,rows:output,totalMinor:safe(output.reduce((n,r)=>n+BigInt(r.totalMinor),0n),'Total goods value'),method:'Average physical issues over 90 complete business days, with your extra demand percentage applied only during the promotion. Current uncovered promises are added, then supplier packs and minimums apply. This estimate does not change selling prices or guarantee demand or delivery.'};
}
module.exports={input,calculate};
