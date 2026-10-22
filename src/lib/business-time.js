'use strict';
const {ValidationError}=require('../domain/errors');
function zone(value){const text=String(value||'').trim();if(!text)return null;try{new Intl.DateTimeFormat('en',{timeZone:text}).format();return text;}catch{throw new ValidationError('Choose a valid time zone, such as Europe/London or America/New_York.');}}
function context(value,now=new Date()){const timeZone=zone(value)||'UTC',parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),get=key=>parts.find(p=>p.type===key).value;return {instant:now.toISOString(),timeZone,calendarDate:get('year')+'-'+get('month')+'-'+get('day')};}
module.exports={zone,context};
