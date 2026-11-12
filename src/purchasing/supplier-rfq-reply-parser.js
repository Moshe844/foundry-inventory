'use strict';
// Job 93: reads a supplier's quotation reply written in the format the RFQ asks
// for. Anything it cannot read exactly is left for a person; it never guesses.
//   CODE: 10 at USD 12.50 each
//   Freight: USD 20.00          (or "Free delivery")
//   Valid through: 2026-12-15
//   Delivery date: 2026-12-01
const {prose}=require('../connections/reply-triage');
const money=require('../domain/currency');
const line=/^([A-Za-z0-9][A-Za-z0-9._/-]{0,79})\s*:\s*(\d{1,6})\s+at\s+([A-Za-z]{3})\s+(\d{1,12}(?:\.\d{1,4})?)\s+each\.?$/i;
const freight=/^(?:freight|shipping|delivery charge|delivery cost)\s*:\s*([A-Za-z]{3})\s+(\d{1,12}(?:\.\d{1,4})?)\.?$/i;
const free=/^free (?:shipping|freight|delivery)\.?$/i;
const valid=/^valid (?:through|until)\s*:\s*(\d{4}-\d{2}-\d{2})\.?$/i;
const arrival=/^(?:delivery date|deliver by|arrival date)\s*:\s*(\d{4}-\d{2}-\d{2})\.?$/i;
function realDate(text){return Number.isFinite(Date.parse(text))&&new Date(text+'T00:00:00Z').toISOString().slice(0,10)===text;}
// Returns {document} ready for job 92's quotation capture, or {problem}.
function parse(bodyText,snapshot){
 const own=prose(bodyText);if(!own||own.length>30000)return {problem:'The reply is empty or too long to read on its own.'};
 const raw=own.split(/\r?\n/),found=[];let currency=null,deliveryMinor=null,validThrough=null,expectedArrivalDate=null,termsFrom=-1,termsTo=-1,linesFrom=-1,linesTo=-1;
 const codes=new Map(snapshot.products.map(p=>[p.code.toLowerCase(),p]));
 for(const [index,text] of raw.entries()){
  const value=text.trim();let m;
  if((m=line.exec(value))){
   const product=codes.get(m[1].toLowerCase());if(!product)return {problem:'The reply quotes '+m[1]+', which is not in this RFQ.'};
   const code=m[3].toUpperCase();if(currency&&currency!==code)return {problem:'The reply uses more than one currency.'};currency=code;
   if(found.some(f=>f.skuId===product.id))return {problem:'The reply quotes '+product.code+' more than once.'};
   let unitCostMinor;try{unitCostMinor=money.userToMinor(m[4],code,{label:'Quoted unit price'});}catch{return {problem:'The price for '+product.code+' is not a valid '+code+' amount.'};}
   found.push({skuId:product.id,sku:product.code,quantity:Number(m[2]),quantityBasis:'stock',unitCostMinor});
   if(linesFrom<0)linesFrom=index;linesTo=index;continue;
  }
  if((m=freight.exec(value))){if(deliveryMinor!==null)return {problem:'The reply states freight twice.'};const code=m[1].toUpperCase();if(currency&&currency!==code)return {problem:'The freight is in a different currency from the prices.'};
   try{deliveryMinor=money.userToMinor(m[2],code,{label:'Quoted freight'});}catch{return {problem:'The freight amount is not valid.'}}currency=currency||code;}
  else if(free.test(value)){if(deliveryMinor!==null)return {problem:'The reply states freight twice.'};deliveryMinor=0;}
  else if((m=valid.exec(value))){if(validThrough||!realDate(m[1]))return {problem:'The quote validity date is unclear.'};validThrough=m[1];}
  else if((m=arrival.exec(value))){if(expectedArrivalDate||!realDate(m[1]))return {problem:'The delivery date is unclear.'};expectedArrivalDate=m[1];}
  else continue;
  if(termsFrom<0)termsFrom=index;termsTo=index;
 }
 if(!found.length)return {problem:'The reply has no price lines StockChief can read. Record the quote yourself.'};
 const block=(from,to)=>raw.slice(from,to+1).join('\n').trim();
 let evidenceQuote=block(linesFrom,linesTo);if(evidenceQuote.length>1000)evidenceQuote=raw[linesFrom].trim();
 if(evidenceQuote.length<5)return {problem:'The quoted lines are too short to keep as evidence.'};
 let quotationTerms=null;
 if(validThrough||deliveryMinor!==null){
  const evidence=block(Math.min(termsFrom,linesFrom),Math.max(termsTo,linesTo));
  if(evidence.length>1000)return {problem:'The quote terms are spread too far apart to keep as one piece of evidence.'};
  // Job 92 records a delivery charge only when the quote covers one product.
  quotationTerms={validThrough,deliveryMinor:found.length===1?deliveryMinor:null,evidence};
 }
 return {document:{documentType:'quotation',evidenceQuote,currency,expectedArrivalDate,lines:found.map(({sku,...rest})=>rest),...(quotationTerms?{quotationTerms}:{}),freightMinor:deliveryMinor}};
}
module.exports={parse};
