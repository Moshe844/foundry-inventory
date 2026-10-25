'use strict';
const {ValidationError}=require('../domain/errors');
const periods=Object.freeze({today:'Today',yesterday:'Yesterday',last_7_days:'Last 7 calendar days including today',this_week:'This week · Monday to Sunday'});
const add=(day,n)=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
function bounds(value,calendar){if(!Object.hasOwn(periods,value)||!calendar?.calendarDate)throw new ValidationError('Choose a supported relative date and business calendar.');const day=calendar.calendarDate;if(value==='today')return {from:day,to:day};if(value==='yesterday'){const prior=add(day,-1);return {from:prior,to:prior};}if(value==='last_7_days')return {from:add(day,-6),to:day};const weekday=new Date(day+'T12:00:00Z').getUTCDay(),from=add(day,-((weekday+6)%7));return {from,to:add(from,6)};}
function filters(input,calendar){return input.flatMap(f=>{if(f.operator!=='relative')return [f];const range=bounds(f.value,calendar);return [{field:f.field,operator:'after',value:range.from},{field:f.field,operator:'before',value:range.to}];});}
function resolve(config,calendar){if(config.dataset==='composed')return {...config,metrics:config.metrics.map(m=>({...m,filters:filters(m.filters,calendar)}))};return {...config,filters:filters(config.filters,calendar)};}
module.exports={periods,bounds,filters,resolve};
