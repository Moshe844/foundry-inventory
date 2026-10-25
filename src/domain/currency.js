'use strict';
const {ValidationError}=require('./errors');
// ISO units of account are omitted from CLDR's circulating-currency list.
const supported=new Set([...Intl.supportedValuesOf('currency'),'CLF','UYW']);
const exponents=new Map();
function code(value){
  const text=String(value??'').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(text)||!supported.has(text))throw new ValidationError('Choose a recognized ISO currency.');
  return text;
}
function exponent(value){const currency=code(value);if(!exponents.has(currency))exponents.set(currency,new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits);return exponents.get(currency);}
function integer(value,label='Amount',{signed=false}={}){
 const n=typeof value==='number'?value:typeof value==='string'&&/^-?\d+$/.test(value.trim())?Number(value):NaN;
 if(!Number.isSafeInteger(n)||(!signed&&n<0))throw new ValidationError(label+' must use exact whole minor currency units.');
 return n;
}
// Provider decimal strings must never go through floating-point multiplication.
// Excess zeroes are harmless; an unrepresentable fraction must be reconciled,
// not silently rounded to a different paid amount.
function toMinor(value,currency,{label='Amount',optional=false,signed=false}={}){
 if(value===null||value===undefined||String(value).trim()===''){if(optional)return null;throw new ValidationError(label+' is missing.');}
 const text=String(value).trim(),match=text.match(/^(-?)(\d+)(?:\.(\d+))?$/),digits=exponent(currency);
 if(match?.[1]&&!signed)throw new ValidationError(label+' cannot be negative.');if(!match)throw new ValidationError(label+' must be a valid decimal amount.');
 const fraction=match[3]||'';
 if(fraction.slice(digits).replace(/0/g,''))throw new ValidationError(label+' has a fraction smaller than the currency supports.');
 const scale=10n**BigInt(digits),amount=(BigInt(match[2])*scale+BigInt(fraction.slice(0,digits).padEnd(digits,'0')||'0'))*(match[1]?-1n:1n);
 const result=Number(amount);if(!Number.isSafeInteger(result))throw new ValidationError(label+' is outside the supported exact range.');
 return result;
}
function fromMinor(value,currency){
 const n=integer(value,'Amount',{signed:true}),digits=exponent(currency),negative=n<0,raw=String(Math.abs(n)).padStart(digits+1,'0');
 return (negative?'-':'')+(digits?raw.slice(0,-digits)+'.'+raw.slice(-digits):raw);
}
function userToMinor(value,currency,options={}){
 const c=code(currency);let text=String(value??'').trim();if(!text&&options.optional)return null;
 const symbols=new Set([c,new Intl.NumberFormat('en-US',{style:'currency',currency:c}).formatToParts(1).find(p=>p.type==='currency')?.value,...(c==='USD'?['US$']:[])]);
 for(const token of [...symbols].filter(Boolean).sort((a,b)=>b.length-a.length)){
  if(text.toUpperCase().startsWith(token.toUpperCase())){text=text.slice(token.length).trim();break;}
  if(text.toUpperCase().endsWith(token.toUpperCase())){text=text.slice(0,-token.length).trim();break;}
 }
 if(/[A-Za-z\p{Sc}]/u.test(text))throw new ValidationError((options.label||'Amount')+' currency does not match '+c+'.');
 return toMinor(require('./human-number').decimal(text,{label:options.label||'Amount',fractionDigits:exponent(c)}),c,options);
}
function format(value,currency='USD',locale='en-US'){
 const n=integer(value,'Amount',{signed:true}),c=code(currency);
 return new Intl.NumberFormat(locale,{style:'currency',currency:c}).format(n/10**exponent(c));
}
function sum(values,label='Amount'){const total=values.reduce((n,v)=>n+BigInt(integer(v,label,{signed:true})),0n),number=Number(total);if(!Number.isSafeInteger(number))throw new ValidationError(label+' exceeds the exact supported range.');return number;}
module.exports={code,exponent,integer,toMinor,userToMinor,fromMinor,format,sum};
