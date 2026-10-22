'use strict';
const currency=require('../domain/currency');
const symbols={'€':'EUR','£':'GBP','₪':'ILS','₹':'INR','₩':'KRW','₽':'RUB','₺':'TRY','₫':'VND','₴':'UAH','₦':'NGN','₱':'PHP'};
function codes(value){const text=String(value||''),found=new Set();for(const [symbol,code]of Object.entries(symbols))if(text.includes(symbol))found.add(code);
 for(const match of text.matchAll(/\b[A-Z]{3}\b/g)){try{currency.exponent(match[0]);if(Intl.supportedValuesOf('currency').includes(match[0]))found.add(match[0]);}catch{}}
 return [...found];}
function clean(value){return String(value??'').replace(/[€£₪₹₩₽₺₫₴₦₱]/g,'').replace(/\b[A-Z]{3}\b/g,token=>codes(token).length?'':token).trim();}
module.exports={codes,clean};
