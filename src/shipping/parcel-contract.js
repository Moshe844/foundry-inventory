'use strict';
const {ValidationError}=require('../domain/errors');
const MAX_PACKAGES=100;
const MAX_WEIGHT_GRAMS=1000000;
function weight(box,label){
 const measured=box.weight??(box.weightUnit?box.weightGrams:undefined);
 if(measured==null||measured===''){
  const grams=positive(box.weightGrams,label);if(grams>MAX_WEIGHT_GRAMS)throw new ValidationError(label+' exceeds 1,000 kg per package.');return grams;
 }
 const unit=String(box.weightUnit||'g').toLowerCase(),factor={g:1,kg:1000,oz:28.349523125,lb:453.59237}[unit];
 if(!factor)throw new ValidationError('Choose g, kg, oz or lb for package weight.');
 const raw=String(measured).trim();if(!/^\d+(?:\.\d{1,6})?$/.test(raw)||Number(raw)<=0)throw new ValidationError(label+' must be a positive weight, with at most six decimal places.');
 const grams=Math.ceil(Number(raw)*factor-1e-9);if(grams>MAX_WEIGHT_GRAMS)throw new ValidationError(label+' exceeds 1,000 kg per package.');return grams;
}
function format(value,downloadUrl){let inferred;try{inferred=new URL(downloadUrl).pathname.split('.').at(-1);}catch{}
 const name=String(value||inferred||'PDF').toUpperCase();
 if(['PDF','PDF_4X6','PDF_4X8','PDF_A4','PDF_A6','APPLICATION/PDF'].includes(name))return 'PDF';
 if(['ZPL','ZPLII','APPLICATION/ZPL','APPLICATION/X-ZPL','TEXT/ZPL'].includes(name))return 'ZPL';
 throw new ValidationError('The carrier returned an unsupported label format. Verify its saved purchase without buying again.');
}
function positive(value,label){const n=Number(value);if(!Number.isSafeInteger(n)||n<1||n>2147483647)throw new ValidationError(label+' must be a whole number from 1 to 2,147,483,647.');return n;}
function boxes(input){
 if(!Array.isArray(input)||input.length<1||input.length>MAX_PACKAGES)throw new ValidationError('A shipment needs 1 to '+MAX_PACKAGES+' packages.');
 const rows=input.map((box,i)=>{if(!box||typeof box!=='object')throw new ValidationError('Package '+(i+1)+' is not readable.');
  const result={weightGrams:weight(box,'Package '+(i+1)+' weight')};
  for(const key of ['lengthMm','widthMm','heightMm'])result[key]=box[key]==null||box[key]===''?null:positive(box[key],'Package '+(i+1)+' dimension');
  if(Object.values(result).slice(1).filter(v=>v!==null).length%3!==0)throw new ValidationError('Package '+(i+1)+' needs all three measured dimensions, or none.');
  return result;});
 if(rows.reduce((sum,row)=>sum+row.weightGrams,0)>2147483647)throw new ValidationError('Combined package weight exceeds the supported 2,147,483,647 grams.');
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
