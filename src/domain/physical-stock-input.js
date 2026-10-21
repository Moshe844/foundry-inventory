'use strict';
const {ValidationError}=require('./errors');
const MAX_QUANTITY=1000000000;
function date(value,label){
 if(value===null||value===undefined||value==='')return null;
 const text=String(value),stamp=Date.parse(text);
 if(!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(text)||!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==text.slice(0,10))
  throw new ValidationError(label+' must be a real calendar date.');
 return text;
}
function validate(input,{now=Date.now()}={}){
 for(const [field,label]of [['occurredAt','Stock movement date'],['lotReceivedAt','Lot received date']]){
   const value=date(input[field],label);
   // A calendar-only date can be in tomorrow's UTC day for a customer east of
   // UTC. Reject unmistakably future events without treating that as a promise.
   if(value&&Date.parse(value)>now+(value.length===10?14*3600000:60000))
    throw new ValidationError(label+' cannot be in the future. Record the movement when it physically happens.');
 }
 const expires=date(input.expiresAt,'Lot expiry date');
 const received=date(input.lotReceivedAt||input.occurredAt,'Lot received date');
 if(expires&&received&&expires.slice(0,10)<received.slice(0,10))
  throw new ValidationError('The lot expires before its received date. Correct the dates before receiving this stock.');
 return input;
}
module.exports={MAX_QUANTITY,date,validate};
