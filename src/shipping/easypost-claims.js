'use strict';

const {ValidationError}=require('../domain/errors');
const currency=require('../domain/currency');
const easypost=require('./providers/easypost');

const statuses=new Set(['submitted','in_review','approved','rejected','approved_partial','cancelled','needs_action']);
const types=new Set(['loss','damage']);
const insuranceId=/^ins_[a-z0-9]{1,80}$/i;
const claimId=/^clm_[a-z0-9]{1,80}$/i;
const claimReference=/^stockchief-[a-z0-9_]{1,80}$/i;

function account(ctx){
  if(!ctx?.easypostApiKey)throw new ValidationError('Connect the shipping account that insured this parcel.');
  return /^EZTK/i.test(ctx.easypostApiKey)?'test':'production';
}

function availableMinor(amount){
  const parts=/^(\d{1,13})(?:\.(\d{1,8}))?$/.exec(String(amount));
  if(!parts)throw new ValidationError('The carrier did not return a valid insurance amount.');
  return currency.toMinor(parts[1]+'.'+(parts[2]||'').slice(0,2).padEnd(2,'0'),'USD');
}

async function coverage(ctx,parcel,request=easypost.call){
  const mode=account(ctx);
  if(!insuranceId.test(parcel.insuranceId))throw new ValidationError('Enter the EasyPost insurance number for this parcel.');
  const insurance=await request(ctx,'/insurances/'+parcel.insuranceId);
  if(insurance?.id!==parcel.insuranceId||insurance.object!=='Insurance'||insurance.mode!==mode||
    insurance.status!=='purchased'||insurance.tracking_code!==parcel.trackingNumber||insurance.shipment_id!==parcel.externalId){
    throw new ValidationError('The shipping account did not confirm active insurance for this exact parcel.');
  }
  return {insuranceId:insurance.id,trackingNumber:parcel.trackingNumber,externalId:parcel.externalId,
    mode,limitMinor:availableMinor(insurance.amount)};
}

function receipt(value,claim,mode){
  const requested=currency.toMinor(value?.requested_amount,'USD',{label:'Carrier claim amount'});
  if(!claimId.test(value.id)||value.object!=='Claim'||value.mode!==mode||value.reference!==claim.reference||
    value.insurance_id!==claim.insuranceId||value.shipment_id!==claim.externalId||value.tracking_code!==claim.trackingNumber||
    value.type!==claim.type||requested!==claim.amountMinor||!statuses.has(value.status)){
    throw new ValidationError('The shipping account did not confirm the exact claim. Check its saved reference before taking any further action.');
  }
  // What the carrier agreed to pay, when it has decided.
  let approvedMinor=null;
  if(['approved','approved_partial'].includes(value.status)&&value.approved_amount!=null){
    try{approvedMinor=currency.toMinor(String(value.approved_amount),'USD',{label:'Approved claim amount'});}catch{approvedMinor=null;}
  }
  return {id:value.id,reference:claim.reference,status:value.status,amountMinor:requested,approvedMinor,
    detail:typeof value.status_detail==='string'?value.status_detail.slice(0,500):null};
}

async function submit(ctx,claim,request=easypost.call){
  const mode=account(ctx);
  if(!claimReference.test(claim.reference)||!types.has(claim.type)||!Number.isSafeInteger(claim.amountMinor)||claim.amountMinor<=0||
    !claim.invoice?.length||!claim.emailEvidence?.length||claim.type==='damage'&&!claim.supporting?.length){
    throw new ValidationError('Complete the claim facts and required evidence before filing.');
  }
  const body={type:claim.type,reference:claim.reference,tracking_code:claim.trackingNumber,
    amount:currency.fromMinor(claim.amountMinor,'USD'),description:claim.description,recipient_name:claim.recipient,
    contact_email:claim.contactEmail,invoice_attachments:[claim.invoice.toString('base64')],
    email_evidence_attachments:[claim.emailEvidence.toString('base64')],
    ...(claim.supporting?.length?{supporting_documentation_attachments:[claim.supporting.toString('base64')]}:{})};
  const saved=await request(ctx,'/claims',{method:'POST',body,retries:0,timeoutMs:15000});
  try{return receipt(saved,claim,mode);}
  catch(error){error.providerOutcomeUncertain=true;throw error;}
}

async function retrieve(ctx,claim,request=easypost.call){
  const mode=account(ctx);
  if(!claimReference.test(claim.reference))throw new ValidationError('This claim has no saved carrier reference.');
  return receipt(await request(ctx,'/claims/'+claim.reference),claim,mode);
}

// The active insurance bought with this exact label, found without asking a
// person for its number. Null when the parcel carries no EasyPost insurance.
async function findCoverage(ctx,parcel,request=easypost.call){
  const mode=account(ctx);
  const listed=await request(ctx,'/insurances?page_size=100');
  const match=(listed?.insurances||[]).find(row=>row?.shipment_id===parcel.externalId&&row.tracking_code===parcel.trackingNumber
    &&row.status==='purchased'&&row.mode===mode&&insuranceId.test(row.id||''));
  return match?coverage(ctx,{...parcel,insuranceId:match.id},request):null;
}

module.exports={coverage,findCoverage,submit,retrieve};
