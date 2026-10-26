'use strict';

const currency=require('../../domain/currency');
const {unitLabel}=require('../../lib/units');
const {zone}=require('../../lib/business-time');
const dates=require('../public/presentation-format');
const numbers=new Intl.NumberFormat('en-US');
const formats=new Map();

function forTimeZone(value){
 const timeZone=zone(value)||'UTC';if(formats.has(timeZone))return formats.get(timeZone);
 const format=dates.create(timeZone);
 const result=Object.freeze({
  timeZone,
  date:format.date,
  dateTime:format.dateTime,
  number(value){return numbers.format(Number(value||0));},
  quantity(value,label='unit'){return numbers.format(Number(value||0))+' '+unitLabel(value,label);},
  money(amountMinor,code='USD'){return amountMinor===null||amountMinor===undefined?'Price not set':currency.format(amountMinor,code);},
 });
 if(formats.size>=128)formats.delete(formats.keys().next().value);formats.set(timeZone,result);return result;
}
module.exports={forTimeZone};
