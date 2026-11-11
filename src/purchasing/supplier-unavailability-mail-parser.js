'use strict';

const {ValidationError}=require('../domain/errors');
const subjectPattern=/^(?:re:\s*)*(?:purchase order|po) (?:availability update|unavailability)\s*[:#-]?\s+([a-z0-9][a-z0-9._/-]{0,79})[.!]?$/i;
const unclear=()=>new ValidationError('Review the original email. Match the purchase order, affected product codes, unavailable-through date and the supplier’s stated reason.');

function subject(value){return subjectPattern.exec(String(value||'').trim())?.[1]||null;}
function validDate(value){
  return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
}

function parse(title,body){
  const order=subject(title);
  if(!order||typeof body!=='string'||body.length>30000)throw unclear();
  const rows=[];
  let validThrough=null,reason=null;
  for(const raw of require('../connections/reply-triage').prose(body).split(/\r?\n/)){
    const line=raw.trim();
    if(!line||/^(?:hello|hi|thanks|thank you|regards|best regards)[,.!]?$/i.test(line))continue;
    const field=/^(Unavailable through|Reason|SKU|Supplier SKU|Line)\s*:\s*(.+)$/i.exec(line);
    if(!field)throw unclear();
    const key=field[1].toLowerCase(),value=field[2].trim();
    if(key==='unavailable through'){
      if(validThrough||!validDate(value))throw unclear();
      validThrough=value;
    }else if(key==='reason'){
      if(reason||value.length<4||value.length>1000)throw unclear();
      reason=value;
    }else{
      if(!value||value.length>150||key==='line'&&!/^[1-9]\d{0,5}$/.test(value))throw unclear();
      rows.push({key,value});
    }
  }
  if(!validThrough||!reason||!rows.length||rows.length>100)throw unclear();
  return {order,validThrough,reason,rows};
}

module.exports={subject,validDate,parse};
