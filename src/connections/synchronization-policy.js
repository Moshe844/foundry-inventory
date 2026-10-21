'use strict';

const {ValidationError}=require('../domain/errors');
const INTERVALS=Object.freeze([1,5,10,15,30,60,360]);
function object(value){if(value&&typeof value==='object')return value;try{return JSON.parse(value)||{};}catch{return {};}}
function interval(value){const minutes=Number(value);if(!INTERVALS.includes(minutes))
  throw new ValidationError('Choose a check interval of 1, 5, 10, 15, 30 or 60 minutes.');return minutes;}
function supports(adapter){return Boolean(adapter&&(typeof adapter.poll==='function'||typeof adapter.discover==='function'));}
function describe(connection,adapter,now=Date.now()){
  const config=object(connection.config),requestedMinutes=Number(connection.expected_interval_minutes)||1;
  // A Xero catalogue read needs Organisation and Items. Its Starter allowance
  // is 1,000 requests per organisation/day; leave room for foreground work.
  const minimumMinutes=connection.provider_type==='xero'?5:1;
  const effectiveMinutes=Math.max(requestedMinutes,minimumMinutes);
  const supported=supports(adapter),disabled=config.syncDisabled===true;
  const mode=disabled?'off':connection.paused_at?'paused':connection.status!=='connected'?'disconnected':'active';
  const lastCheckAt=connection.last_synced_at||null;
  const cooldownAt=Date.parse(config.syncRetryAt||'');
  const dueAt=Math.max(Date.parse(lastCheckAt||connection.created_at)||now,
    0)+effectiveMinutes*60_000;
  return {supported,mode,requestedMinutes,effectiveMinutes,minimumMinutes,lastCheckAt,
    nextCheckAt:supported&&mode==='active'?new Date(Math.max(dueAt,Number.isFinite(cooldownAt)?cooldownAt:0)).toISOString():null,
    retryAt:Number.isFinite(cooldownAt)&&cooldownAt>now?new Date(cooldownAt).toISOString():null,
    scope:typeof adapter?.poll==='function'?'mailbox':'catalogue',
    providerLimitNote:minimumMinutes>requestedMinutes?'Xero catalogue checks run at least five minutes apart to preserve its daily API allowance.':null};
}
module.exports={INTERVALS,object,interval,supports,describe};
