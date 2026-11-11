'use strict';

const {ValidationError}=require('../domain/errors');
const {prose}=require('../connections/reply-triage');
const {validDate}=require('./supplier-unavailability-mail-parser');
const subjectPattern=/^(?:re:\s*)*(?:purchase order(?: confirmation)?|po(?: confirmation)?|please confirm)\s*[:#-]?\s+([a-z0-9][a-z0-9._/-]{0,79})$/i;
const shipDateLine=/^(?:planned )?ship date\s*:\s*(.*)$/i;

function subject(value){return subjectPattern.exec(String(value||'').trim())?.[1]||null;}

function mayContainShipDate(title,body){
  return Boolean(subject(title)&&prose(body).split(/\r?\n/).some(line=>shipDateLine.test(line.trim())));
}

function parse(title,body){
  const order=subject(title),invalid=()=>new ValidationError('Review the original email. It must confirm this purchase and state one planned ship date as YYYY-MM-DD.');
  if(!order||typeof body!=='string'||body.length>30000)throw invalid();
  let accepted=false,shipDate=null;
  for(const raw of prose(body).split(/\r?\n/)){
    const line=raw.trim();
    if(!line||/^(?:hello|hi|thanks|thank you|regards|best regards)[,.!]?$/i.test(line))continue;
    if(/^(?:confirmed|order accepted|purchase order confirmed)[.!]?$/i.test(line)){
      if(accepted)throw invalid();
      accepted=true;
    }else{
      const date=shipDateLine.exec(line)?.[1]?.trim();
      if(shipDate||!validDate(date))throw invalid();
      shipDate=date;
    }
  }
  if(!accepted||!shipDate)throw invalid();
  return {order,shipDate};
}

module.exports={subject,mayContainShipDate,parse};
