'use strict';
const entitlements=require('./entitlements');
async function incomingMeter(database,scope){const sub=await entitlements.subscriptionFor(database,scope.accountId);return sub?.plan_configuration?.usageCategories?.includes('incoming_emails')?'incoming_emails':'business_communications';}
function addresses(value){
 const found=new Set(),invalid=()=>{throw new (require('../domain/errors').ValidationError)('Use a valid business email recipient.');};
 for(const entry of [value].flat(Infinity)){
  if(entry===undefined||entry===null||entry==='')continue;
  const address=typeof entry==='object'?entry.address:entry;if(typeof address!=='string'||/[\r\n]/.test(address))invalid();
  let quoted=false,escaped=false,angle=0,start=0;const parts=[];
  for(let i=0;i<address.length;i++){const c=address[i];if(escaped){escaped=false;continue;}if(c==='\\'&&quoted){escaped=true;continue;}if(c==='"'){quoted=!quoted;continue;}if(!quoted){if(c==='<')angle++;if(c==='>')angle--;if(angle<0||angle>1)invalid();if(!angle&&(c===','||c===';')){parts.push(address.slice(start,i));start=i+1;}}}
  if(quoted||angle||escaped)invalid();parts.push(address.slice(start));
  for(const raw of parts){const match=/^(?:[^<>]*<([^<>]+)>|([^<>]+))$/.exec(raw.trim());const email=(match?.[1]||match?.[2]||'').trim().toLowerCase();if(!/^[^\s@,;<>"\\]+@[^\s@,;<>"\\]+$/.test(email))invalid();found.add(email);}
 }
 return [...found];
}
function recipients(value){return addresses(value).length;}
module.exports={incomingMeter,recipients,addresses};
