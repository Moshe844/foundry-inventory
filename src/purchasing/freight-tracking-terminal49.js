'use strict';

// Job 39: ocean container tracking through Terminal49, StockChief's own
// account (TERMINAL49_API_KEY on the server), the way text messages use the
// server's Twilio account. Written from Terminal49's public v2 API and not yet
// run against a live account: the live check is still open.
//
// The first call files a tracking request for the bill of lading, booking or
// container number with the shipping line's SCAC code. Terminal49 answers
// with a request that turns into a tracked shipment once the line confirms it;
// until then StockChief records nothing. After that each call reads the
// shipment's arrival at the destination port and its containers.
// Air waybills are not covered; their updates come from the forwarder link.

const {ValidationError}=require('../domain/errors');
const base='https://api.terminal49.com/v2/';
const types={bill:'bill_of_lading',booking:'booking_number',container:'container'};

function isConfigured(env=process.env){return Boolean(env.TERMINAL49_API_KEY);}

async function call(path,{method='GET',body,fetchImpl=fetch,env=process.env}={}){
  if(process.env.NODE_ENV==='test')throw Object.assign(new ValidationError('Live freight tracking is off in tests.'),{code:'live_tracking_disabled'});
  if(!isConfigured(env))throw new ValidationError('Freight tracking is not set up on this server.');
  let response;
  try{response=await fetchImpl(base+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:'Token '+env.TERMINAL49_API_KEY,Accept:'application/vnd.api+json',...(body?{'Content-Type':'application/vnd.api+json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw Object.assign(new ValidationError('The tracking service did not answer. The saved arrival date is unchanged.'),{retryable:true});}
  if(!response.ok)throw Object.assign(new ValidationError('The tracking service returned HTTP '+response.status+'. The saved arrival date is unchanged.'),{retryable:response.status===429||response.status>=500});
  try{return await response.json();}catch{throw new ValidationError('The tracking service returned an unreadable answer.');}
}

const stamp=value=>value==null?null:String(value);
function status(shipment,containers){
  if(containers.length&&containers.every(c=>c?.attributes?.pod_full_out_at))return 'released';
  if(shipment.pod_ata_at||containers.some(c=>c?.attributes?.pod_arrived_at))return 'arrived';
  if(shipment.pol_atd_at)return 'in_transit';
  return 'booked';
}

async function track({mode,referenceType,reference,carrierCode,providerReference},options={}){
  if(mode!=='ocean'||!types[referenceType])throw new ValidationError('Carrier tracking covers ocean bills of lading, bookings and containers. Use the forwarder link for air waybills.');
  let ref=providerReference;
  if(!ref){
    if(!carrierCode)throw new ValidationError('Record the shipping line’s SCAC code before following carrier tracking.');
    const made=await call('tracking_requests',{...options,method:'POST',body:{data:{type:'tracking_request',
      attributes:{request_type:types[referenceType],request_number:reference,scac:carrierCode}}}});
    if(!made?.data?.id)throw new ValidationError('The tracking service did not confirm the tracking request.');
    ref='request:'+made.data.id;
  }
  if(ref.startsWith('request:')){
    const request=await call('tracking_requests/'+encodeURIComponent(ref.slice(8)),options);
    const state=request?.data?.attributes?.status;
    if(state==='failed')throw new ValidationError('The tracking service could not find this shipment: '+String(request.data.attributes.failed_reason||'no reason given').slice(0,200));
    const tracked=request?.data?.relationships?.tracked_object?.data;
    if(state!=='created'||!tracked?.id)return {pending:true,providerReference:ref};
    ref='shipment:'+tracked.id;
  }
  if(!ref.startsWith('shipment:'))throw new ValidationError('The saved tracking reference is not recognized. Turn carrier tracking off and on again.');
  const found=await call('shipments/'+encodeURIComponent(ref.slice(9))+'?include=containers',options);
  const shipment=found?.data?.attributes;
  if(!shipment)throw new ValidationError('The tracking service returned no shipment.');
  const containers=(found.included||[]).filter(i=>i?.type==='container');
  const arrival=stamp(shipment.pod_ata_at||shipment.pod_eta_at);
  return {providerReference:ref,status:status(shipment,containers),eta:arrival?arrival.slice(0,10):null,observedAt:new Date().toISOString(),
    events:[shipment.pol_atd_at&&{at:stamp(shipment.pol_atd_at),status:'in_transit',location:String(shipment.port_of_lading_name||''),detail:'Left the port of loading'},
      shipment.pod_ata_at&&{at:stamp(shipment.pod_ata_at),status:'arrived',location:String(shipment.port_of_discharge_name||''),detail:'Arrived at the destination port'}].filter(Boolean)};
}

module.exports={isConfigured,track};
