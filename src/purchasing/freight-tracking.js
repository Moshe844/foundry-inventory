'use strict';

// Job 39: the seam between StockChief and the service that follows an ocean
// container or an air waybill.
//
// It has the same shape as the parcel carriers (src/shipping/provider.js): an
// outside service tells us about a shipment in its own words, and StockChief
// keeps only the few facts its records turn on. A provider implements:
//
//   track({mode, referenceType, reference, carrierCode, providerReference})
//     -> {providerReference, pending, status, eta, observedAt, events:[{at, status, location, detail}]}
//   isConfigured(env) -> whether this server holds the provider's account
//
// The statuses are StockChief's freight words, not any carrier's: booked,
// in_transit, arrived (at the destination port or airport), released (for
// onward delivery) and exception. `eta` is the expected arrival at that port or
// airport as a calendar date. A provider still waiting for its first answer
// returns `pending: true` and nothing else is read.
//
// Live providers refuse to run under NODE_ENV=test, so a test can never reach
// a real tracking account; tests hand the worker a fake with the same method.

const {ValidationError}=require('../domain/errors');

const STATUSES=['booked','in_transit','arrived','released','exception'];
const providers=new Map();

function register(name,provider){
  const key=String(name||'').toLowerCase();
  if(!key)throw new TypeError('A freight tracking provider needs a name.');
  if(typeof provider?.track!=='function')throw new TypeError(`Freight tracking provider "${key}" is missing: track.`);
  providers.set(key,provider);
  return ()=>providers.delete(key);
}
function get(name){
  const found=providers.get(String(name||'').toLowerCase());
  if(!found)throw new ValidationError(`No freight tracking service called "${name}" is set up on this server.`);
  return found;
}
// The provider this server is set up for, or null. Null is normal: without a
// tracking account, arrival updates come from the forwarder's private link.
function configured(env=process.env){
  const preferred=String(env.FREIGHT_TRACKING_PROVIDER||'').toLowerCase();
  if(preferred&&providers.get(preferred)?.isConfigured?.(env))return preferred;
  for(const [name,provider] of providers)if(provider.isConfigured?.(env))return name;
  return null;
}

const day=value=>{
  const text=String(value||'').slice(0,10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text)||new Date(text+'T00:00:00Z').toISOString().slice(0,10)!==text)return null;
  return text;
};

// Checks a provider's answer before anything is saved. Anything unexpected
// stops the reading; the saved arrival date is unchanged.
function read(answer){
  if(!answer||typeof answer!=='object')throw new ValidationError('The tracking service returned an unreadable answer. The saved arrival date is unchanged.');
  const providerReference=answer.providerReference==null?null:String(answer.providerReference).slice(0,200);
  if(answer.pending)return {pending:true,providerReference};
  if(!STATUSES.includes(answer.status))throw new ValidationError('The tracking service returned a status StockChief does not recognize. The saved arrival date is unchanged.');
  const eta=answer.eta==null?null:day(answer.eta);
  if(answer.eta!=null&&!eta)throw new ValidationError('The tracking service returned an arrival date that is not a calendar date. The saved arrival date is unchanged.');
  const observed=new Date(answer.observedAt||Date.now());
  if(!Number.isFinite(observed.getTime()))throw new ValidationError('The tracking service returned an unreadable time.');
  const events=(Array.isArray(answer.events)?answer.events:[]).slice(0,50).map(e=>({at:String(e?.at||'').slice(0,40),
    status:STATUSES.includes(e?.status)?e.status:null,location:String(e?.location||'').slice(0,150),detail:String(e?.detail||'').slice(0,300)}));
  return {pending:false,providerReference,status:answer.status,eta,observedAt:observed.toISOString(),events};
}

module.exports={STATUSES,register,get,configured,read};

register('terminal49',require('./freight-tracking-terminal49'));
