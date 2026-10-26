'use strict';
const {ValidationError}=require('../domain/errors');
function zone(value){const text=String(value||'').trim();if(!text)return null;try{new Intl.DateTimeFormat('en',{timeZone:text}).format();return text;}catch{throw new ValidationError('Choose a valid time zone, such as Europe/London or America/New_York.');}}
function context(value,now=new Date()){const timeZone=zone(value)||'UTC',parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now),get=key=>parts.find(p=>p.type===key).value;return {instant:now.toISOString(),timeZone,calendarDate:get('year')+'-'+get('month')+'-'+get('day')};}
const formats=new Map();function parts(at,timeZone){let f=formats.get(timeZone);if(!f){f=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});formats.set(timeZone,f);}const p=Object.fromEntries(f.formatToParts(at).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return {day:p.year+'-'+p.month+'-'+p.day,hour:Number(p.hour),minute:Number(p.minute),second:Number(p.second)};}
function wall(day,hour,minute,timeZone){const naive=Date.parse(day+'T00:00:00Z')+(hour*60+minute)*60000,offsets=new Set();for(const delta of [-129600000,0,129600000]){const sample=naive+delta,p=parts(new Date(sample),timeZone);offsets.add(Date.parse(p.day+'T00:00:00Z')+(p.hour*3600+p.minute*60+p.second)*1000-sample);}for(let shift=0;shift<=180;shift++){const local=new Date(naive+shift*60000),target={day:local.toISOString().slice(0,10),hour:local.getUTCHours(),minute:local.getUTCMinutes()};if(target.day!==day)return null;const matches=[];for(const offset of offsets){const candidate=new Date(naive+shift*60000-offset),p=parts(candidate,timeZone);if(p.day===target.day&&p.hour===target.hour&&p.minute===target.minute)matches.push(candidate);}if(matches.length)return matches.sort((a,b)=>a-b)[0];}return null;}
function dayBoundary(day,timeZone,{nextDay=false}={}){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(day))||!Number.isFinite(Date.parse(day))||new Date(day).toISOString().slice(0,10)!==day)throw new ValidationError('Choose a real calendar date.');const value=nextDay?new Date(Date.parse(day)+86400000).toISOString().slice(0,10):day,result=wall(value,0,0,zone(timeZone)||'UTC');if(!result)throw new ValidationError('This date does not exist in the business time zone.');return result.toISOString();}
async function forWorkspace(db,workspaceId,now=new Date()){
 const row=(await db.query('SELECT coalesce(w.time_zone,a.time_zone,\'UTC\') time_zone FROM workspaces w JOIN accounts a ON a.id=w.owner_account_id WHERE w.id=$1',[workspaceId])).rows[0];
 return context(row?.time_zone||'UTC',now);
}
async function today(db,workspaceId,now=new Date()){return (await forWorkspace(db,workspaceId,now)).calendarDate;}
async function alignAutomaticStart(db,workspaceId,oldZone,newZone){
 const w=(await db.query('SELECT created_at FROM workspaces WHERE id=$1',[workspaceId])).rows[0];if(!w)return;
 const s=(await db.query('SELECT accounting_start_date,start_date_basis FROM accounting_settings WHERE workspace_id=$1 FOR UPDATE',[workspaceId])).rows[0];if(s?.start_date_basis!=='WORKSPACE_CREATION')return;
 const instant=new Date(w.created_at),prior=context(oldZone,instant).calendarDate,next=context(newZone,instant).calendarDate;
 if(s.accounting_start_date!==prior||prior===next)return;
 if((await db.query("SELECT 1 FROM accounting_periods WHERE workspace_id=$1 AND starts_on<=$2 AND ends_on>=$2 AND status<>'OPEN' LIMIT 1",[workspaceId,next])).rows.length)throw new ValidationError('The new business start date falls in a closed accounting period. Review Money → Accounting periods before changing the time zone.');
 await db.query('UPDATE accounting_settings SET accounting_start_date=$2,updated_at=$3 WHERE workspace_id=$1 AND start_date_basis=$4',[workspaceId,next,new Date().toISOString(),'WORKSPACE_CREATION']);
}
module.exports={zone,context,forWorkspace,today,parts,wall,dayBoundary,alignAutomaticStart};
