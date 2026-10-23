'use strict';
const {ValidationError}=require('../domain/errors');
const RANK={UNKNOWN:0,PRE_TRANSIT:1,IN_TRANSIT:2,OUT_FOR_DELIVERY:3,FAILURE:3,DELIVERED:4,RETURNED:4,CANCELLED:4};
function receipts(bought,expectedCount){
 const supplied=Array.isArray(bought.packages)&&bought.packages.length?bought.packages:
  expectedCount===1?[{externalId:bought.providerLabelIds?.[0]||bought.providerShipmentIds?.[0]||bought.providerShipmentId,trackingNumber:bought.trackingNumber,labelUrl:bought.labelUrl}]:[];
 if(supplied.length!==expectedCount)throw new ValidationError('The carrier has not confirmed a label and tracking identity for every package. Verify the saved purchase without buying again.');
 return supplied.map((row,i)=>{
  if(!row.externalId||typeof row.externalId!=='string'||row.externalId.length>500||expectedCount>1&&(!row.trackingNumber||typeof row.trackingNumber!=='string')||row.trackingNumber&&String(row.trackingNumber).length>240)
   throw new ValidationError('Every package needs a verified carrier identity and tracking number before this purchase can be confirmed.');
  return {position:i+1,externalId:row.externalId,trackingNumber:row.trackingNumber,trackingUrl:row.trackingUrl||null,status:'PRE_TRANSIT'};
 });
}
function advance(current,status){return (RANK[status]??0)>=(RANK[current]??0)?status:current;}
function apply(shipment,input){
 const packages=(shipment.provider_packages||[]).map(row=>({...row}));
 if(packages.length<=1)return {packages:packages.map(row=>({...row,status:advance(row.status,input.status)})),status:advance(shipment.tracking_status,input.status)};
 const match=packages.find(row=>input.trackingNumber&&row.trackingNumber===input.trackingNumber||input.providerShipmentId&&row.externalId===input.providerShipmentId);
 if(input.allPackagesConfirmed===true&&input.provider==='manual')packages.forEach(row=>{row.status=advance(row.status,input.status);});
 else {
 if(!match)throw new ValidationError('This carrier update does not identify one of the shipment’s packages.');
 match.status=advance(match.status,input.status);
 }
 let status;
 if(packages.every(row=>row.status==='DELIVERED'))status='DELIVERED';
 else if(packages.some(row=>['FAILURE','RETURNED','CANCELLED'].includes(row.status)))status=packages.find(row=>['FAILURE','RETURNED','CANCELLED'].includes(row.status)).status;
 else if(packages.every(row=>row.status==='OUT_FOR_DELIVERY'||row.status==='DELIVERED'))status='OUT_FOR_DELIVERY';
 else if(packages.some(row=>RANK[row.status]>=RANK.IN_TRANSIT))status='IN_TRANSIT';
 else status=packages.some(row=>row.status==='PRE_TRANSIT')?'PRE_TRANSIT':'UNKNOWN';
 return {packages,status};
}
module.exports={receipts,apply};
