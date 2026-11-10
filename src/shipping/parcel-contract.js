'use strict';
const {ValidationError}=require('../domain/errors');
const measurement=require('../domain/physical-measure');
const MAX_PACKAGES=100;
const MAX_WEIGHT_GRAMS=1000000;
const MAX_DIMENSION=2147483647;
const weightUnits={g:[1,1],kg:[1000,1],oz:[28349523125,1000000000],lb:[45359237,100000]};
function weight(box,label,{nearestImperial=false}={}){
 const measured=box.weight??(box.weightUnit?box.weightGrams:undefined);
 const direct=measured==null||measured==='';
 const unit=direct?'g':String(box.weightUnit||'g').toLowerCase();
 if(!Object.hasOwn(weightUnits,unit))throw new ValidationError('Choose g, kg, oz or lb for package weight.');
 const ratio=weightUnits[unit];
 const canonical=measurement.convert(direct?box.weightGrams:measured,{numerator:ratio[0],denominator:ratio[1],label,limit:MAX_DIMENSION});
 // Preserve the established carrier weight conversion for manually entered
 // pounds or ounces. Supplier-derived and metric weights stay exact.
 const grams=unit==='lb'||unit==='oz'
  ?nearestImperial?Math.max(1,Math.round(Number(canonical))):Math.ceil(Number(canonical)-1e-9)
  :canonical;
 if(Number(grams)>MAX_WEIGHT_GRAMS)throw new ValidationError(label+' exceeds 1,000 kg per package.');
 return grams;
}
function format(value,downloadUrl){let inferred;try{inferred=new URL(downloadUrl).pathname.split('.').at(-1);}catch{}
 const name=String(value||inferred||'PDF').toUpperCase();
 if(['PDF','PDF_4X6','PDF_4X8','PDF_A4','PDF_A6','APPLICATION/PDF'].includes(name))return 'PDF';
 if(['ZPL','ZPLII','APPLICATION/ZPL','APPLICATION/X-ZPL','TEXT/ZPL'].includes(name))return 'ZPL';
 throw new ValidationError('The carrier returned an unsupported label format. Verify its saved purchase without buying again.');
}
function boxes(input){
 if(!Array.isArray(input)||input.length<1||input.length>MAX_PACKAGES)throw new ValidationError('A shipment needs 1 to '+MAX_PACKAGES+' packages.');
 const rows=input.map((box,i)=>{if(!box||typeof box!=='object')throw new ValidationError('Package '+(i+1)+' is not readable.');
  const result={weightGrams:weight(box,'Package '+(i+1)+' weight')};
  for(const key of ['lengthMm','widthMm','heightMm'])result[key]=measurement.optional(box[key],'Package '+(i+1)+' dimension',MAX_DIMENSION);
  if(Object.values(result).slice(1).filter(v=>v!==null).length%3!==0)throw new ValidationError('Package '+(i+1)+' needs all three measured dimensions, or none.');
  return result;});
 return rows;
}
function options(input={},previous={}){
 input={...previous,...Object.fromEntries(Object.entries(input).filter(([,value])=>value!==null&&value!==undefined&&value!==''))};
 if(input.printChoice){const parts=String(input.printChoice).split(':');if(parts.length!==2)throw new ValidationError('Choose a supported label format and size.');input={...input,labelFormat:parts[0],labelLayout:parts[1]};}
 const labelFormat=String(input.labelFormat||'PDF').toUpperCase(),labelLayout=String(input.labelLayout||'4x6').toLowerCase(),signature=String(input.signature||'NONE').toUpperCase();
 if(!['PDF','ZPL'].includes(labelFormat))throw new ValidationError('Choose PDF or ZPL label format.');
 if(!['4x6','letter'].includes(labelLayout)||labelFormat==='ZPL'&&labelLayout!=='4x6')throw new ValidationError('Choose a supported label layout: PDF 4x6, PDF letter or ZPL 4x6.');
 if(!['NONE','SIGNATURE','ADULT'].includes(signature))throw new ValidationError('Choose no additional signature, signature required or adult signature.');
 const serviceEligibility=String(input.serviceEligibility||'GENERAL').toUpperCase();if(!['GENERAL','MEDIA_MAIL','LIBRARY_MAIL','BOUND_PRINTED_MATTER'].includes(serviceEligibility))throw new ValidationError('Choose the parcel’s confirmed postal-content eligibility.');
 return {labelFormat,labelLayout,signature,...(serviceEligibility==='GENERAL'?{}:{serviceEligibility})};
}
function documents(receipt){
 const documents=[],seen=new Set();
 function add(value,kind,format){if(!value)return;let url;try{url=new URL(value);}catch{throw new ValidationError('The carrier document has an invalid download URL.');}
  if(url.protocol!=='https:'||url.username||url.password||url.href.length>8192)throw new ValidationError('The carrier document needs a secure download URL without embedded credentials.');
  if(seen.has(url.href))return;seen.add(url.href);documents.push({kind,url:url.href,format:module.exports.format(format),position:documents.filter(row=>row.kind===kind).length+1});
 }
 for(const url of receipt.labelUrls?.length?receipt.labelUrls:[receipt.labelUrl])add(url,'LABEL',receipt.labelFormat);
 for(const url of receipt.customsUrls||[])add(url,'CUSTOMS','PDF');
 return documents;
}
module.exports={boxes,options,documents,format,MAX_PACKAGES,MAX_WEIGHT_GRAMS,weight};
