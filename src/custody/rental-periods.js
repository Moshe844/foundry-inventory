'use strict';
const clock=require('../lib/business-time'),{ValidationError}=require('../domain/errors'),{ratio}=require('../pricing/calculator');
function boundary(policy,n){
 if(!Number.isSafeInteger(n)||n<0||n>1200)throw new ValidationError('Rental period number is outside the supported range.');
 const anchor=new Date(policy.anchor_at);if(n===0)return anchor;const p=clock.parts(anchor,policy.time_zone),day=new Date(p.day+'T00:00:00Z');
 if(policy.interval_unit==='MONTH'){
  const target=new Date(Date.UTC(day.getUTCFullYear(),day.getUTCMonth()+n,1)),last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day.getUTCDate(),last));day.setTime(target.getTime());
 }else if(['DAY','WEEK'].includes(policy.interval_unit))day.setUTCDate(day.getUTCDate()+n*(policy.interval_unit==='WEEK'?7:1));
 else throw new ValidationError('Choose daily, weekly or calendar-month billing.');
 const at=clock.wall(day.toISOString().slice(0,10),p.hour,p.minute,policy.time_zone);if(!at)throw new ValidationError('This rental boundary does not exist in the business time zone.');at.setTime(at.getTime()+p.second*1000+anchor.getUTCMilliseconds());return at;
}
function period(policy,n){
 if(!policy.anchor_at)return null;const start=boundary(policy,n),end=boundary(policy,n+1),stop=policy.stopped_at?new Date(policy.stopped_at):null;
 if(stop&&stop<=start)return null;const ends=stop&&stop<end?stop:end,final=Boolean(stop&&stop<=end),elapsed=ends-start,length=end-start;
 const amountMinor=policy.prorate_final&&elapsed<length?ratio(Number(policy.amount_minor),elapsed,length):Number(policy.amount_minor);
 return {index:n,startsAt:start.toISOString(),endsAt:ends.toISOString(),scheduledEndsAt:end.toISOString(),amountMinor,final,prorated:elapsed<length&&policy.prorate_final};
}
module.exports={boundary,period};
